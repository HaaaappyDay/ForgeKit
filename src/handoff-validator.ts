import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import type { HandoffCandidate, HandoffV2Candidate } from "./types.js";

interface ExpectedHandoffFields {
  runId: string;
  stepId: string;
  roleId: string;
}

interface HandoffContentValidation {
  valid: boolean;
  schema_errors: string[];
  content_errors: string[];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeHandoffArtifacts(handoff: HandoffCandidate, markdownRef: string): HandoffCandidate {
  const existing = Array.isArray(handoff.artifacts) ? handoff.artifacts : [];
  const withoutGeneratedMarkdown = existing.filter(
    (artifact) => !(artifact?.type === "markdown" && artifact?.generated_from === "markdown_body")
  );
  return {
    ...handoff,
    artifacts: [
      ...withoutGeneratedMarkdown,
      {
        path: markdownRef,
        type: "markdown",
        generated_from: "markdown_body"
      }
    ]
  };
}

export async function validateHandoffContent(
  handoff: HandoffCandidate,
  expected: ExpectedHandoffFields
): Promise<HandoffContentValidation> {
  const schema = await loadSchema("handoff.v1");
  const schemaResult = validateJson(schema, handoff);
  const contentErrors: string[] = [];

  if (handoff?.run_id !== expected.runId) {
    contentErrors.push(`run_id must be ${expected.runId}`);
  }
  if (handoff?.step_id !== expected.stepId) {
    contentErrors.push(`step_id must be ${expected.stepId}`);
  }
  if (handoff?.role_id !== expected.roleId) {
    contentErrors.push(`role_id must be ${expected.roleId}`);
  }
  if (!nonEmptyString(handoff?.summary)) {
    contentErrors.push("summary must be non-empty");
  }
  if (!nonEmptyString(handoff?.markdown_body)) {
    contentErrors.push("markdown_body must be non-empty");
  }
  if (!nonEmptyString(handoff?.next_handoff?.instructions)) {
    contentErrors.push("next_handoff.instructions must be non-empty");
  }

  return {
    valid: schemaResult.valid && contentErrors.length === 0,
    schema_errors: schemaResult.errors,
    content_errors: contentErrors
  };
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => nonEmptyString(item));
}

/**
 * Validates a handoff.v2 candidate: schema, identifier/content checks, and the
 * conditional `next_handoff` discriminated union (spec §7.1). Route legality
 * (`recommended_role` in the candidate set) and `premature_final` are deliberately
 * NOT checked here — they depend on workflow/routing context and live in the
 * agentic loop (P4).
 */
export async function validateHandoffV2Content(
  handoff: HandoffV2Candidate,
  expected: ExpectedHandoffFields
): Promise<HandoffContentValidation> {
  const schema = await loadSchema("handoff.v2");
  const schemaResult = validateJson(schema, handoff);
  const contentErrors: string[] = [];

  if (handoff?.run_id !== expected.runId) {
    contentErrors.push(`run_id must be ${expected.runId}`);
  }
  if (handoff?.step_id !== expected.stepId) {
    contentErrors.push(`step_id must be ${expected.stepId}`);
  }
  if (handoff?.role_id !== expected.roleId) {
    contentErrors.push(`role_id must be ${expected.roleId}`);
  }
  if (!nonEmptyString(handoff?.summary)) {
    contentErrors.push("summary must be non-empty");
  }
  if (!nonEmptyString(handoff?.markdown_body)) {
    contentErrors.push("markdown_body must be non-empty");
  }

  const nextHandoff = (handoff?.next_handoff ?? {}) as Record<string, unknown>;
  const kind = nextHandoff.kind;
  if (kind === "handoff") {
    if (!nonEmptyString(nextHandoff.recommended_role)) {
      contentErrors.push("next_handoff.recommended_role must be non-empty when kind is handoff");
    }
    if (!nonEmptyString(nextHandoff.instructions)) {
      contentErrors.push("next_handoff.instructions must be non-empty when kind is handoff");
    }
    if (!nonEmptyStringArray(nextHandoff.acceptance_criteria)) {
      contentErrors.push("next_handoff.acceptance_criteria must list at least one non-empty criterion when kind is handoff");
    }
  } else if (kind === "final") {
    if (nextHandoff.recommended_role !== undefined && nextHandoff.recommended_role !== "") {
      contentErrors.push("next_handoff.recommended_role must be empty when kind is final");
    }
    if (nextHandoff.instructions !== undefined && nextHandoff.instructions !== "") {
      contentErrors.push("next_handoff.instructions must be empty when kind is final");
    }
    if (Array.isArray(nextHandoff.acceptance_criteria) && nextHandoff.acceptance_criteria.length > 0) {
      contentErrors.push("next_handoff.acceptance_criteria must be empty when kind is final");
    }
  } else {
    contentErrors.push('next_handoff.kind must be "handoff" or "final"');
  }

  return {
    valid: schemaResult.valid && contentErrors.length === 0,
    schema_errors: schemaResult.errors,
    content_errors: contentErrors
  };
}
