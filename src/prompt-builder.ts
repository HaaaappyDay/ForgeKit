import { agenticHandoffOutputContract, handoffOutputContract } from "./handoff-contract.js";
import type { CandidateProfile } from "./role-directory.js";
import type { RepoSummary, RoleConfig, Run, RunStep, WorkflowConfig, WorkflowStep, WorkflowSummary } from "./types.js";

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function buildStepPrompt({
  run,
  workflow,
  step,
  role,
  previousStep,
  repoSummary,
  workflowSummary
}: {
  run: Run;
  workflow: WorkflowConfig;
  step: WorkflowStep;
  role: RoleConfig;
  previousStep: RunStep | null;
  repoSummary: RepoSummary;
  workflowSummary: WorkflowSummary;
}): string {
  const constraints = step.constraints ? JSON.stringify(step.constraints, null, 2) : "{}";
  const previous = previousStep
    ? `Previous step: ${previousStep.step_id}\nPrevious status: ${previousStep.status}\nPrevious handoff: ${previousStep.attempts.at(-1)?.handoff_ref ?? ""}`
    : "Previous step: none";

  return `ForgeKit Workflow Step

Run:
- run_id: ${run.run_id}
- workflow_id: ${workflow.id}

Task:
${run.task.input}

Role:
- id: ${role.id}
- name: ${role.name}
- description: ${role.description}

Role boundaries:
- can_do: ${role.can_do.join("; ")}
- cannot_do: ${role.cannot_do.join("; ")}
- write_policy: ${role.write_policy.mode}

Step:
- id: ${step.id}
- objective: ${step.objective}
- output_schema: ${step.output_schema}

Step constraints:
${constraints}

Context:
${previous}

Workflow summary:
${compactJson(workflowSummary)}

Repository summary:
${compactJson(repoSummary)}

Instructions:
- Do not modify project files.
${handoffOutputContract({
  runId: run.run_id,
  stepId: step.id,
  roleId: role.id
})}
`;
}

export interface ReworkContext {
  unmet: string[];
  verdictNotes: string;
  originalObjective: string;
}

/**
 * Builds the work-call prompt for an agentic node (spec §9). Injects the candidate
 * directory so the role can pick its next hop, the handoff.v2 output contract, and —
 * when this node is a rework return — the unmet criteria and receiver feedback.
 */
export function buildAgenticWorkPrompt({
  runId,
  nodeId,
  roleId,
  taskInput,
  role,
  objective,
  instructions,
  candidates,
  canFinal,
  repoSummary,
  workflowSummary,
  rework
}: {
  runId: string;
  nodeId: string;
  roleId: string;
  taskInput: string;
  role: RoleConfig;
  objective: string;
  instructions: string;
  candidates: CandidateProfile[];
  canFinal: boolean;
  repoSummary: RepoSummary;
  workflowSummary: WorkflowSummary;
  rework?: ReworkContext;
}): string {
  const directory =
    candidates.length > 0
      ? candidates
          .map((candidate) => {
            const when = candidate.when ? ` (hand off when: ${candidate.when})` : "";
            return `- ${candidate.id} — ${candidate.name}: ${candidate.one_line_responsibility}${when}`;
          })
          .join("\n")
      : "- (none; this role has no handoff candidates)";

  const reworkBlock = rework
    ? `Rework feedback (a downstream role rejected your previous handoff):
- Original objective: ${rework.originalObjective}
- Unmet acceptance criteria:
${rework.unmet.map((item) => `  - ${item}`).join("\n") || "  - (none specified)"}
- Reviewer notes: ${rework.verdictNotes || "(none)"}
- Revise your output to address every unmet criterion above.

`
    : "";

  return `ForgeKit Agentic Node

Run:
- run_id: ${runId}
- node_id: ${nodeId}

Task:
${taskInput}

Role:
- id: ${role.id}
- name: ${role.name}
- description: ${role.description}

Role boundaries:
- can_do: ${role.can_do.join("; ")}
- cannot_do: ${role.cannot_do.join("; ")}
- write_policy: ${role.write_policy.mode}

Objective:
${instructions.trim().length > 0 ? instructions : objective}

${reworkBlock}Candidate roles you may hand off to:
${directory}

Workflow summary:
${compactJson(workflowSummary)}

Repository summary:
${compactJson(repoSummary)}

Instructions:
- Do not modify project files.
${agenticHandoffOutputContract({
  runId,
  nodeId,
  roleId,
  candidates: candidates.map((candidate) => candidate.id),
  canFinal
})}
`;
}
