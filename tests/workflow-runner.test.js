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

function fakeHandoffShellFunction() {
  return `handoff() {
  prompt="$1"
  run_id=$(printf "%s" "$prompt" | sed -n 's/^- run_id: //p' | head -n 1)
  step_id=$(printf "%s" "$prompt" | sed -n 's/^- step_id: //p' | head -n 1)
  if [ -z "$role_id" ]; then
    role_id=$(printf "%s" "$prompt" | sed -n 's/^- role_id: //p' | head -n 1)
  fi
  if [ -z "$step_id" ]; then
    step_id=$(printf "%s" "$prompt" | sed -n 's/^- id: //p' | sed -n '2p')
  fi
  if [ -z "$role_id" ]; then
    role_id=$(printf "%s" "$prompt" | sed -n 's/^- id: //p' | head -n 1)
  fi
  printf '{"schema_version":"handoff.v1","run_id":"%s","step_id":"%s","role_id":"%s","status":"completed","summary":"Valid handoff for %s","decisions":[],"assumptions":[],"risks":[],"open_questions":[],"out_of_scope":[],"markdown_body":"# Output for %s","next_handoff":{"recommended_role":"next","instructions":"Continue to the next step."},"artifacts":[]}
' "$run_id" "$step_id" "$role_id" "$step_id" "$step_id"
}
`;
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
${fakeHandoffShellFunction()}
prompt=$(cat)
echo '{"type":"thread.started","thread_id":"fake-codex-session"}'
handoff "$prompt"
exit 0
`
    );
    await writeExecutable(
      fakeClaude,
      `#!/bin/sh
${fakeHandoffShellFunction()}
for last
do
  prompt="$last"
done
echo '{"type":"system","subtype":"init","session_id":"fake-claude-session"}'
handoff "$prompt"
exit 0
`
    );
    await patchAdapterCommand(dir, "codex.json", fakeCodex);
    await patchAdapterCommand(dir, "claude-code.json", fakeClaude);

    const run = await runWorkflow({
      workflowId: "feature-planning",
      taskInput: "Add passwordless login",
      projectRoot: dir,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }
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
    assert.equal(persisted.steps[0].attempts[0].handoff_ref, "steps/01-clarify-requirement/attempt-01/handoff.json");
    assert.equal(persisted.steps[0].attempts[0].markdown_ref, "steps/01-clarify-requirement/attempt-01/output.md");
    assert.equal(persisted.steps[0].attempts[0].validation_ref, "steps/01-clarify-requirement/attempt-01/validation.json");

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

    const output = await readFile(
      join(dir, ".forgekit/runs", run.run_id, "steps/01-clarify-requirement/attempt-01/output.md"),
      "utf8"
    );
    assert.match(output, /Output for clarify-requirement/);
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
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }
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

test("runWorkflow self-corrects an invalid handoff once in the same attempt", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const correctingCodex = join(dir, "correcting-codex");
    await writeExecutable(
      correctingCodex,
      `#!/bin/sh
${fakeHandoffShellFunction()}
if [ "$1" = "-p" ]; then
  for last
  do
    prompt="$last"
  done
  echo '{"type":"system","subtype":"init","session_id":"fake-correction-session"}'
else
  prompt=$(cat)
  echo '{"type":"thread.started","thread_id":"fake-correction-session"}'
fi
if printf "%s" "$prompt" | grep -q "failed validation"; then
  handoff "$prompt"
else
  run_id=$(printf "%s" "$prompt" | sed -n 's/^- run_id: //p' | head -n 1)
  step_id=$(printf "%s" "$prompt" | sed -n 's/^- id: //p' | sed -n '2p')
  role_id=$(printf "%s" "$prompt" | sed -n 's/^- id: //p' | head -n 1)
  printf '{"schema_version":"handoff.v1","run_id":"%s","step_id":"%s","role_id":"%s","status":"completed","summary":"Missing markdown","decisions":[],"assumptions":[],"risks":[],"open_questions":[],"out_of_scope":[],"next_handoff":{"recommended_role":"next","instructions":"Continue."},"artifacts":[]}
' "$run_id" "$step_id" "$role_id"
fi
exit 0
`
    );
    await patchAdapterCommand(dir, "codex.json", correctingCodex);
    await patchAdapterCommand(dir, "claude-code.json", correctingCodex);

    const run = await runWorkflow({
      workflowId: "generic-plan-review",
      taskInput: "Plan a launch checklist",
      projectRoot: dir,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }
    });

    assert.equal(run.status, "completed");
    assert.equal(run.steps[0].attempts[0].correction_count, 1);
    assert.equal(run.steps[0].attempts[0].status, "completed");

    const validation = await readJsonFile(
      join(dir, ".forgekit/runs", run.run_id, "steps/01-plan/attempt-01/validation.json")
    );
    assert.equal(validation.valid, true);
    assert.equal(validation.correction_attempted, true);
    assert.equal(validation.correction_succeeded, true);
    assert.equal(validation.initial.valid, false);
    assert.equal(validation.correction.valid, true);
  });
});
