import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInitCommand } from "../src/init-command.js";
import {
  analyzeAgenticWorkflow,
  buildAgenticRunPlan,
  formatAgenticRunPlan,
  validateAgenticWorkflow
} from "../src/run-plan.js";
import type { AgenticWorkflowConfig } from "../src/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-agentic-plan-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function workflow(overrides: Partial<AgenticWorkflowConfig> = {}): AgenticWorkflowConfig {
  return {
    schema_version: "forgekit.workflow.v2",
    id: "agentic-test",
    name: "Agentic Test",
    version: "0.1",
    mode: "agentic_run",
    entrypoint: "pm",
    repo_context: "standard",
    roles: {
      pm: { handoff_targets: ["architect"] },
      architect: { handoff_targets: [] },
      engineer: { handoff_targets: ["reviewer"] },
      reviewer: { handoff_targets: ["engineer"] }
    },
    terminal_roles: ["reviewer"],
    ...overrides
  };
}

test("analyzeAgenticWorkflow accepts a valid graph and resolves candidate sources", () => {
  const analysis = analyzeAgenticWorkflow(workflow(), {
    pm: ["architect"],
    architect: ["engineer"],
    engineer: ["reviewer"],
    reviewer: ["engineer"]
  });

  assert.deepEqual(analysis.errors, []);
  assert.equal(analysis.candidatesByRole.pm.source, "workflow");
  assert.deepEqual(analysis.candidatesByRole.pm.candidates, ["architect"]);
  // architect has empty handoff_targets, so it falls back to must_handoff_to.
  assert.equal(analysis.candidatesByRole.architect.source, "role_must_handoff_to");
  assert.deepEqual(analysis.candidatesByRole.architect.candidates, ["engineer"]);
});

test("analyzeAgenticWorkflow does not flag a mixed terminal role with handoff_targets", () => {
  const analysis = analyzeAgenticWorkflow(workflow(), {
    pm: [],
    architect: ["engineer"],
    engineer: [],
    reviewer: ["engineer"]
  });
  // reviewer is terminal AND has handoff_targets -> mixed role is allowed.
  assert.deepEqual(analysis.errors, []);
  assert.equal(analysis.candidatesByRole.reviewer.source, "workflow");
});

test("analyzeAgenticWorkflow reports a dead end for a non-terminal role without candidates", () => {
  const analysis = analyzeAgenticWorkflow(
    workflow({
      roles: {
        pm: { handoff_targets: ["architect"] },
        architect: { handoff_targets: [] }
      },
      terminal_roles: ["pm"]
    }),
    { pm: ["architect"], architect: [] }
  );

  assert.ok(analysis.errors.some((error) => error.includes('"architect"') && error.includes("dead end")));
});

test("analyzeAgenticWorkflow reports an unreachable terminal role", () => {
  const analysis = analyzeAgenticWorkflow(
    {
      schema_version: "forgekit.workflow.v2",
      id: "wf",
      name: "wf",
      version: "0.1",
      mode: "agentic_run",
      entrypoint: "a",
      repo_context: "standard",
      roles: {
        a: { handoff_targets: ["b"] },
        b: { handoff_targets: ["b"] },
        c: { handoff_targets: [] }
      },
      terminal_roles: ["c"]
    },
    { a: [], b: [], c: [] }
  );

  assert.ok(analysis.errors.some((error) => error.includes("no terminal role is reachable")));
  assert.ok(analysis.warnings.some((warning) => warning.includes('"c"') && warning.includes("unreachable")));
});

test("analyzeAgenticWorkflow reports dangling handoff_targets", () => {
  const analysis = analyzeAgenticWorkflow(
    workflow({
      roles: {
        pm: { handoff_targets: ["ghost"] },
        done: { handoff_targets: [] }
      },
      terminal_roles: ["done"]
    }),
    { pm: [], done: [] }
  );

  assert.ok(
    analysis.errors.some((error) => error.includes("handoff_targets references unknown role") && error.includes('"ghost"'))
  );
});

