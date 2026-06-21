import { open, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { getRunSnapshot } from "../core.js";
import { isAgenticRun, runJsonPath } from "../run-store.js";
import { runEventsPath } from "../run-events.js";
import { isNodeErrorCode } from "../node-error.js";
import type { Run, RunEvent } from "../types.js";

export interface RunMonitorSourceOptions {
  runId: string;
  projectRoot?: string;
  /** Poll fallback interval in ms. Guards against missed fs.watch events. */
  pollIntervalMs?: number;
}

export type RunMonitorChangeListener = () => void | Promise<void>;

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * File-based, read-only data source for the TUI monitor. Reads `run.json` for
 * authoritative state and tails `events.jsonl` for liveness. Tailing tracks a
 * byte offset and carries any trailing partial line so only complete, newly
 * appended event lines are parsed.
 */
export class RunMonitorSource {
  readonly runId: string;
  private readonly projectRoot: string;
  private readonly pollIntervalMs: number;
  private consumed = 0;
  private partial = "";
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RunMonitorSourceOptions) {
    this.runId = options.runId;
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Reads the current linear run snapshot. Throws if the run is agentic. */
  async readRun(): Promise<Run> {
    const run = await getRunSnapshot(this.runId, this.projectRoot);
    if (isAgenticRun(run)) {
      throw new Error(`Run ${this.runId} is an agentic run; the v1 monitor only supports linear runs.`);
    }
    return run;
  }

  /**
   * Reads event lines appended since the last call. On first call it reads the
   * whole file. If the file shrank (rotated/truncated) the offset resets.
   */
  async readNewEvents(): Promise<RunEvent[]> {
    const path = runEventsPath(this.projectRoot, this.runId);
    let size: number;
    try {
      ({ size } = await stat(path));
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return [];
      throw error;
    }

    if (size < this.consumed) {
      this.consumed = 0;
      this.partial = "";
    }
    if (size === this.consumed) return [];

    const length = size - this.consumed;
    const buffer = Buffer.alloc(length);
    const handle = await open(path, "r");
    try {
      await handle.read(buffer, 0, length, this.consumed);
    } finally {
      await handle.close();
    }
    this.consumed = size;

    const text = this.partial + buffer.toString("utf8");
    const parts = text.split("\n");
    this.partial = parts.pop() ?? "";

    const events: RunEvent[] = [];
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as RunEvent);
      } catch {
        // Ignore partial/corrupt lines; the next read may complete them.
      }
    }
    return events;
  }

  /** Whether an `events.jsonl` live stream exists for this run. */
  async hasEventStream(): Promise<boolean> {
    try {
      await stat(runEventsPath(this.projectRoot, this.runId));
      return true;
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  /**
   * Starts watching for changes. Uses fs.watch on both `run.json` and
   * `events.jsonl` when present, plus a poll fallback. The listener is invoked
   * on every detected change; callers debounce/repaint as needed.
   */
  start(onChange: RunMonitorChangeListener): void {
    const trigger = () => {
      void onChange();
    };

    try {
      this.watcher = watch(runJsonPath(this.projectRoot, this.runId), trigger);
    } catch {
      this.watcher = null;
    }

    this.timer = setInterval(trigger, this.pollIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
