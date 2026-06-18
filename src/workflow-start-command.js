import { readFile } from "node:fs/promises";
import { runWorkflow } from "./workflow-runner.js";

function parseStartArgs(args) {
  const options = {
    workflowId: undefined,
    input: undefined,
    inputFile: undefined,
    yes: false,
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

function printHelp() {
  console.log(`Usage:
  forge workflow start <workflow-id> --input <text> [--yes]
  forge workflow start <workflow-id> --input-file <path> [--yes]

Phase 4 records run trace and raw adapter logs. Handoff parsing and validation are implemented in later phases.`);
}

async function readTaskInput(options) {
  if (options.input && options.inputFile) {
    throw new Error("Use either --input or --input-file, not both.");
  }
  if (options.input) return options.input;
  if (options.inputFile) return readFile(options.inputFile, "utf8");
  throw new Error("Missing task input. Use --input <text> or --input-file <path>.");
}

export async function runWorkflowStartCommand(args, cwd = process.cwd()) {
  const options = parseStartArgs(args);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.workflowId) {
    throw new Error("Usage: forge workflow start <workflow-id> --input <text>");
  }

  const taskInput = await readTaskInput(options);
  if (!options.yes && process.stdin.isTTY) {
    throw new Error("Phase 4 requires --yes for non-interactive workflow start confirmation.");
  }

  const run = await runWorkflow({
    workflowId: options.workflowId,
    taskInput,
    projectRoot: cwd
  });

  console.log(`Run: ${run.run_id}`);
  console.log(`Status: ${run.status}`);
  console.log(`Trace: .forgekit/runs/${run.run_id}/run.json`);
  if (run.status !== "completed") {
    process.exitCode = 1;
  }
}

