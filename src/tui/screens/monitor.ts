import { getRunArtifacts, readRunArtifact } from "../../core.js";
import { isAgenticRun } from "../../run-store.js";
import { buildMonitorViewModel } from "../view-model.js";
import { buildAgenticMonitorViewModel } from "../view-model-agentic.js";
import {
  renderAgenticMonitor,
  renderMonitor,
  renderReader,
  truncate,
  withFooter,
  type TerminalDimensions
} from "../render.js";
import {
  initialUiState,
  reduceKey,
  type ReaderArtifact,
  type UiState
} from "../input.js";
import type { MonitorFeed } from "../monitor-feed.js";
import type { ScreenContext, KeyInput, Screen } from "../screen.js";
import type { MonitorViewModel } from "../view-model.js";
import type { AgenticRun, Run, RunArtifact, RunEvent } from "../../types.js";

const READER_ARTIFACT_ORDER = ["markdown", "handoff", "validation", "prompt", "stdout", "stderr"];
const TAIL_LINE_TYPES = new Set(["stdout", "stderr"]);
const TAIL_LINES = 200;

type MonitorSourceMode = "attached" | "live";

interface MonitorScreenOptions {
  source?: MonitorSourceMode;
}

function tailLines(content: string, count: number): string {
  const lines = content.split(/\r?\n/);
  if (lines.length <= count) return content;
  return [`... (showing last ${count} lines) ...`, ...lines.slice(-count)].join("\n");
}

function orderArtifacts(artifacts: RunArtifact[]): ReaderArtifact[] {
  const usable = artifacts.filter(
    (artifact) => artifact.exists && READER_ARTIFACT_ORDER.includes(artifact.type)
  );
  usable.sort((a, b) => READER_ARTIFACT_ORDER.indexOf(a.type) - READER_ARTIFACT_ORDER.indexOf(b.type));
  return usable.map((artifact) => ({ ref: artifact.ref, type: artifact.type }));
}

function linearStepArtifacts(
  artifacts: RunArtifact[],
  step: MonitorViewModel["steps"][number]
): ReaderArtifact[] {
  return orderArtifacts(
    artifacts.filter(
      (artifact) =>
        artifact.step_id === step.stepId &&
        (step.activeAttempt ? artifact.attempt_id === step.activeAttempt : true)
    )
  );
}

function agenticNodeArtifacts(artifacts: RunArtifact[], nodeId: string): ReaderArtifact[] {
  return orderArtifacts(artifacts.filter((artifact) => artifact.node_id === nodeId));
}

/**
 * Run-type-agnostic, feed-agnostic monitor screen. Renders linear runs via the
 * v1 view-model and agentic runs via the agentic node-list view-model. All run
 * and artifact reads go through the core API and the supplied feed.
 */
export class MonitorScreen implements Screen {
  readonly title = "Monitor";
  private readonly ctx: ScreenContext;
  private readonly feed: MonitorFeed;
  private readonly source: MonitorSourceMode;

  private ui: UiState = initialUiState();
  private run: Run | AgenticRun | null = null;
  private events: RunEvent[] = [];
  private error = "";
  private message = "";
  private externalTerminal = false;
  private started = false;

  constructor(ctx: ScreenContext, feed: MonitorFeed, options: MonitorScreenOptions = {}) {
    this.ctx = ctx;
    this.feed = feed;
    this.source = options.source ?? "attached";
  }

  private get runId(): string {
    return this.run?.run_id ?? "";
  }

  private isAgentic(): boolean {
    return this.run !== null && isAgenticRun(this.run);
  }

  private nodeCount(): number {
    if (!this.run) return 0;
    return isAgenticRun(this.run) ? this.run.nodes.length : this.run.steps.length;
  }

  private isLiveRunActive(): boolean {
    if (this.source !== "live" || this.externalTerminal) return false;
    if (!this.run) return true;
    return this.run.status === "pending" || this.run.status === "running";
  }

  private modeLine(): string {
    if (this.source === "attached") {
      return "mode: attached read-only; quitting closes viewer only";
    }
    if (this.isLiveRunActive()) {
      return "mode: live in-process; quitting TUI stops this run";
    }
    return "mode: live in-process; run has ended";
  }

  private footer(): string {
    if (this.source === "live" && this.isLiveRunActive()) {
      return "[up/down select  Enter artifacts  Esc home  q quit TUI]";
    }
    return "[up/down select  Enter artifacts  Esc back  q quit]";
  }

  private readerFooter(): string {
    if (this.source === "live" && this.isLiveRunActive()) {
      return "[up/down scroll  left/right artifact  g/G top/bottom  wrapped  Esc back  q quit TUI]";
    }
    return "[up/down scroll  left/right artifact  g/G top/bottom  wrapped  Esc back]";
  }

