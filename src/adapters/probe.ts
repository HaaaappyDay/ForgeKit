import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { collectAllowedEnv, runProcess } from "../process-runner.js";
import type { AdapterProbeCheck, AdapterProbeResult, AdapterRuntimeConfig, AdapterType } from "../types.js";

const PROBE_TIMEOUT_MS = 10_000;

const PROBE_CHECKS: Record<AdapterType, Array<{ name: string; args: string[] }>> = {
  codex: [
    { name: "version", args: ["--version"] },
    { name: "startup", args: ["exec", "--help"] }
  ],
  "claude-code": [
    { name: "version", args: ["--version"] },
    { name: "startup", args: ["--help"] }
  ]
};

interface CommandResolution {
  command: string;
  resolved: string | null;
  found: boolean;
}

interface ProbeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommand(
  command: string,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): Promise<CommandResolution> {
  if (isAbsolute(command) || hasPathSeparator(command)) {
    const resolved = isAbsolute(command) ? command : resolve(cwd, command);
    return {
      command,
      resolved,
      found: await isExecutable(resolved)
    };
  }

  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) {
      return {
        command,
        resolved: candidate,
        found: true
      };
    }
  }

  return {
    command,
    resolved: null,
    found: false
  };
}

function excerpt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 600) return trimmed;
  return `${trimmed.slice(0, 600)}...`;
}

export async function probeAdapter(
  adapter: AdapterRuntimeConfig,
  options: ProbeOptions = {}
): Promise<AdapterProbeResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = collectAllowedEnv(adapter, options.env ?? process.env);
  const commandResolution = await resolveCommand(adapter.command, cwd, env);
  const checks: AdapterProbeCheck[] = [];

  if (!commandResolution.found) {
    return {
      adapter_id: adapter.id,
      adapter_type: adapter.type,
      ok: false,
      command: adapter.command,
      resolved_command: null,
      checks: [
        {
          name: "command_exists",
          status: "failed",
          message: `Command not found or not executable: ${adapter.command}`
        }
      ],
      auth: adapter.auth,
      billing: adapter.billing,
      write_policy: adapter.write_policy
    };
  }

  checks.push({
    name: "command_exists",
    status: "passed",
    resolved_command: commandResolution.resolved ?? ""
  });

  const resolvedCommand = commandResolution.resolved;
  if (!resolvedCommand) {
    throw new Error(`Command resolution succeeded without a resolved path: ${adapter.command}`);
  }

  const probeChecks = PROBE_CHECKS[adapter.type] ?? [];
  for (const check of probeChecks) {
    const args = [...(adapter.args ?? []), ...check.args];
    const result = await runProcess(resolvedCommand, args, {
      cwd,
      env,
      timeoutMs: Math.min((adapter.timeout_seconds ?? 10) * 1000, PROBE_TIMEOUT_MS)
    });
    checks.push({
      name: check.name,
      status: result.status,
      argv: [adapter.command, ...args],
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      stdout: excerpt(result.stdout),
      stderr: excerpt(result.stderr),
      error: result.error
    });
  }

  return {
    adapter_id: adapter.id,
    adapter_type: adapter.type,
    ok: checks.every((check) => check.status === "passed"),
    command: adapter.command,
    resolved_command: commandResolution.resolved,
    checks,
    auth: adapter.auth,
    billing: adapter.billing,
    write_policy: adapter.write_policy,
    notes: adapter.type === "claude-code"
      ? ["Claude Code may require node on PATH for hook execution in non-interactive runs."]
      : []
  };
}
