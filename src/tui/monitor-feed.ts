import { getRunSnapshot } from "../core.js";
import { RunMonitorSource } from "./run-source.js";
import type { AgenticRun, Run, RunEvent } from "../types.js";

export interface MonitorPoll {
  run: Run | AgenticRun;
  newEvents: RunEvent[];
}

/**
 * Source-agnostic feed for the monitor screen. Both the file-backed (history /
 * attach) and live (in-process run) feeds expose the same shape so the monitor
 * screen never branches on where the data comes from.
 */
export interface MonitorFeed {
  load(): Promise<Run | AgenticRun>;
  poll(): Promise<MonitorPoll>;
  start(onChange: () => void): void;
  stop(): void;
}

/** File feed: tails `events.jsonl` and reloads `run.json` (linear or agentic). */
export class FileMonitorFeed implements MonitorFeed {
  private readonly source: RunMonitorSource;

  constructor(options: { runId: string; projectRoot?: string; pollIntervalMs?: number }) {
    this.source = new RunMonitorSource(options);
  }

  async load(): Promise<Run | AgenticRun> {
    return this.source.readAnyRunSnapshot();
  }

  async poll(): Promise<MonitorPoll> {
    const run = await this.source.readAnyRunSnapshot();
    const newEvents = await this.source.readNewEvents();
    return { run, newEvents };
  }

  start(onChange: () => void): void {
    this.source.start(onChange);
  }

  stop(): void {
    this.source.stop();
  }
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "escalated"]);

export interface LiveMonitorFeedOptions {
  projectRoot: string;
  /** Optional run id if already known; otherwise learned from the first event. */
  runId?: string;
  /** Periodic authoritative snapshot interval. Guards against missed events. */
  snapshotIntervalMs?: number;
}

const DEFAULT_SNAPSHOT_INTERVAL_MS = 1000;

/**
 * Live feed for a run started in-process. The caller wires `observer` into
 * `startWorkflowRun({ eventObservers: [feed.observer] })`; each event is
 * buffered and drained on `poll()`. The run id is learned from the first event
 * (the run is created inside `startWorkflowRun`). Authoritative state comes from
 * the resolved run promise (`setRun`) and a periodic `getRunSnapshot`.
 */
export class LiveMonitorFeed implements MonitorFeed {
  private runId: string | null;
  private readonly projectRoot: string;
  private readonly snapshotIntervalMs: number;
  private buffer: RunEvent[] = [];
  private run: Run | AgenticRun | null = null;
  private terminal = false;
  private onChange: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: LiveMonitorFeedOptions) {
    this.runId = options.runId ?? null;
    this.projectRoot = options.projectRoot;
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  }

  /** Pass this into `eventObservers`. Buffers events and triggers a repaint. */
  readonly observer = (event: RunEvent): void => {
    if (!this.runId && event.run_id) this.runId = event.run_id;
    this.buffer.push(event);
    if (this.onChange) this.onChange();
  };

  /** Provide the authoritative run object (initial or resolved/snapshotted). */
  setRun(run: Run | AgenticRun): void {
    this.runId = run.run_id;
    this.run = run;
    if (TERMINAL_STATUSES.has(run.status)) this.terminal = true;
    if (this.onChange) this.onChange();
  }

  /** Mark the run terminal even if the snapshot has not caught up (e.g. error). */
  markTerminal(): void {
    this.terminal = true;
    if (this.onChange) this.onChange();
  }

  async load(): Promise<Run | AgenticRun> {
    if (this.run) return this.run;
    if (!this.runId) throw new Error("Run not started yet");
    const run = await getRunSnapshot(this.runId, this.projectRoot);
    this.run = run;
    return run;
  }

  async poll(): Promise<MonitorPoll> {
    const newEvents = this.buffer;
    this.buffer = [];
    let run = this.run;
    if (this.runId && (!run || !this.terminal)) {
      try {
        run = await getRunSnapshot(this.runId, this.projectRoot);
        this.run = run;
        if (TERMINAL_STATUSES.has(run.status)) this.terminal = true;
      } catch {
        // run.json may not exist yet for a just-started run; keep prior state.
      }
    }
    if (!run) throw new Error("Run not available yet");
    return { run, newEvents };
  }

  start(onChange: () => void): void {
    this.onChange = onChange;
    this.timer = setInterval(() => {
      if (this.terminal) return;
      onChange();
    }, this.snapshotIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    this.onChange = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
