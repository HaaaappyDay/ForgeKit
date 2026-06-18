import { resolveCommand } from "./probe.js";
import { collectAllowedEnv, runProcess } from "../process-runner.js";

function parseJsonLines(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Raw logs are still kept; non-JSON lines simply do not contribute session ids.
    }
  }
  return events;
}

function codexArgs(sessionId, outputSchemaPath) {
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

function claudeArgs(sessionId, prompt, outputSchemaJson) {
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

function captureSessionId(adapterType, stdout) {
  const events = parseJsonLines(stdout);

  if (adapterType === "codex") {
    return events.find((event) => event.type === "thread.started" && event.thread_id)?.thread_id ?? null;
  }

  if (adapterType === "claude-code") {
    const init = events.find((event) => event.type === "system" && event.subtype === "init" && event.session_id);
    if (init) return init.session_id;
    const result = events.find((event) => event.type === "result" && event.session_id);
    return result?.session_id ?? null;
  }

  return null;
}

export function resumeStrategyFor(adapterType) {
  if (adapterType === "codex") return "codex_exec_resume";
  if (adapterType === "claude-code") return "claude_resume";
  return "adapter_defined";
}

export async function executeAdapterStep(adapter, prompt, options) {
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

  const adapterArgs = adapter.type === "claude-code"
    ? claudeArgs(options.externalSessionId, prompt, options.outputSchemaJson)
    : codexArgs(options.externalSessionId, options.outputSchemaPath);
  const args = [...(adapter.args ?? []), ...adapterArgs];
  const result = await runProcess(commandResolution.resolved, args, {
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
