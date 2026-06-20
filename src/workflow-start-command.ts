import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { buildWorkflowRunPlan, startWorkflowRun } from "./core.js";
import { formatRunPlan } from "./run-plan.js";

interface WorkflowStartOptions {
  workflowId?: string;
  input?: string;
  inputFile?: string;
  yes: boolean;
  json: boolean;
  planJson: boolean;
  help: boolean;
}

function parseStartArgs(args: string[]): WorkflowStartOptions {
  const options: WorkflowStartOptions = {
    yes: false,
    json: false,
    planJson: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") {
      options.input = args[index + 1];
      index += 1;
    } else if (arg === "--input-file") {
      options.inputFile = args[index + 1];
      index += 1;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--plan-json") {
      options.planJson = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (!options.workflowId) {
      options.workflowId = arg;
    } else {
      throw new Error(`Unknown workflow start option: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage:
  forge workflow start <workflow-id> --input <text> [--yes]
  forge workflow start <workflow-id> --input-file <path> [--yes]
  forge workflow start <workflow-id> --input <text> --plan-json
  forge workflow start <workflow-id> --input <text> --yes --json

Shows the run plan, records run trace, validates handoff JSON, writes output.md,
and self-corrects once when validation fails.`);
}

async function readTaskInput(options: WorkflowStartOptions): Promise<string> {
  if (options.input && options.inputFile) {
    throw new Error("Use either --input or --input-file, not both.");
  }
  if (options.input) return options.input;
  if (options.inputFile) return readFile(options.inputFile, "utf8");
  throw new Error("Missing task input. Use --input <text> or --input-file <path>.");
}

async function confirmRun(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("Use --yes for non-interactive workflow start confirmation.");
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = await readline.question("Continue? [y/N] ");
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

export async function runWorkflowStartCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const options = parseStartArgs(args);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.workflowId) {
    throw new Error("Usage: forge workflow start <workflow-id> --input <text>");
  }

  const taskInput = await readTaskInput(options);
  const plan = await buildWorkflowRunPlan({
    workflowId: options.workflowId,
    taskInput,
    projectRoot: cwd
  });

  if (options.planJson) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (options.json && !options.yes) {
    throw new Error("Use --yes with --json for workflow start.");
  }

  if (!options.json) {
    console.log(formatRunPlan(plan).trimEnd());
  }

  if (!options.yes && !(await confirmRun())) {
    console.log("Run cancelled.");
    return;
  }

  const run = await startWorkflowRun({
    workflowId: options.workflowId,
    taskInput,
    projectRoot: cwd,
    writeEventsJsonl: true
  });

  if (options.json) {
    console.log(JSON.stringify({
      plan,
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
}
