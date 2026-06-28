import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import type { Handoff, Run, WorkflowConfig, WorkflowSummary } from "./types.js";

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function decisions(handoff: Handoff): string[] {
  return handoff.decisions.map((item) => item.decision);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function summaryPath(projectRoot: string, runId: string): string {
  return join(projectRoot, ".forgekit/runs", runId, "context/workflow-summary.json");
}

async function validateWorkflowSummary(summary: WorkflowSummary): Promise<void> {
  const schema = await loadSchema("workflow-summary.v1");
  const result = validateJson(schema, summary);
  if (!result.valid) {
    throw new Error(`Invalid workflow-summary.v1:\n${result.errors.join("\n")}`);
  }
}

export function createWorkflowSummary(run: Run, workflow: WorkflowConfig): WorkflowSummary {
  return {
    schema_version: "workflow-summary.v1",
    run_id: run.run_id,
    revision: 0,
    updated_after_step: "",
    task_summary: run.task.input,
    completed_steps: [],
    current_assumptions: [],
    current_risks: [],
    current_open_questions: [],
    next_step_hint: workflow.entrypoint
  };
}

export async function writeWorkflowSummary(projectRoot: string, summary: WorkflowSummary): Promise<void> {
  await validateWorkflowSummary(summary);
  await writeJsonFile(summaryPath(projectRoot, summary.run_id), summary);
}

export async function readWorkflowSummary(projectRoot: string, runId: string): Promise<WorkflowSummary> {
  return readJsonFile<WorkflowSummary>(summaryPath(projectRoot, runId));
}

export async function updateWorkflowSummary(
  projectRoot: string,
  {
    run,
    workflow,
    stepIndex,
    handoff,
    handoffRef
  }: {
    run: Run;
    workflow: WorkflowConfig;
    stepIndex: number;
    handoff: Handoff;
    handoffRef: string;
  }
): Promise<WorkflowSummary> {
  const existing = await readWorkflowSummary(projectRoot, run.run_id);
  const nextStep = workflow.steps[stepIndex + 1];
  const updated = {
    ...existing,
    revision: existing.revision + 1,
    updated_after_step: handoff.step_id,
    completed_steps: [
      ...existing.completed_steps,
      {
        step_id: handoff.step_id,
        role_id: handoff.role_id,
        handoff_ref: handoffRef,
        summary: handoff.summary,
        key_decisions: decisions(handoff),
        risks: arrayOfStrings(handoff.risks),
        open_questions: arrayOfStrings(handoff.open_questions)
      }
    ],
    current_assumptions: uniqueStrings([...existing.current_assumptions, ...arrayOfStrings(handoff.assumptions)]),
    current_risks: uniqueStrings([...existing.current_risks, ...arrayOfStrings(handoff.risks)]),
    current_open_questions: uniqueStrings([...existing.current_open_questions, ...arrayOfStrings(handoff.open_questions)]),
    next_step_hint: nextStep?.id ?? ""
  };
  await writeWorkflowSummary(projectRoot, updated);
  return updated;
}
