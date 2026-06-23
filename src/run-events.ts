import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNodeErrorCode } from "./node-error.js";
import { runRoot } from "./run-store.js";
import type { JsonObject, RunEvent, RunEventType } from "./types.js";

export type RunEventObserver = (event: RunEvent) => void | Promise<void>;

export interface RunEventSink {
  write(event: RunEvent): void | Promise<void>;
}

export interface EmitRunEventOptions {
  type: RunEventType;
  message: string;
  data?: JsonObject;
  step_id?: string;
  role_id?: string;
  adapter_id?: string;
  attempt_id?: string;
  node_id?: string;
}

export interface RunEventEmitterOptions {
  runId: string;
  observers?: RunEventObserver[];
  sinks?: RunEventSink[];
  startSequence?: number;
}

export interface CreateRunEventEmitterOptions {
  runId: string;
  projectRoot: string;
  observers?: RunEventObserver[];
  sinks?: RunEventSink[];
  writeJsonl?: boolean;
}

function isoNow(): string {
  return new Date().toISOString();
}

function formatEventId(sequence: number): string {
  return String(sequence).padStart(6, "0");
}

async function countExistingEvents(path: string): Promise<number> {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return 0;
    throw error;
  }
}

export function runEventsPath(projectRoot: string, runId: string): string {
  return join(runRoot(projectRoot, runId), "events.jsonl");
}

export class JsonlRunEventSink implements RunEventSink {
  constructor(private readonly path: string) {}

  async write(event: RunEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export class RunEventEmitter {
  private sequence: number;
  private readonly runId: string;
  private readonly observers: RunEventObserver[];
  private readonly sinks: RunEventSink[];

  constructor({ runId, observers = [], sinks = [], startSequence = 0 }: RunEventEmitterOptions) {
    this.runId = runId;
    this.observers = observers;
    this.sinks = sinks;
    this.sequence = startSequence;
  }

  async emit(options: EmitRunEventOptions): Promise<RunEvent> {
    this.sequence += 1;
    const event: RunEvent = {
      schema_version: "forgekit.run-event.v1",
      event_id: formatEventId(this.sequence),
      run_id: this.runId,
      timestamp: isoNow(),
      type: options.type,
      message: options.message,
      data: options.data ?? {}
    };

    if (options.step_id) event.step_id = options.step_id;
    if (options.role_id) event.role_id = options.role_id;
    if (options.adapter_id) event.adapter_id = options.adapter_id;
    if (options.attempt_id) event.attempt_id = options.attempt_id;
    if (options.node_id) event.node_id = options.node_id;

    for (const observer of this.observers) {
      await observer(event);
    }
    for (const sink of this.sinks) {
      await sink.write(event);
    }

    return event;
  }
}

export async function createRunEventEmitter({
  runId,
  projectRoot,
  observers = [],
  sinks = [],
  writeJsonl = false
}: CreateRunEventEmitterOptions): Promise<RunEventEmitter> {
  const allSinks = [...sinks];
  const path = runEventsPath(projectRoot, runId);
  let startSequence = 0;
  if (writeJsonl) {
    startSequence = await countExistingEvents(path);
    allSinks.push(new JsonlRunEventSink(path));
  }

  return new RunEventEmitter({
    runId,
    observers,
    sinks: allSinks,
    startSequence
  });
}
