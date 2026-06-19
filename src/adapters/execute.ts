import { resolveCommand } from "./probe.js";
import { collectAllowedEnv, runProcess } from "../process-runner.js";
import type {
  AdapterExecutionResult,
  AdapterRuntimeConfig,
  AdapterType,
  ResumeStrategy
} from "../types.js";

interface ExecuteAdapterOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  externalSessionId?: string | null;
  outputSchemaPath?: string;
  outputSchemaJson?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as unknown;
      if (isRecord(event)) {
        events.push(event);
      }
    } catch {
      // Raw logs are still kept; non-JSON lines simply do not contribute session ids.
    }
  }
  return events;
}

function codexArgs(sessionId: string | null | undefined, outputSchemaPath?: string): string[] {
  if (sessionId) {
    return [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--json",
      ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
      sessionId,
      "-"
    ];
  }
  return [
    "exec",
    "--skip-git-repo-check",
    "--json",
    ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
    "-s",
    "read-only",
    "-"
  ];
}

function claudeArgs(sessionId: string | null | undefined, prompt: string, outputSchemaJson?: string): string[] {
  const args = ["-p", "--verbose", "--output-format", "stream-json", "--tools", ""];
  if (outputSchemaJson) {
    args.push("--json-schema", outputSchemaJson);
  }
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push(prompt);
  return args;
}

function captureSessionId(adapterType: AdapterType, stdout: string): string | null {
  const events = parseJsonLines(stdout);

  if (adapterType === "codex") {
    const event = events.find((candidate) => (
      candidate.type === "thread.started" && typeof candidate.thread_id === "string"
    ));
    return typeof event?.thread_id === "string" ? event.thread_id : null;
  }

  if (adapterType === "claude-code") {
    const init = events.find((event) => (
      event.type === "system" && event.subtype === "init" && typeof event.session_id === "string"
    ));
    if (typeof init?.session_id === "string") return init.session_id;
    const result = events.find((event) => event.type === "result" && typeof event.session_id === "string");
    return typeof result?.session_id === "string" ? result.session_id : null;
  }

  return null;
}

export function resumeStrategyFor(adapterType: AdapterType): ResumeStrategy {
  if (adapterType === "codex") return "codex_exec_resume";
  if (adapterType === "claude-code") return "claude_resume";
  return "adapter_defined";
}

export async function executeAdapterStep(
  adapter: AdapterRuntimeConfig,
  prompt: string,
  options: ExecuteAdapterOptions
): Promise<AdapterExecutionResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = collectAllowedEnv(adapter, options.env ?? process.env);
  const commandResolution = await resolveCommand(adapter.command, cwd, env);
  if (!commandResolution.found) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      error: `Command not found or not executable: ${adapter.command}`,
      externalSessionId: null
    };
  }

  const resolvedCommand = commandResolution.resolved;
  if (!resolvedCommand) {
    throw new Error(`Command resolution succeeded without a resolved path: ${adapter.command}`);
  }

  const adapterArgs = adapter.type === "claude-code"
    ? claudeArgs(options.externalSessionId, prompt, options.outputSchemaJson)
    : codexArgs(options.externalSessionId, options.outputSchemaPath);
  const args = [...(adapter.args ?? []), ...adapterArgs];
  const result = await runProcess(resolvedCommand, args, {
    cwd,
    env,
    timeoutMs: (adapter.timeout_seconds ?? 600) * 1000,
    input: adapter.type === "claude-code" ? undefined : prompt
  });

  const externalSessionId = captureSessionId(adapter.type, result.stdout) ?? options.externalSessionId ?? null;

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    error: result.error,
    externalSessionId
  };
}
