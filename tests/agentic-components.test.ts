import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildAcceptanceGatePrompt, parseAcceptanceVerdict, validateAcceptanceVerdict } from "../src/acceptance-gate.js";
import { parseHandoffV2FromRaw } from "../src/handoff-parser.js";
import { validateHandoffV2Content } from "../src/handoff-validator.js";
import { runInitCommand } from "../src/init-command.js";
import { buildAgenticWorkPrompt } from "../src/prompt-builder.js";
import { loadRoleConfig } from "../src/project-config.js";
import { buildCandidateDirectory } from "../src/role-directory.js";
import type { AcceptanceVerdictCandidate, HandoffV2Candidate, RepoSummary, WorkflowSummary } from "../src/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-agentic-components-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CRITERIA = ["covers auth path", "lists one risk", "states data model scope"];

function verdict(overrides: Partial<AcceptanceVerdictCandidate> = {}): AcceptanceVerdictCandidate {
  return {
    schema_version: "acceptance-verdict.v1",
    run_id: "run-1",
    node_id: "n2-architect",
    role_id: "architect",
    incoming_handoff_ref: "nodes/01-pm/work/attempt-01/handoff.json",
    verdict: "accept",
    criteria_results: CRITERIA.map((criterion) => ({ criterion, met: true, reason: "ok" })),
    notes: "",
    ...overrides
  };
}

const expectedVerdict = {
  runId: "run-1",
  nodeId: "n2-architect",
  roleId: "architect",
  incomingHandoffRef: "nodes/01-pm/work/attempt-01/handoff.json",
  criteria: CRITERIA
};

function handoffV2(overrides: Partial<HandoffV2Candidate> = {}): HandoffV2Candidate {
  return {
    schema_version: "handoff.v2",
    run_id: "run-1",
    step_id: "n1-pm",
    role_id: "pm",
    status: "completed",
    summary: "Clarified requirement.",
    decisions: [],
    assumptions: [],
    risks: [],
    open_questions: [],
    out_of_scope: [],
    markdown_body: "# Requirement\n\nBody.",
    next_handoff: {
      kind: "handoff",
      recommended_role: "architect",
      instructions: "Design it.",
      acceptance_criteria: ["covers auth path"]
    },
    artifacts: [],
    ...overrides
  };
}

const expectedHandoff = { runId: "run-1", stepId: "n1-pm", roleId: "pm" };

// --- role directory -------------------------------------------------------

test("buildCandidateDirectory returns slim profiles for candidates only, with when hints", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--yes"], dir);
    const profiles = await buildCandidateDirectory(["architect"], {
      projectRoot: dir,
      whenByRole: { architect: "a technical design is required" }
    });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, "architect");
    assert.ok(profiles[0].name.length > 0);
    assert.ok(profiles[0].one_line_responsibility.length > 0);
    assert.equal(profiles[0].when, "a technical design is required");
    // Slim profile: no full contract leaked in.
    assert.deepEqual(Object.keys(profiles[0]).sort(), ["id", "name", "one_line_responsibility", "when"]);
  });
});

// --- acceptance gate ------------------------------------------------------

test("buildAcceptanceGatePrompt asks for a verdict over each criterion", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--yes"], dir);
    const { role } = await loadRoleConfig("architect", dir);
    const prompt = buildAcceptanceGatePrompt({
      runId: "run-1",
      nodeId: "n2-architect",
      role,
      incomingHandoffRef: "nodes/01-pm/work/attempt-01/handoff.json",
      incomingMarkdown: "# Upstream output",
      acceptanceCriteria: CRITERIA
    });
    assert.match(prompt, /ForgeKit Acceptance Gate/);
    assert.match(prompt, /acceptance-verdict\.v1/);
    assert.match(prompt, /covers auth path/);
    assert.match(prompt, /# Upstream output/);
  });
});

test("validateAcceptanceVerdict accepts a consistent accept verdict", async () => {
  const result = await validateAcceptanceVerdict(verdict(), expectedVerdict);
  assert.deepEqual(result.content_errors, []);
  assert.deepEqual(result.schema_errors, []);
  assert.equal(result.valid, true);
  assert.equal(result.verdict, "accept");
  assert.deepEqual(result.unmet, []);
});

test("validateAcceptanceVerdict reports a consistent reject with unmet items", async () => {
  const result = await validateAcceptanceVerdict(
    verdict({
      verdict: "reject",
      criteria_results: [
        { criterion: CRITERIA[0], met: true, reason: "ok" },
        { criterion: CRITERIA[1], met: false, reason: "no risk listed" },
        { criterion: CRITERIA[2], met: true, reason: "ok" }
      ]
    }),
    expectedVerdict
  );
  assert.equal(result.valid, true);
  assert.equal(result.verdict, "reject");
  assert.deepEqual(result.unmet, [CRITERIA[1]]);
});