test("analyzeAgenticWorkflow reports an entrypoint outside the roles table", () => {
  const analysis = analyzeAgenticWorkflow(
    workflow({ entrypoint: "missing" }),
    { pm: ["architect"], architect: ["engineer"], engineer: ["reviewer"], reviewer: ["engineer"] }
  );

  assert.ok(analysis.errors.some((error) => error.includes('entrypoint "missing"')));
});

test("analyzeAgenticWorkflow warns about an unreachable non-terminal role", () => {
  const analysis = analyzeAgenticWorkflow(
    {
      schema_version: "forgekit.workflow.v2",
      id: "wf",
      name: "wf",
      version: "0.1",
      mode: "agentic_run",
      entrypoint: "a",
      repo_context: "standard",
      roles: {
        a: { handoff_targets: ["b"] },
        b: { handoff_targets: [] },
        orphan: { handoff_targets: ["b"] }
      },
      terminal_roles: ["b"]
    },
    { a: [], b: [], orphan: [] }
  );

  assert.deepEqual(analysis.errors, []);
  assert.ok(analysis.warnings.some((warning) => warning.includes('"orphan"') && warning.includes("unreachable")));
});

const integrationWorkflow: AgenticWorkflowConfig = {
  schema_version: "forgekit.workflow.v2",
  id: "feature-planning-agentic",
  name: "Feature Planning (Agentic)",
  version: "0.1",
  mode: "agentic_run",
  entrypoint: "pm",
  repo_context: "standard",
  roles: {
    pm: { objective: "Clarify requirement", handoff_targets: ["architect"] },
    architect: { objective: "Technical design", handoff_targets: ["engineer"] },
    engineer: { objective: "Implementation plan", handoff_targets: ["qa"] },
    qa: { objective: "Test plan", handoff_targets: [] }
  },
  terminal_roles: ["qa"]
};

test("validateAgenticWorkflow passes for a valid workflow over project roles", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--yes"], dir);
    const result = await validateAgenticWorkflow(integrationWorkflow, dir);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.candidatesByRole.pm.source, "workflow");
  });
});

test("validateAgenticWorkflow rejects an entrypoint outside the roles table", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--yes"], dir);
    await assert.rejects(
      () => validateAgenticWorkflow({ ...integrationWorkflow, entrypoint: "ghost" }, dir),
      /Invalid agentic workflow[\s\S]*entrypoint "ghost"/
    );
  });
});

test("buildAgenticRunPlan describes routing, roles, and guardrail budgets", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--yes"], dir);

    const plan = await buildAgenticRunPlan({
      workflow: integrationWorkflow,
      taskInput: "Add passwordless login",
      projectRoot: dir
    });

    assert.equal(plan.run_mode, "agentic");
    assert.equal(plan.entrypoint, "pm");
    assert.deepEqual(plan.terminal_roles, ["qa"]);
    assert.deepEqual(
      plan.roles.map((role) => `${role.role_id}:${role.adapter_id}:${role.candidate_source}`),
      [
        "pm:codex-local:workflow",
        "architect:claude-code:workflow",
        "engineer:codex-local:workflow",
        "qa:codex-local:role_must_handoff_to"
      ]
    );
    // max_steps / max_role_visits are not set by the template, so defaults apply.
    assert.equal(plan.budgets.max_steps, 24);
    assert.equal(plan.budgets.max_role_visits, 3);

    const text = formatAgenticRunPlan(plan);
    assert.match(text, /ForgeKit will start agentic workflow: feature-planning-agentic/);
    assert.match(text, /Entrypoint: pm/);
    assert.match(text, /Terminal roles: qa/);
    assert.match(text, /can hand off to: architect/);
    assert.match(text, /Guardrails:/);
    assert.match(text, /max_steps: 24/);
  });
});
