import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadSchema } from "../src/schema-registry.js";
import { validateJson } from "../src/schema-validator.js";
import {
  addEdge,
  agenticAttemptRoot,
  appendNode,
  createInitialAgenticRun,
  isAgenticRun,
  markAgenticBudgetExceeded,
  readAnyRun,
  recordAgenticAdapterCall,
  relativeAgenticAttemptPath,
  roleVisits,
  writeAgenticRun
} from "../src/run-store.js";
import type { AgenticWorkflowConfig } from "../src/types.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-agentic-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const workflow: AgenticWorkflowConfig = {
  schema_version: "forgekit.workflow.v2",
  id: "feature-planning-agentic",
  name: "Feature Planning (Agentic)",
  version: "0.1",
  mode: "agentic_run",
  entrypoint: "pm",
  repo_context: "standard",
  roles: {
    pm: { handoff_targets: ["architect"] },
    architect: { handoff_targets: [] }
  },
  terminal_roles: ["architect"]
};

const budgets = {
  max_invocations: 20,
  max_retries_per_step: 1,
  max_duration_minutes: 30,
  max_output_bytes: 200000,
  max_steps: 24,
  max_role_visits: 3
};

function freshRun() {
  return createInitialAgenticRun({ runId: "run-1", workflow, taskInput: "Add login", budgets });
}

test("createInitialAgenticRun produces a schema-valid empty agentic run", async () => {
  const run = freshRun();
  assert.equal(run.run_mode, "agentic");
  assert.equal(run.status, "pending");
  assert.deepEqual(run.nodes, []);
  assert.deepEqual(run.edges, []);
  assert.equal(run.escalation, null);
  assert.equal(run.active_cursor, null);
  assert.equal(run.budget.max_steps, 24);
  assert.equal(run.budget.max_role_visits, 3);
  assert.equal(run.budget.steps, 0);
  assert.deepEqual(run.budget.role_visits, {});

  const schema = await loadSchema("forgekit.run.v2");
  assert.deepEqual(validateJson(schema, run).errors, []);
});

test("appendNode advances node_seq, accounting, and derives edges from entered_from", () => {
  const run = freshRun();

  const n1 = appendNode(run, { roleId: "pm", adapterId: "codex-local", entryReason: "entrypoint", objective: "Clarify" });
  assert.equal(n1.node_id, "n1-pm");
  assert.equal(n1.entered_from, null);

  const n2 = appendNode(run, {
    roleId: "architect",
    adapterId: "claude-code",
    entryReason: "handoff",
    enteredFrom: n1.node_id,
    objective: "Design"
  });
  assert.equal(n2.node_id, "n2-architect");

  const n3 = appendNode(run, {
    roleId: "pm",
    entryReason: "rework",
    enteredFrom: n2.node_id,
    edgeReason: ["data model scope unclear"]
  });
  assert.equal(n3.node_id, "n3-pm");

  // Entrypoint produced no edge; handoff and rework each produced one.
  assert.deepEqual(run.edges, [
    { from: "n1-pm", to: "n2-architect", type: "handoff" },
    { from: "n2-architect", to: "n3-pm", type: "rework", reason: ["data model scope unclear"] }
  ]);

  assert.equal(run.budget.steps, 3);
  assert.equal(roleVisits(run, "pm"), 2);
  assert.equal(roleVisits(run, "architect"), 1);
});

test("addEdge omits empty reason arrays", () => {
  const run = freshRun();
  const edge = addEdge(run, { from: "a", to: "b", type: "handoff", reason: [] });
  assert.deepEqual(edge, { from: "a", to: "b", type: "handoff" });
  assert.equal("reason" in edge, false);
});

test("markAgenticBudgetExceeded dedupes and sorts guardrail keys", () => {
  const run = freshRun();
  markAgenticBudgetExceeded(run, "max_role_visits");
  markAgenticBudgetExceeded(run, "max_steps");
  markAgenticBudgetExceeded(run, "max_role_visits");
  assert.deepEqual(run.budget.exceeded, ["max_role_visits", "max_steps"]);
});

test("recordAgenticAdapterCall accounts invocations and flags soft budget overrun", () => {
  const run = freshRun();
  run.budget.max_invocations = 1;
  recordAgenticAdapterCall(run, { prompt: "hi", stdout: "ok", stderr: "", isRetry: false });
  assert.equal(run.budget.invocations, 1);
  recordAgenticAdapterCall(run, { prompt: "again", stdout: "out", stderr: "", isRetry: true });
  assert.equal(run.budget.invocations, 2);
  assert.equal(run.budget.retries, 1);
  assert.ok(run.budget.exceeded.includes("max_invocations"));
});

test("node directory helpers use padded nodes/ paths", () => {
  const root = agenticAttemptRoot("/proj", "run-1", 2, "architect", "verification", 0);
  assert.ok(root.endsWith(join("nodes", "02-architect", "verification", "attempt-01")));
  assert.equal(
    relativeAgenticAttemptPath(3, "pm", "work", 0, "handoff.json"),
    join("nodes", "03-pm", "work", "attempt-01", "handoff.json")
  );
});

test("writeAgenticRun validates and readAnyRun discriminates agentic runs", async () => {
  await withTempDir(async (dir) => {
    const run = freshRun();
    appendNode(run, { roleId: "pm", adapterId: "codex-local", entryReason: "entrypoint" });
    appendNode(run, { roleId: "architect", adapterId: "claude-code", entryReason: "handoff", enteredFrom: "n1-pm" });
    run.status = "running";

    await writeAgenticRun(dir, run);

    const loaded = await readAnyRun(dir, "run-1");
    assert.ok(isAgenticRun(loaded));
    if (isAgenticRun(loaded)) {
      assert.equal(loaded.nodes.length, 2);
      assert.equal(loaded.edges.length, 1);
      assert.equal(loaded.budget.steps, 2);
    }
  });
});

test("writeAgenticRun rejects a structurally invalid run", async () => {
  await withTempDir(async (dir) => {
    const run = freshRun();
    // Corrupt the run_mode so it no longer matches the schema enum.
    (run as unknown as { run_mode: string }).run_mode = "linear";
    await assert.rejects(() => writeAgenticRun(dir, run), /Invalid run\.json \(agentic\)/);
  });
});
