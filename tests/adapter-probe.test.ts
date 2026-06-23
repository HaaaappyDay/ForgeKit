import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { probeAdapter, resolveCommand } from "../src/adapters/probe.js";
import type { AdapterRuntimeConfig } from "../src/types.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-probe-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFakeCodex(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "fake-codex 1.0.0"
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  echo "fake codex exec help"
  exit 0
fi
echo "unexpected args: $@" >&2
exit 2
`,
    "utf8"
  );
  await chmod(path, 0o755);
}

function adapter(command: string): AdapterRuntimeConfig {
  return {
    id: "codex-local",
    type: "codex",
    command,
    args: [],
    timeout_seconds: 5,
    auth: {
      mode: "external_cli_auth"
    },
    billing: {
      mode: "user_subscription",
      cost_tracking: "unavailable",
      budget_policy: "soft"
    },
    write_policy: {
      default_mode: "no_write_intent",
      enforcement: "best_effort",
      adapter_permission_args: [],
      warn_if_unenforceable: true
    },
    env_allowlist: []
  };
}

test("resolveCommand finds absolute executable paths", async () => {
  await withTempDir(async (dir) => {
    const command = join(dir, "fake-codex");
    await writeFakeCodex(command);
    const result = await resolveCommand(command, dir, { PATH: "" });
    assert.equal(result.found, true);
    assert.equal(result.resolved, command);
  });
});

test("resolveCommand finds command names on PATH", async () => {
  await withTempDir(async (dir) => {
    const command = join(dir, "fake-codex");
    await writeFakeCodex(command);
    const result = await resolveCommand("fake-codex", process.cwd(), { PATH: dir });
    assert.equal(result.found, true);
    assert.equal(result.resolved, command);
  });
});

test("probeAdapter passes basic checks for a codex-shaped command", async () => {
  await withTempDir(async (dir) => {
    const command = join(dir, "fake-codex");
    await writeFakeCodex(command);
    const result = await probeAdapter(adapter(command), { cwd: dir, env: { PATH: dir } });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.checks.map((check) => [check.name, check.status]),
      [
        ["command_exists", "passed"],
        ["version", "passed"],
        ["startup", "passed"]
      ]
    );
    assert.match(result.checks[1].stdout ?? "", /fake-codex/);
  });
});

test("probeAdapter fails when the command cannot be resolved", async () => {
  const result = await probeAdapter(adapter("missing-forgekit-command"), {
    cwd: process.cwd(),
    env: { PATH: "" }
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].name, "command_exists");
  assert.equal(result.checks[0].status, "failed");
});
