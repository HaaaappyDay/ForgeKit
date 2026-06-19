import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runHistoryCommand } from "../src/history-command.js";
import { runInitCommand } from "../src/init-command.js";
import { readJsonFile, writeJsonFile } from "../src/json-file.js";
import { runRoleCommand } from "../src/role-command.js";
import { runRunCommand } from "../src/run-command.js";
import { runWorkflow } from "../src/workflow-runner.js";
import type { AdapterConfig, ProjectConfig, Run } from "../src/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-commands-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function patchAdapterCommand(projectRoot: string, adapterFile: string, command: string): Promise<void> {
  const path = join(projectRoot, ".forgekit/adapters", adapterFile);
  const adapter = await readJsonFile<AdapterConfig>(path);
  adapter.command = command;
  await writeJsonFile(path, adapter);
}

async function patchConfig(projectRoot: string, mutate: (config: ProjectConfig) => void): Promise<void> {
  const path = join(projectRoot, ".forgekit/config.json");
  const config = await readJsonFile<ProjectConfig>(path);
  mutate(config);
  await writeJsonFile(path, config);
}

async function captureConsole(fn: () => Promise<void> | void): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

function fakeHandoffShellFunction(): string {
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

function successfulAdapterScript(): string {
  return `#!/bin/sh
${fakeHandoffShellFunction()}
if [ "$1" = "-p" ]; then
  for last
  do
    prompt="$last"
  done
else
  prompt=$(cat)
fi
echo '{"type":"thread.started","thread_id":"commands-codex-session"}'
echo '{"type":"system","subtype":"init","session_id":"commands-claude-session"}'
handoff "$prompt"
exit 0
`;
}

function flakyAdapterScript(stateFile: string): string {
  return `#!/bin/sh
${fakeHandoffShellFunction()}
if [ "$1" = "-p" ]; then
  for last
  do
    prompt="$last"
  done
else
  prompt=$(cat)
fi
step_id=$(printf "%s" "$prompt" | sed -n 's/^- step_id: //p' | head -n 1)
if [ -z "$step_id" ]; then
  step_id=$(printf "%s" "$prompt" | sed -n 's/^- id: //p' | sed -n '2p')
fi
echo '{"type":"thread.started","thread_id":"retry-codex-session"}'
echo '{"type":"system","subtype":"init","session_id":"retry-claude-session"}'
if [ "$step_id" = "plan" ] && [ ! -f "${stateFile}" ]; then
  touch "${stateFile}"
  echo "first plan attempt failed" >&2
  exit 2
fi
handoff "$prompt"
exit 0
`;
}

test("history, run show, and role path report local run metadata", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const fakeAdapter = join(dir, "successful-agent");
    await writeExecutable(fakeAdapter, successfulAdapterScript());
    await patchAdapterCommand(dir, "codex.json", fakeAdapter);
    await patchAdapterCommand(dir, "claude-code.json", fakeAdapter);

    const run = await runWorkflow({
      workflowId: "generic-plan-review",
      taskInput: "Plan a launch checklist",
      projectRoot: dir,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }
    });

    const historyOutput = await captureConsole(() => runHistoryCommand([], dir));
    assert.match(historyOutput, new RegExp(`${run.run_id}\\s+completed\\s+generic-plan-review`));

    const showOutput = await captureConsole(() => runRunCommand(["show", run.run_id], dir));
    assert.match(showOutput, new RegExp(`Run: ${run.run_id}`));
    assert.match(showOutput, /Status: completed/);
    assert.match(showOutput, /Budget:/);
    assert.match(showOutput, /invocations: 3\/8/);
    assert.match(showOutput, new RegExp(`Summary: \\.forgekit/runs/${run.run_id}/summary\\.md`));

    const showJson = await captureConsole(() => runRunCommand(["show", run.run_id, "--json"], dir));
    const parsed = JSON.parse(showJson) as Run;
    assert.equal(parsed.run_id, run.run_id);
    assert.equal(parsed.budget.invocations, 3);

    const rolePathOutput = await captureConsole(() => runRoleCommand(["path", "planner"], dir));
    assert.match(rolePathOutput, new RegExp(`${dir}/\\.forgekit/roles/planner\\.json`));
    assert.match(rolePathOutput, /CLI overrides cannot broaden write policy/);
  });
});

test("run retry appends a new attempt and keeps prior artifacts", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);
    await patchConfig(dir, (config) => {
      config.budgets.max_invocations = 1;
    });

    const fakeAdapter = join(dir, "flaky-agent");
    const stateFile = join(dir, "flaky-state");
    await writeExecutable(fakeAdapter, flakyAdapterScript(stateFile));
    await patchAdapterCommand(dir, "codex.json", fakeAdapter);
    await patchAdapterCommand(dir, "claude-code.json", fakeAdapter);

    const failedRun = await runWorkflow({
      workflowId: "generic-plan-review",
      taskInput: "Plan a launch checklist",
      projectRoot: dir,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }
    });

    assert.equal(failedRun.status, "failed");
    assert.deepEqual(
      failedRun.steps.map((step) => step.status),
      ["failed", "skipped", "skipped"]
    );

    const failedErrorPath = join(dir, ".forgekit/runs", failedRun.run_id, "steps/01-plan/attempt-01/error.log");
    const originalErrorLog = await readFile(failedErrorPath, "utf8");
    assert.match(originalErrorLog, /first plan attempt failed/);

    const retryOutput = await captureConsole(() => runRunCommand(["retry", failedRun.run_id], dir));
    assert.match(retryOutput, /Status: completed/);

    const retriedRun = await readJsonFile<Run>(join(dir, ".forgekit/runs", failedRun.run_id, "run.json"));
    assert.equal(retriedRun.status, "completed");
    assert.deepEqual(
      retriedRun.steps.map((step) => step.status),
      ["completed", "completed", "completed"]
    );
    assert.deepEqual(
      retriedRun.steps[0].attempts.map((attempt) => attempt.attempt_id),
      ["attempt-01", "attempt-02"]
    );
    assert.equal(retriedRun.steps[0].attempts[0].status, "failed");
    assert.equal(retriedRun.steps[0].attempts[1].status, "completed");
    assert.equal(retriedRun.steps[0].active_attempt, "attempt-02");
    assert.equal(retriedRun.steps[1].attempts.length, 1);
    assert.equal(retriedRun.steps[2].attempts.length, 1);
    assert.equal(await readFile(failedErrorPath, "utf8"), originalErrorLog);

    const retryOutputMarkdown = await readFile(
      join(dir, ".forgekit/runs", failedRun.run_id, "steps/01-plan/attempt-02/output.md"),
      "utf8"
    );
    assert.match(retryOutputMarkdown, /Output for plan/);

    assert.equal(retriedRun.budget.invocations, 4);
    assert.equal(retriedRun.budget.retries, 3);
    assert.ok(retriedRun.budget.output_bytes > 0);
    assert.ok(retriedRun.budget.input_chars > 0);
    assert.deepEqual(retriedRun.budget.exceeded, ["max_invocations"]);
  });
});
