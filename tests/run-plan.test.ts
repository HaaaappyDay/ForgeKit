import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInitCommand } from "../src/init-command.js";
import { readJsonFile, writeJsonFile } from "../src/json-file.js";
import { buildRunPlan, formatRunPlan } from "../src/run-plan.js";
import { runWorkflowStartCommand } from "../src/workflow-start-command.js";
import type { AdapterConfig, WorkflowConfig } from "../src/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-plan-"));
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
echo '{"type":"thread.started","thread_id":"plan-codex-session"}'
echo '{"type":"system","subtype":"init","session_id":"plan-claude-session"}'
handoff "$prompt"
exit 0
`;
}

test("buildRunPlan describes workflow steps, adapters, write intent, and budgets", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--yes"], dir);

    const plan = await buildRunPlan({
      workflowId: "feature-planning",
      taskInput: "Add passwordless login",
      projectRoot: dir
    });

    assert.equal(plan.workflow_id, "feature-planning");
    assert.deepEqual(
      plan.steps.map((step) => `${step.step_id}:${step.role_id}:${step.adapter_id}`),
      [
        "clarify-requirement:pm:codex-local",
        "technical-design:architect:claude-code",
        "implementation-plan:engineer:codex-local",
        "test-plan:qa:codex-local"
      ]
    );
    assert.deepEqual(
      plan.adapters.map((adapter) => adapter.adapter_id).sort(),
      ["claude-code", "codex-local"]
    );
    assert.equal(plan.context.mode, "no file modifications");
    assert.equal(plan.budgets.max_invocations, 8);
    assert.ok(plan.warnings.some((warning) => warning.includes("write enforcement is best_effort")));

    const text = formatRunPlan(plan);
    assert.match(text, /ForgeKit will start workflow: feature-planning/);
    assert.match(text, /Auth & billing:/);
    assert.match(text, /Write policy:/);
    assert.match(text, /effective mode: no_write_intent/);
    assert.match(text, /Soft budget:/);
  });
});

test("buildRunPlan rejects workflows outside the MVP-0 linear subset", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const workflowPath = join(dir, ".forgekit/workflows/generic-plan-review.json");
    const workflow = await readJsonFile<WorkflowConfig>(workflowPath);
    workflow.steps[0].next = ["review"];
    await writeJsonFile(workflowPath, workflow);

    await assert.rejects(
      () => buildRunPlan({
        workflowId: "generic-plan-review",
        taskInput: "Plan a launch checklist",
        projectRoot: dir
      }),
      /MVP-0 supports only linear workflows: step plan must point to specialist-analysis/
    );
  });
});

test("workflow start prints the run plan before executing with --yes", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const fakeAdapter = join(dir, "plan-agent");
    await writeExecutable(fakeAdapter, successfulAdapterScript());
    await patchAdapterCommand(dir, "codex.json", fakeAdapter);
    await patchAdapterCommand(dir, "claude-code.json", fakeAdapter);

    const output = await captureConsole(() => runWorkflowStartCommand([
      "generic-plan-review",
      "--input",
      "Plan a launch checklist",
      "--yes"
    ], dir));

    assert.match(output, /ForgeKit will start workflow: generic-plan-review/);
    assert.match(output, /1\. plan\s+role: planner\s+adapter: codex-local/);
    assert.match(output, /Auth & billing:/);
    assert.match(output, /mode: no file modifications/);
    assert.match(output, /Run: /);
    assert.match(output, /Status: completed/);
  });
});

test("workflow start supports plan-json and run json output", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const planJson = await captureConsole(() => runWorkflowStartCommand([
      "generic-plan-review",
      "--input",
      "Plan a launch checklist",
      "--plan-json"
    ], dir));
    const parsedPlan = JSON.parse(planJson) as { workflow_id: string; steps: unknown[] };
    assert.equal(parsedPlan.workflow_id, "generic-plan-review");
    assert.equal(parsedPlan.steps.length, 3);

    const fakeAdapter = join(dir, "json-agent");
    await writeExecutable(fakeAdapter, successfulAdapterScript());
    await patchAdapterCommand(dir, "codex.json", fakeAdapter);
    await patchAdapterCommand(dir, "claude-code.json", fakeAdapter);

    const runJson = await captureConsole(() => runWorkflowStartCommand([
      "generic-plan-review",
      "--input",
      "Plan a launch checklist",
      "--yes",
      "--json"
    ], dir));
    const parsedRun = JSON.parse(runJson) as {
      plan: { workflow_id: string };
      run: { status: string };
      events_ref: string;
    };
    assert.equal(parsedRun.plan.workflow_id, "generic-plan-review");
    assert.equal(parsedRun.run.status, "completed");
    assert.match(parsedRun.events_ref, /events\.jsonl$/);
  });
});