test("validateAcceptanceVerdict flags accept that contradicts an unmet criterion", async () => {
  const result = await validateAcceptanceVerdict(
    verdict({
      verdict: "accept",
      criteria_results: [
        { criterion: CRITERIA[0], met: true, reason: "ok" },
        { criterion: CRITERIA[1], met: false, reason: "missing" },
        { criterion: CRITERIA[2], met: true, reason: "ok" }
      ]
    }),
    expectedVerdict
  );
  assert.equal(result.valid, false);
  assert.ok(result.content_errors.some((error) => error.includes("accept but at least one criterion")));
});

test("validateAcceptanceVerdict flags criteria coverage mismatch", async () => {
  const result = await validateAcceptanceVerdict(
    verdict({ criteria_results: [{ criterion: CRITERIA[0], met: true, reason: "ok" }] }),
    expectedVerdict
  );
  assert.equal(result.valid, false);
  assert.ok(result.content_errors.some((error) => error.includes("must cover all 3")));
});

test("parseAcceptanceVerdict extracts a verdict from a JSONL adapter stream", () => {
  const raw = [
    JSON.stringify({ type: "thread.started", thread_id: "s1" }),
    JSON.stringify({ type: "item.completed", item: { text: JSON.stringify(verdict()) } })
  ].join("\n");
  const parsed = parseAcceptanceVerdict(raw);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.verdict?.verdict, "accept");
});

// --- handoff.v2 conditional validation ------------------------------------

test("validateHandoffV2Content accepts a valid handoff", async () => {
  const result = await validateHandoffV2Content(handoffV2(), expectedHandoff);
  assert.deepEqual(result.schema_errors, []);
  assert.deepEqual(result.content_errors, []);
  assert.equal(result.valid, true);
});

test("validateHandoffV2Content accepts a valid final", async () => {
  const result = await validateHandoffV2Content(handoffV2({ next_handoff: { kind: "final" } }), expectedHandoff);
  assert.deepEqual(result.content_errors, []);
  assert.equal(result.valid, true);
});

test("validateHandoffV2Content rejects a handoff missing acceptance_criteria", async () => {
  const result = await validateHandoffV2Content(
    handoffV2({ next_handoff: { kind: "handoff", recommended_role: "architect", instructions: "go" } as never }),
    expectedHandoff
  );
  assert.equal(result.valid, false);
  assert.ok(result.content_errors.some((error) => error.includes("acceptance_criteria")));
});

test("validateHandoffV2Content rejects a final that carries acceptance_criteria", async () => {
  const result = await validateHandoffV2Content(
    handoffV2({ next_handoff: { kind: "final", acceptance_criteria: ["x"] } as never }),
    expectedHandoff
  );
  assert.equal(result.valid, false);
  assert.ok(result.content_errors.some((error) => error.includes("must be empty when kind is final")));
});

test("parseHandoffV2FromRaw extracts a handoff.v2 object", () => {
  const raw = `prose...\n\`\`\`json\n${JSON.stringify(handoffV2())}\n\`\`\``;
  const parsed = parseHandoffV2FromRaw(raw);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.handoff?.schema_version, "handoff.v2");
});

// --- agentic work prompt --------------------------------------------------

const repoSummary = { schema_version: "repo-summary.v1", generated_at: "2026-06-20T00:00:00Z" } as unknown as RepoSummary;
const workflowSummary = { schema_version: "workflow-summary.v1" } as unknown as WorkflowSummary;

test("buildAgenticWorkPrompt injects the candidate directory and rework feedback", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--yes"], dir);
    const { role } = await loadRoleConfig("pm", dir);
    const candidates = await buildCandidateDirectory(["architect"], { projectRoot: dir });

    const prompt = buildAgenticWorkPrompt({
      runId: "run-1",
      nodeId: "n3-pm",
      roleId: "pm",
      taskInput: "Add login",
      role,
      objective: "Clarify requirement",
      instructions: "Refine the requirement",
      candidates,
      canFinal: false,
      repoSummary,
      workflowSummary,
      rework: { unmet: ["states data model scope"], verdictNotes: "scope unclear", originalObjective: "Clarify requirement" }
    });

    assert.match(prompt, /Candidate roles you may hand off to:/);
    assert.match(prompt, /- architect/);
    assert.match(prompt, /Rework feedback/);
    assert.match(prompt, /states data model scope/);
    assert.match(prompt, /schema_version: handoff\.v2/);
    assert.match(prompt, /MUST NOT finish here/);
  });
});
