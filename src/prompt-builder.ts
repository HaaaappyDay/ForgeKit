import { handoffOutputContract } from "./handoff-contract.js";
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
