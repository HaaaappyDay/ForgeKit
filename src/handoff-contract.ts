export function handoffOutputContract({
  runId,
  stepId,
  roleId
}: {
  runId: string;
  stepId: string;
  roleId: string;
}): string {
  return `Handoff output contract:
- Return exactly one JSON object.
- The top-level object must be the handoff itself. Do not wrap it in {"handoff": ...}, markdown, prose, or tool-call markup.
- Do not include fields that are not listed below.
- Required identifiers:
- schema_version: handoff.v1
- run_id: ${runId}
- step_id: ${stepId}
- role_id: ${roleId}
- status: completed
- Required shape:
{
  "schema_version": "handoff.v1",
  "run_id": "${runId}",
  "step_id": "${stepId}",
  "role_id": "${roleId}",
  "status": "completed",
  "summary": "non-empty string",
  "decisions": [
    {
      "decision": "non-empty string",
      "reason": "non-empty string",
      "alternatives": ["string"]
    }
  ],
  "assumptions": ["string"],
  "risks": ["string"],
  "open_questions": ["string"],
  "out_of_scope": ["string"],
  "markdown_body": "non-empty markdown string",
  "next_handoff": {
    "recommended_role": "non-empty role id",
    "instructions": "non-empty string"
  },
  "artifacts": []
}`;
}
