import { getRunSnapshot, retryRun } from "./core.js";
import type { Run } from "./types.js";

interface RunCommandOptions {
  subcommand?: string;
  runId?: string;
  json: boolean;
  help: boolean;
}

function parseRunArgs(args: string[]): RunCommandOptions {
  return {
    subcommand: args[0],
    runId: args[1],
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h")
  };
}

function printHelp(): void {
  console.log(`Usage:
  forge run show <run-id> [--json]
  forge run retry <run-id> [--json]`);
}

function printRun(run: Run): void {
  console.log(`Run: ${run.run_id}`);
  console.log(`Workflow: ${run.workflow_id}`);
  console.log(`Status: ${run.status}`);
  console.log(`Created: ${run.created_at}`);
  console.log(`Updated: ${run.updated_at}`);
  console.log(`Duration: ${run.duration_ms} ms`);
  console.log("");
  console.log("Steps:");
  for (const step of run.steps) {
    const attempt = step.attempts.at(-1);
    const attemptText = attempt ? `${attempt.attempt_id}, exit ${attempt.exit_code}` : "no attempts";
    console.log(`  ${step.index}. ${step.step_id} (${step.role_id}) - ${step.status} [${attemptText}]`);
    if (attempt?.markdown_ref) console.log(`     output: ${attempt.markdown_ref}`);
    if (attempt?.error) console.log(`     error: ${attempt.error}`);
  }
  console.log("");
  console.log("Budget:");
  console.log(`  invocations: ${run.budget.invocations}/${run.budget.max_invocations}`);
  console.log(`  retries: ${run.budget.retries}`);
  console.log(`  input_chars: ${run.budget.input_chars}`);
  console.log(`  output_bytes: ${run.budget.output_bytes}/${run.budget.max_output_bytes}`);
  console.log(`  exceeded: ${run.budget.exceeded.length ? run.budget.exceeded.join(", ") : "none"}`);
  console.log("");
  console.log(`Summary: .forgekit/runs/${run.run_id}/summary.md`);
}

export async function runRunCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const options = parseRunArgs(args);
  if (options.help || !options.subcommand) {
    printHelp();
    return;
  }
  if (!options.runId) {
    throw new Error(`Usage: forge run ${options.subcommand} <run-id>`);
  }

  if (options.subcommand === "show") {
    const run = await getRunSnapshot(options.runId, cwd);
    if (options.json) {
      console.log(JSON.stringify(run, null, 2));
    } else {
      printRun(run);
    }
    return;
  }

  if (options.subcommand === "retry") {
    const run = await retryRun({ runId: options.runId, projectRoot: cwd, writeEventsJsonl: true });
    if (options.json) {
      console.log(JSON.stringify({
        run,
        events_ref: `.forgekit/runs/${run.run_id}/events.jsonl`
      }, null, 2));
    } else {
      console.log(`Run: ${run.run_id}`);
      console.log(`Status: ${run.status}`);
      console.log(`Trace: .forgekit/runs/${run.run_id}/run.json`);
      console.log(`Events: .forgekit/runs/${run.run_id}/events.jsonl`);
    }
    if (run.status !== "completed") {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown run command: ${options.subcommand}`);
}
