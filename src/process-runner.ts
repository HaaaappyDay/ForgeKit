import { spawn } from "node:child_process";
import type { AdapterRuntimeConfig, ProcessOptions, ProcessResult } from "./types.js";

export function collectAllowedEnv(
  adapter: AdapterRuntimeConfig,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TEMP", "TMP"]) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }

  const allowlist = new Set([
    ...(adapter.env_allowlist ?? []),
    ...(adapter.auth?.env_allowlist ?? [])
  ]);
  for (const key of allowlist) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }

  return env;
}

export function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const start = Date.now();
  return new Promise<ProcessResult>((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        exitCode: null,
        status: "failed",
        error: error.message,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        exitCode,
        status: !timedOut && exitCode === 0 ? "passed" : "failed",
        error: timedOut ? "timed out" : null,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut
      });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        stderr += error.message;
      }
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}
