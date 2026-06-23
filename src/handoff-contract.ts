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

export function agenticHandoffOutputContract({
  runId,
  nodeId,
  roleId,
  candidates,
  canFinal
}: {
  runId: string;
  nodeId: string;
  roleId: string;
  candidates: string[];
  canFinal: boolean;
}): string {
  const candidateList = candidates.length > 0 ? candidates.join(", ") : "(none)";
  const finalGuidance = canFinal
    ? `- You MAY finish the workflow by setting next_handoff to {"kind": "final"} when the task is complete.`
    : `- You MUST NOT finish here: this role is not a terminal role, so next_handoff.kind must be "handoff".`;

  return `Handoff output contract (agentic):
- Return exactly one JSON object. The top-level object must be the handoff itself.
- Do not wrap it in {"handoff": ...}, markdown, prose, or tool-call markup.
- Do not include fields that are not listed below.
- Required identifiers:
- schema_version: handoff.v2
- run_id: ${runId}
- step_id: ${nodeId}
- role_id: ${roleId}
- status: completed
Routing rules:
- To hand off, set next_handoff.kind to "handoff" and set recommended_role to EXACTLY ONE of: ${candidateList}.
- When kind is "handoff" you MUST provide non-empty instructions and at least one acceptance_criteria entry the next role must satisfy.
${finalGuidance}
- Required shape (handoff):
{
  "schema_version": "handoff.v2",
  "run_id": "${runId}",
  "step_id": "${nodeId}",
  "role_id": "${roleId}",
  "status": "completed",
  "summary": "non-empty string",
  "decisions": [
    { "decision": "non-empty string", "reason": "non-empty string", "alternatives": ["string"] }
  ],
  "assumptions": ["string"],
  "risks": ["string"],
  "open_questions": ["string"],
  "out_of_scope": ["string"],
  "markdown_body": "non-empty markdown string",
  "next_handoff": {
    "kind": "handoff",
    "recommended_role": "one of: ${candidateList}",
    "instructions": "non-empty string",
    "acceptance_criteria": ["at least one non-empty criterion"]
  },
  "artifacts": []
}
- Required shape (final): identical, but "next_handoff": { "kind": "final" }.`;
}
