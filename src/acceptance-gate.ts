import { findTaggedObject } from "./handoff-parser.js";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import type { AcceptanceVerdictCandidate, RoleConfig } from "./types.js";

interface AcceptanceVerdictParseResult {
  verdict: AcceptanceVerdictCandidate | null;
  errors: string[];
}

export interface AcceptanceVerdictValidation {
  valid: boolean;
  schema_errors: string[];
  content_errors: string[];
  verdict: "accept" | "reject" | null;
  unmet: string[];
}

/**
 * Builds the acceptance-gate prompt for the receiving role (spec §7.2). The role
 * is asked to verify the upstream output against each acceptance criterion and to
 * return exactly one acceptance-verdict.v1 object — no work output yet.
 */
export function buildAcceptanceGatePrompt({
  runId,
  nodeId,
  role,
  incomingHandoffRef,
  incomingMarkdown,
  acceptanceCriteria
}: {
  runId: string;
  nodeId: string;
  role: RoleConfig;
  incomingHandoffRef: string;
  incomingMarkdown: string;
  acceptanceCriteria: string[];
}): string {
  const criteriaList = acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
  const criteriaJson = acceptanceCriteria
    .map((criterion) => `    { "criterion": ${JSON.stringify(criterion)}, "met": true, "reason": "non-empty string" }`)
    .join(",\n");

  return `ForgeKit Acceptance Gate

Run:
- run_id: ${runId}
- node_id: ${nodeId}

You are the receiving role:
- id: ${role.id}
- name: ${role.name}
- description: ${role.description}

You are NOT doing your main work yet. First verify whether the upstream deliverable
meets the acceptance criteria it was handed off with. Judge strictly and honestly.

Upstream handoff ref: ${incomingHandoffRef}

Upstream output to verify:
---
${incomingMarkdown}
---

Acceptance criteria (verify each one):
${criteriaList}

Verdict output contract:
- Return exactly one JSON object, nothing else.
- It must be an acceptance-verdict.v1 object.
- criteria_results must contain exactly one entry per criterion above, in order, with the
  criterion text copied verbatim.
- Set verdict to "accept" only if every criterion is met (all "met": true).
- Set verdict to "reject" if any criterion is not met (at least one "met": false), and
  explain why in that entry's "reason".
- Required shape:
{
  "schema_version": "acceptance-verdict.v1",
  "run_id": "${runId}",
  "node_id": "${nodeId}",
  "role_id": "${role.id}",
  "incoming_handoff_ref": "${incomingHandoffRef}",
  "verdict": "accept" | "reject",
  "criteria_results": [
${criteriaJson}
  ],
  "notes": ""
}`;
}

export function parseAcceptanceVerdict(raw: string): AcceptanceVerdictParseResult {
  const verdict = findTaggedObject(raw, (value) => value.schema_version === "acceptance-verdict.v1");
  if (verdict) {
    return { verdict: verdict as AcceptanceVerdictCandidate, errors: [] };
  }
  return {
    verdict: null,
    errors: ["No acceptance-verdict.v1 JSON object found in adapter output."]
  };
}

/**
 * Validates an acceptance verdict against the schema and the receiver/criteria
 * context (spec §7.2): identifiers match, criteria are covered one-to-one, and the
 * verdict value is consistent with the per-criterion `met` flags.
 */
export async function validateAcceptanceVerdict(
  verdict: AcceptanceVerdictCandidate,
  expected: {
    runId: string;
    nodeId: string;
    roleId: string;
    incomingHandoffRef: string;
    criteria: string[];
  }
): Promise<AcceptanceVerdictValidation> {
  const schema = await loadSchema("acceptance-verdict.v1");
  const schemaResult = validateJson(schema, verdict);
  const contentErrors: string[] = [];

  if (verdict?.run_id !== expected.runId) {
    contentErrors.push(`run_id must be ${expected.runId}`);
  }
  if (verdict?.node_id !== expected.nodeId) {
    contentErrors.push(`node_id must be ${expected.nodeId}`);
  }
  if (verdict?.role_id !== expected.roleId) {
    contentErrors.push(`role_id must be ${expected.roleId}`);
  }
  if (verdict?.incoming_handoff_ref !== expected.incomingHandoffRef) {
    contentErrors.push(`incoming_handoff_ref must be ${expected.incomingHandoffRef}`);
  }

  const results = Array.isArray(verdict?.criteria_results) ? verdict.criteria_results : [];
  const resultCriteria = results.map((entry) => (typeof entry?.criterion === "string" ? entry.criterion : ""));
  const expectedSet = new Set(expected.criteria);
  const resultSet = new Set(resultCriteria);

  if (results.length !== expected.criteria.length) {
    contentErrors.push(
      `criteria_results must cover all ${expected.criteria.length} acceptance criteria (got ${results.length})`
    );
  }
  for (const criterion of expected.criteria) {
    if (!resultSet.has(criterion)) {
      contentErrors.push(`criteria_results is missing the criterion: ${criterion}`);
    }
  }
  for (const criterion of resultCriteria) {
    if (!expectedSet.has(criterion)) {
      contentErrors.push(`criteria_results includes an unexpected criterion: ${criterion}`);
    }
  }

  const unmet = results
    .filter((entry) => entry?.met === false)
    .map((entry) => (typeof entry?.criterion === "string" ? entry.criterion : ""))
    .filter((criterion) => criterion.length > 0);

  const verdictValue = verdict?.verdict === "accept" || verdict?.verdict === "reject" ? verdict.verdict : null;

  if (verdictValue === "accept" && unmet.length > 0) {
    contentErrors.push("verdict is accept but at least one criterion is marked not met");
  }
  if (verdictValue === "reject" && unmet.length === 0) {
    contentErrors.push("verdict is reject but no criterion is marked not met");
  }

  return {
    valid: schemaResult.valid && contentErrors.length === 0,
    schema_errors: schemaResult.errors,
    content_errors: contentErrors,
    verdict: verdictValue,
    unmet
  };
}
