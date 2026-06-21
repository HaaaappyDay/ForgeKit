import readline, { type Key } from "node:readline";
import { getRunArtifacts, readRunArtifact } from "../core.js";
import { RunMonitorSource } from "./run-source.js";
import { buildMonitorViewModel } from "./view-model.js";
import { renderFrame, ANSI } from "./render.js";
import { initialUiState, reduceKey, type KeyName, type ReaderArtifact, type ReaderState, type UiState } from "./input.js";
import type { MonitorViewModel } from "./view-model.js";
import type { Run, RunArtifact, RunEvent } from "../types.js";

const READER_ARTIFACT_ORDER = ["markdown", "handoff", "validation", "prompt", "stdout", "stderr"];
const TAIL_LINE_TYPES = new Set(["stdout", "stderr"]);
const TAIL_LINES = 200;

interface RunMonitorAppOptions {
  runId: string;
  projectRoot: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

function tailLines(content: string, count: number): string {
  const lines = content.split(/\r?\n/);
  if (lines.length <= count) return content;
  return [`... (showing last ${count} lines) ...`, ...lines.slice(-count)].join("\n");
}

function buildStepArtifacts(artifacts: RunArtifact[], step: MonitorViewModel["steps"][number]): ReaderArtifact[] {
  const forStep = artifacts.filter(
    (artifact) =>
      artifact.exists &&
      artifact.step_id === step.stepId &&
      (step.activeAttempt ? artifact.attempt_id === step.activeAttempt : true) &&
      READER_ARTIFACT_ORDER.includes(artifact.type)
  );
  forStep.sort((a, b) => READER_ARTIFACT_ORDER.indexOf(a.type) - READER_ARTIFACT_ORDER.indexOf(b.type));
  return forStep.map((artifact) => ({ ref: artifact.ref, type: artifact.type }));
}

function mapKey(str: string | undefined, key: Key): KeyName {
  if (key.ctrl && key.name === "c") return "quit";
  switch (key.name) {
    case "q":
      return "quit";
    case "up":
      return "up";
    case "down":
      return "down";
    case "left":
      return "left";
    case "right":
      return "right";
    case "return":
    case "enter":
      return "enter";
    case "escape":
      return "escape";
    case "g":
      return key.shift ? "bottom" : "top";
    default:
      return "other";
  }
}

/**
 * Interactive read-only monitor loop. Owns terminal lifecycle and wires the
 * file source, pure view-model, render, and key reducer together. All run and
 * artifact reads go through the core API; nothing here mutates run state.
 */
export class RunMonitorApp {
  private readonly source: RunMonitorSource;
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly projectRoot: string;
  private readonly runId: string;

  private ui: UiState = initialUiState();
  private run: Run | null = null;
  private events: RunEvent[] = [];
  private artifacts: RunArtifact[] = [];
  private repaintScheduled = false;
  private stopped = false;
  private onKeypress?: (str: string | undefined, key: Key) => void;
  private resolveExit?: () => void;

  constructor(options: RunMonitorAppOptions) {
    this.runId = options.runId;
    this.projectRoot = options.projectRoot;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.source = new RunMonitorSource({ runId: this.runId, projectRoot: this.projectRoot });
  }

  private dims(): { rows: number; cols: number } {
    return { rows: this.output.rows ?? 24, cols: this.output.columns ?? 80 };
  }

  private model(): MonitorViewModel {
    if (!this.run) throw new Error("Run not loaded");
    return buildMonitorViewModel(this.run, this.events);
  }

  private repaint(): void {
    if (!this.run || this.stopped) return;
    this.output.write(renderFrame(this.model(), this.ui, this.dims()));
  }

  private scheduleRepaint(): void {
    if (this.repaintScheduled) return;
    this.repaintScheduled = true;
    setTimeout(() => {
      this.repaintScheduled = false;
      this.repaint();
    }, 50);
  }

  private async refresh(): Promise<void> {
    try {
      this.run = await this.source.readRun();
      const newEvents = await this.source.readNewEvents();
      if (newEvents.length > 0) this.events.push(...newEvents);
      this.scheduleRepaint();
    } catch {
      // Transient read errors (e.g. concurrent write) are ignored; the next
      // poll will retry. A fatal error surfaces on the next user action.
    }
  }

  private async openArtifacts(stepIndex: number): Promise<void> {
    const model = this.model();
    const step = model.steps[stepIndex];
    if (!step) return;
    this.artifacts = await getRunArtifacts(this.runId, this.projectRoot);
    const readerArtifacts = buildStepArtifacts(this.artifacts, step);
    if (readerArtifacts.length === 0) return;
    const reader: ReaderState = {
      stepIndex,
      artifacts: readerArtifacts,
      activeArtifact: 0,
      lines: [],
      scrollTop: 0
    };
    this.ui = { ...this.ui, view: "reader", reader };
    await this.loadReaderContent();
    this.repaint();
  }

  private async loadReaderContent(): Promise<void> {
    const reader = this.ui.reader;
    if (!reader) return;
    const artifact = reader.artifacts[reader.activeArtifact];
    if (!artifact) return;
    let lines: string[];
    try {
      const content = await readRunArtifact(this.runId, artifact.ref, this.projectRoot);
      const text = TAIL_LINE_TYPES.has(artifact.type) ? tailLines(content.content, TAIL_LINES) : content.content;
      lines = text.split(/\r?\n/);
    } catch (error) {
      lines = [`Failed to read artifact: ${error instanceof Error ? error.message : String(error)}`];
    }
    this.ui = { ...this.ui, reader: { ...reader, lines, scrollTop: 0 } };
  }

  private async switchArtifact(delta: number): Promise<void> {
    const reader = this.ui.reader;
    if (!reader) return;
    const count = reader.artifacts.length;
    if (count === 0) return;
    const next = (reader.activeArtifact + delta + count) % count;
    this.ui = { ...this.ui, reader: { ...reader, activeArtifact: next } };
    await this.loadReaderContent();
    this.repaint();
  }

  private async handleKey(name: KeyName): Promise<void> {
    const stepCount = this.run ? this.run.steps.length : 0;
    const dims = this.dims();
    const { ui, effect } = reduceKey(this.ui, name, { stepCount, viewportRows: Math.max(1, dims.rows - 6) });
    this.ui = ui;

    switch (effect.kind) {
      case "quit":
        this.stop();
        return;
      case "open-artifacts":
        await this.openArtifacts(effect.stepIndex);
        return;
      case "switch-artifact":
        await this.switchArtifact(effect.delta);
        return;
      default:
        this.repaint();
    }
  }

  async mount(): Promise<void> {
    this.run = await this.source.readRun();
    this.events = await this.source.readNewEvents();

    this.output.write(ANSI.enterAltScreen + ANSI.hideCursor);
    if (this.input.isTTY) this.input.setRawMode(true);
    readline.emitKeypressEvents(this.input);
    this.input.resume();

    this.onKeypress = (str: string | undefined, key: Key) => {
      void this.handleKey(mapKey(str, key));
    };
    this.input.on("keypress", this.onKeypress);

    this.source.start(() => this.refresh());
    this.repaint();

    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.source.stop();
    if (this.onKeypress) this.input.off("keypress", this.onKeypress);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    this.output.write(ANSI.showCursor + ANSI.leaveAltScreen);
    if (this.resolveExit) this.resolveExit();
  }
}
