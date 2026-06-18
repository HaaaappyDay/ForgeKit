import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { readJsonFile } from "./json-file.js";
import { runRoot } from "./run-store.js";
import { readWorkflowSummary } from "./workflow-summary.js";

function bulletList(items) {
  if (!items.length) return "- None\n";
  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

function stepLine(step) {
  const attempt = step.attempts[step.attempts.length - 1];
  const artifact = attempt?.markdown_ref ? `, output: ${attempt.markdown_ref}` : "";
  return `- ${step.index}. ${step.step_id} (${step.role_id}) - ${step.status}${artifact}`;
}

export async function writeFinalSummary(projectRoot, run) {
  const workflowSummary = await readWorkflowSummary(projectRoot, run.run_id);
  const completed = workflowSummary.completed_steps;
  const lastCompleted = completed[completed.length - 1];
  let finalNotes = "No completed handoff was produced.";

  if (lastCompleted?.handoff_ref) {
    const handoff = await readJsonFile(join(runRoot(projectRoot, run.run_id), lastCompleted.handoff_ref));
    finalNotes = handoff.markdown_body ?? handoff.summary;
  }

  const markdown = `# ForgeKit Run Summary

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

${bulletList(workflowSummary.current_assumptions)}
## Current Risks

${bulletList(workflowSummary.current_risks)}
## Current Open Questions

${bulletList(workflowSummary.current_open_questions)}
## Final Notes

${finalNotes.trim()}
`;

  await writeFile(join(runRoot(projectRoot, run.run_id), "summary.md"), markdown, "utf8");
}

