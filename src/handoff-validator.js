import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeHandoffArtifacts(handoff, markdownRef) {
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

export async function validateHandoffContent(handoff, expected) {
  const schema = await loadSchema("handoff.v1");
  const schemaResult = validateJson(schema, handoff);
  const contentErrors = [];

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

