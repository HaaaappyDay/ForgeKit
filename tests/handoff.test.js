import assert from "node:assert/strict";
import test from "node:test";
import { parseHandoffFromRaw } from "../src/handoff-parser.js";
import { normalizeHandoffArtifacts, validateHandoffContent } from "../src/handoff-validator.js";

function handoff(overrides = {}) {
  return {
    schema_version: "handoff.v1",
    run_id: "run-1",
    step_id: "step-1",
    role_id: "role-1",
    status: "completed",
    summary: "A valid handoff.",
    decisions: [],
    assumptions: [],
    risks: [],
    open_questions: [],
    out_of_scope: [],
    markdown_body: "# Output",
    next_handoff: {
      recommended_role: "next",
      instructions: "Continue."
    },
    artifacts: [],
    ...overrides
  };
}

test("parseHandoffFromRaw reads Codex item text", () => {
  const raw = [
    JSON.stringify({ type: "thread.started", thread_id: "session-1" }),
    JSON.stringify({ type: "item.completed", item: { text: JSON.stringify(handoff()) } })
  ].join("\n");
  const parsed = parseHandoffFromRaw(raw);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.handoff.step_id, "step-1");
});

test("parseHandoffFromRaw reads Claude assistant content", () => {
  const raw = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: `\`\`\`json\n${JSON.stringify(handoff())}\n\`\`\``
        }
      ]
    }
  });
  const parsed = parseHandoffFromRaw(raw);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.handoff.role_id, "role-1");
});

test("validateHandoffContent checks required content", async () => {
  const normalized = normalizeHandoffArtifacts(handoff({ markdown_body: "" }), "steps/01-step/attempt-01/output.md");
  const result = await validateHandoffContent(normalized, {
    runId: "run-1",
    stepId: "step-1",
    roleId: "role-1"
  });
  assert.equal(result.valid, false);
  assert.ok(result.schema_errors.some((error) => error.includes("markdown_body")));
  assert.ok(result.content_errors.some((error) => error.includes("markdown_body")));
});

test("normalizeHandoffArtifacts records generated output markdown", () => {
  const normalized = normalizeHandoffArtifacts(handoff(), "steps/01-step/attempt-01/output.md");
  assert.deepEqual(normalized.artifacts, [
    {
      path: "steps/01-step/attempt-01/output.md",
      type: "markdown",
      generated_from: "markdown_body"
    }
  ]);
});