  async onEnter(): Promise<void> {
    try {
      this.run = await this.feed.load();
      const { newEvents } = await this.feed.poll();
      if (newEvents.length > 0) this.events.push(...newEvents);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.feed.start(() => {
      void this.refresh();
    });
    this.started = true;
    this.ctx.shell.requestRepaint();
  }

  onExit(): void {
    if (this.started) this.feed.stop();
  }

  /** Surface an external error (e.g. a failure while starting a live run). */
  setExternalError(message: string): void {
    this.externalTerminal = true;
    this.error = message;
    this.ctx.shell.requestRepaint();
  }

  private async refresh(): Promise<void> {
    try {
      const { run, newEvents } = await this.feed.poll();
      this.run = run;
      if (newEvents.length > 0) this.events.push(...newEvents);
      this.error = "";
      this.ctx.shell.requestRepaint();
    } catch {
      // Transient read errors are ignored; the next poll retries.
    }
  }

  render(dims: TerminalDimensions): string[] {
    if (!this.run) {
      const body = [this.error ? `Failed to load run: ${this.error}` : "Loading run\u2026", "", this.modeLine()];
      if (this.message) body.push(truncate(this.message, dims.cols));
      return withFooter(body, "[Esc back]", dims);
    }

    if (this.ui.view === "reader" && this.ui.reader) {
      const body = renderReader(this.ui.reader, dims);
      body.push("");
      body.push(truncate(this.modeLine(), dims.cols));
      if (this.message) body.push(truncate(this.message, dims.cols));
      return withFooter(body, this.readerFooter(), dims);
    }

    let body: string[];
    if (isAgenticRun(this.run)) {
      body = renderAgenticMonitor(buildAgenticMonitorViewModel(this.run, this.events), this.ui, dims);
    } else {
      body = renderMonitor(buildMonitorViewModel(this.run, this.events), this.ui, dims);
    }
    body.push("");
    body.push(truncate(this.modeLine(), dims.cols));
    if (this.error) body.push(truncate(`error: ${this.error}`, dims.cols));
    if (this.message) body.push(truncate(this.message, dims.cols));
    return withFooter(body, this.footer(), dims);
  }

  private async openArtifacts(index: number): Promise<void> {
    if (!this.run) return;
    const artifacts = await getRunArtifacts(this.runId, this.ctx.projectRoot);
    let readerArtifacts: ReaderArtifact[];
    let selectedLabel: string;
    if (isAgenticRun(this.run)) {
      const node = this.run.nodes[index];
      if (!node) {
        this.message = "No node selected.";
        this.ctx.shell.requestRepaint();
        return;
      }
      selectedLabel = `node ${node.node_id}`;
      readerArtifacts = agenticNodeArtifacts(artifacts, node.node_id);
    } else {
      const model = buildMonitorViewModel(this.run, this.events);
      const step = model.steps[index];
      if (!step) {
        this.message = "No step selected.";
        this.ctx.shell.requestRepaint();
        return;
      }
      selectedLabel = `step ${step.stepId}`;
      readerArtifacts = linearStepArtifacts(artifacts, step);
    }
    if (readerArtifacts.length === 0) {
      this.message = `No artifacts for ${selectedLabel} yet.`;
      this.ctx.shell.requestRepaint();
      return;
    }
    this.message = "";
    this.ui = {
      ...this.ui,
      view: "reader",
      reader: { stepIndex: index, artifacts: readerArtifacts, activeArtifact: 0, lines: [], scrollTop: 0 }
    };
    await this.loadReaderContent();
    this.ctx.shell.requestRepaint();
  }

  private async loadReaderContent(): Promise<void> {
    const reader = this.ui.reader;
    if (!reader) return;
    const artifact = reader.artifacts[reader.activeArtifact];
    if (!artifact) return;
    let lines: string[];
    try {
      const content = await readRunArtifact(this.runId, artifact.ref, this.ctx.projectRoot);
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
    this.ctx.shell.requestRepaint();
  }

  async handleKey(key: KeyInput): Promise<void> {
    // 'q' quits the whole TUI (back-compat with the v1 direct-attach monitor).
    if (key.name === "char" && key.char === "q") {
      await this.ctx.shell.requestQuit();
      return;
    }
    if (key.name === "up" || key.name === "down") this.message = "";
    // Esc in monitor view pops the screen; in reader view it returns to monitor.
    if (key.name === "escape" && this.ui.view === "monitor") {
      this.ctx.shell.pop();
      return;
    }

    // 'g'/'G' scroll to top/bottom in the artifact reader; the shell delivers
    // them as plain chars so text fields elsewhere can receive them.
    let name = key.name;
    if (key.name === "char" && key.char === "g") name = "top";
    else if (key.name === "char" && key.char === "G") name = "bottom";

    const dims = this.ctx.dims();
    const { ui, effect } = reduceKey(this.ui, name, {
      stepCount: this.nodeCount(),
      viewportRows: Math.max(1, dims.rows - 6)
    });
    this.ui = ui;

    switch (effect.kind) {
      case "open-artifacts":
        await this.openArtifacts(effect.stepIndex);
        return;
      case "switch-artifact":
        await this.switchArtifact(effect.delta);
        return;
      default:
        this.ctx.shell.requestRepaint();
    }
  }
}
