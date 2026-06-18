import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInitCommand } from "../src/init-command.js";
import { readJsonFile, writeJsonFile } from "../src/json-file.js";
import { runWorkflow } from "../src/workflow-runner.js";

async function withTempProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-runner-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeExecutable(path, content) {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function patchAdapterCommand(projectRoot, adapterFile, command) {
  const path = join(projectRoot, ".forgekit/adapters", adapterFile);
  const adapter = await readJsonFile(path);
  adapter.command = command;
  await writeJsonFile(path, adapter);
}

async function runDirs(projectRoot) {
  const entries = await readdir(join(projectRoot, ".forgekit/runs"), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

test("runWorkflow records a completed linear run with role sessions and raw logs", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--yes"], dir);

    const fakeCodex = join(dir, "fake-codex");
    const fakeClaude = join(dir, "fake-claude");
    await writeExecutable(
      fakeCodex,
      `#!/bin/sh
cat >/dev/null
echo '{"type":"thread.started","thread_id":"fake-codex-session"}'
echo '{"type":"turn.completed"}'
exit 0
`
    );
    await writeExecutable(
      fakeClaude,
      `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"fake-claude-session"}'
echo '{"type":"result","session_id":"fake-claude-session"}'
exit 0
`
    );
    await patchAdapterCommand(dir, "codex.json", fakeCodex);
    await patchAdapterCommand(dir, "claude-code.json", fakeClaude);

    const run = await runWorkflow({
      workflowId: "feature-planning",
      taskInput: "Add passwordless login",
      projectRoot: dir,
      env: { PATH: dir, HOME: dir }
    });

    assert.equal(run.status, "completed");
    assert.equal(run.steps.length, 4);
    assert.deepEqual(
      run.steps.map((step) => step.status),
      ["completed", "completed", "completed", "completed"]
    );
    assert.equal(run.role_sessions.pm.external_session_id, "fake-codex-session");
    assert.equal(run.role_sessions.architect.external_session_id, "fake-claude-session");
    assert.equal(run.role_sessions.engineer.external_session_id, "fake-codex-session");
    assert.equal(run.role_sessions.qa.external_session_id, "fake-codex-session");

    const dirs = await runDirs(dir);
    assert.deepEqual(dirs, [run.run_id]);

    const persisted = await readJsonFile(join(dir, ".forgekit/runs", run.run_id, "run.json"));
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.steps[0].attempts[0].prompt_ref, "steps/01-clarify-requirement/attempt-01/prompt.md");

    const prompt = await readFile(
      join(dir, ".forgekit/runs", run.run_id, "steps/01-clarify-requirement/attempt-01/prompt.md"),
      "utf8"
    );
    assert.match(prompt, /Add passwordless login/);
    assert.match(prompt, /Do not modify project files/);

    const raw = await readFile(
      join(dir, ".forgekit/runs", run.run_id, "steps/01-clarify-requirement/attempt-01/raw.log"),
      "utf8"
    );
    assert.match(raw, /thread.started/);
  });
});

test("runWorkflow marks downstream steps skipped after a failed step", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const failingCodex = join(dir, "failing-codex");
    await writeExecutable(
      failingCodex,
      `#!/bin/sh
echo "adapter failed" >&2
exit 2
`
    );
    await patchAdapterCommand(dir, "codex.json", failingCodex);

    const run = await runWorkflow({
      workflowId: "generic-plan-review",
      taskInput: "Plan a launch checklist",
      projectRoot: dir,
      env: { PATH: dir, HOME: dir }
    });

    assert.equal(run.status, "failed");
    assert.deepEqual(
      run.steps.map((step) => step.status),
      ["failed", "skipped", "skipped"]
    );
    assert.deepEqual(run.role_sessions, {});
    assert.equal(run.steps[0].attempts[0].exit_code, 2);
    assert.match(run.steps[0].attempts[0].error, /missing external session id/);
  });
});

