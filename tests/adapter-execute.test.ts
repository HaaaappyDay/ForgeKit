import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { executeAdapterStep } from "../src/adapters/execute.js";
import type { AdapterRuntimeConfig } from "../src/types.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-execute-"));
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
printf '%s\\n' "$@" > "$ARG_LOG"
echo '{"type":"thread.started","thread_id":"fake-session"}'
exit 0
`,
    "utf8"
  );
  await chmod(path, 0o755);
}

function codexAdapter(command: string): AdapterRuntimeConfig {
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
    env_allowlist: ["ARG_LOG"]
  };
}

test("executeAdapterStep passes skip-git-repo-check to new Codex exec sessions", async () => {
  await withTempDir(async (dir) => {
    const command = join(dir, "fake-codex");
    const argLog = join(dir, "args.txt");
    await writeFakeCodex(command);

    const result = await executeAdapterStep(codexAdapter(command), "hello", {
      cwd: dir,
      env: { PATH: dir, ARG_LOG: argLog },
      outputSchemaPath: "handoff.schema.json"
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.externalSessionId, "fake-session");
    assert.deepEqual((await readFile(argLog, "utf8")).trim().split("\n"), [
      "exec",
      "--skip-git-repo-check",
      "--json",
      "--output-schema",
      "handoff.schema.json",
      "-s",
      "read-only",
      "-"
    ]);
  });
});

test("executeAdapterStep passes skip-git-repo-check to Codex resume sessions", async () => {
  await withTempDir(async (dir) => {
    const command = join(dir, "fake-codex");
    const argLog = join(dir, "args.txt");
    await writeFakeCodex(command);

    const result = await executeAdapterStep(codexAdapter(command), "hello again", {
      cwd: dir,
      env: { PATH: dir, ARG_LOG: argLog },
      externalSessionId: "existing-session",
      outputSchemaPath: "handoff.schema.json"
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.externalSessionId, "fake-session");
    assert.deepEqual((await readFile(argLog, "utf8")).trim().split("\n"), [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--json",
      "--output-schema",
      "handoff.schema.json",
      "existing-session",
      "-"
    ]);
  });
});
