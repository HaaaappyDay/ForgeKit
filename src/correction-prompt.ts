import { handoffOutputContract } from "./handoff-contract.js";
import type { RoleConfig, Run, WorkflowStep } from "./types.js";

interface ValidationErrors {
  parse_errors: string[];
  schema_errors: string[];
  content_errors: string[];
}

function excerpt(value: string, max = 4000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[truncated]`;
}

export function buildCorrectionPrompt({
  run,
  step,
  role,
  validation,
  rawOutput
}: {
  run: Run;
  step: WorkflowStep;
  role: RoleConfig;
  validation: ValidationErrors;
  rawOutput: string;
}): string {
  const errors = [
    ...validation.parse_errors.map((error) => `parse: ${error}`),
    ...validation.schema_errors.map((error) => `schema: ${error}`),
    ...validation.content_errors.map((error) => `content: ${error}`)
  ];

  return `Your previous ForgeKit handoff output failed validation.

Return exactly one corrected JSON object. Do not include prose outside the JSON object.

Validation errors:
${errors.map((error) => `- ${error}`).join("\n")}

${handoffOutputContract({
  runId: run.run_id,
  stepId: step.id,
  roleId: role.id
})}

Original output excerpt:
${excerpt(rawOutput)}
`;
}
