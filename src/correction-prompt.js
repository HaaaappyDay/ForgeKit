function excerpt(value, max = 4000) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[truncated]`;
}

export function buildCorrectionPrompt({ run, step, role, validation, rawOutput }) {
  const errors = [
    ...validation.parse_errors.map((error) => `parse: ${error}`),
    ...validation.schema_errors.map((error) => `schema: ${error}`),
    ...validation.content_errors.map((error) => `content: ${error}`)
  ];

  return `Your previous ForgeKit handoff output failed validation.

Return exactly one JSON object conforming to handoff.v1. Do not include prose outside the JSON object.

Required identifiers:
- run_id: ${run.run_id}
- step_id: ${step.id}
- role_id: ${role.id}
- status: completed

Validation errors:
${errors.map((error) => `- ${error}`).join("\n")}

Required content:
- summary must be non-empty.
- markdown_body must be non-empty Markdown.
- next_handoff.instructions must be non-empty.
- decisions, assumptions, risks, open_questions, out_of_scope, and artifacts must be arrays.

Original output excerpt:
${excerpt(rawOutput)}
`;
}

