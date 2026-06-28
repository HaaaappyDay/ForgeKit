import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { readJsonFile } from "./json-file.js";
import { runRoot } from "./run-store.js";
import { readWorkflowSummary } from "./workflow-summary.js";
import type { Handoff, Run, RunStep } from "./types.js";

function bulletList(items: string[]): string {
  if (!items.length) return "- None\n";
  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function stepLine(step: RunStep): string {
  const attempt = step.attempts[step.attempts.length - 1];
  const artifact = attempt?.markdown_ref ? `, output: ${attempt.markdown_ref}` : "";
  return `- ${step.index}. ${step.step_id} (${step.role_id}) - ${step.status}${artifact}`;
}

export async function writeFinalSummary(projectRoot: string, run: Run): Promise<void> {
  const workflowSummary = await readWorkflowSummary(projectRoot, run.run_id);
  const completed = workflowSummary.completed_steps;
  const lastCompleted = completed[completed.length - 1];
  let finalNotes = "No completed handoff was produced.";

  if (lastCompleted?.handoff_ref) {
    const handoff = await readJsonFile<Handoff>(join(runRoot(projectRoot, run.run_id), lastCompleted.handoff_ref));
    finalNotes = handoff.markdown_body ?? handoff.summary;
  }
  const assumptions = uniqueStrings(workflowSummary.current_assumptions);
  const risks = uniqueStrings(workflowSummary.current_risks);
  const openQuestions = uniqueStrings(workflowSummary.current_open_questions);
  const failedStep = run.steps.find((step) => step.status === "failed");
  const latestStatus = failedStep
    ? `Run failed at ${failedStep.step_id} (${failedStep.role_id}).`
    : run.status === "completed"
      ? "Run completed."
      : `Run ended with status: ${run.status}.`;

  const markdown = `# ForgeKit Run Summary

## Result

- Status: ${latestStatus}
- Latest output: ${lastCompleted?.handoff_ref ? lastCompleted.handoff_ref : "No completed handoff was produced."}
- Next review target: ${risks.length > 0 ? "Current Risks" : openQuestions.length > 0 ? "Current Open Questions" : "Final Notes"}

## Run

- Run ID: ${run.run_id}
- Workflow: ${run.workflow_id}
- Status: ${run.status}
- Duration: ${run.duration_ms} ms

## Task

${run.task.input}

## Steps

${run.steps.map(stepLine).join("\n")}

## Current Assumptions

${bulletList(assumptions)}
## Current Risks

${bulletList(risks)}
## Current Open Questions

${bulletList(openQuestions)}
## Final Notes

${finalNotes.trim()}
`;

  await writeFile(join(runRoot(projectRoot, run.run_id), "summary.md"), markdown, "utf8");
}
