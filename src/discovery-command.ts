import {
  getAdapter,
  getWorkflow,
  listAdapters,
  listWorkflows
} from "./core.js";
import { writeJsonFile } from "./json-file.js";
import { loadAdapterConfig } from "./project-config.js";

interface DiscoveryOptions {
  subcommand?: string;
  id?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(args: string[]): DiscoveryOptions {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  return {
    subcommand: positional[0],
    id: positional[1],
    json: args.includes("--json"),
    help: args.includes("--help") || args.includes("-h")
  };
}

function printWorkflowHelp(): void {
  console.log(`Usage:
  forge workflow list [--json]
  forge workflow show <workflow-id> [--json]
  forge workflow start [<workflow-id>] --input <text> [--yes]`);
}

function printAdapterHelp(): void {
  console.log(`Usage:
  forge adapter list [--json]
  forge adapter show <adapter-id> [--json]
  forge adapter probe <adapter-id> [--json]
  forge adapter set-command <adapter-id> <command>`);
}

export async function runWorkflowDiscoveryCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const options = parseArgs(args);
  if (options.help || !options.subcommand) {
    printWorkflowHelp();
    return;
  }

  if (options.subcommand === "list") {
    const workflows = await listWorkflows(cwd);
    if (options.json) {
      console.log(JSON.stringify(workflows, null, 2));
      return;
    }
    if (workflows.length === 0) {
      console.log("No workflows found.");
      return;
    }
    for (const workflow of workflows) {
      console.log(`${workflow.id}\t${workflow.validation.valid ? "valid" : "invalid"}\t${workflow.step_count}\t${workflow.path}`);
    }
    return;
  }

  if (options.subcommand === "show") {
    if (!options.id) {
      throw new Error("Usage: forge workflow show <workflow-id> [--json]");
    }
    const workflow = await getWorkflow(options.id, cwd);
    if (options.json) {
      console.log(JSON.stringify(workflow, null, 2));
      return;
    }
    console.log(`Workflow: ${workflow.id}`);
    console.log(`Path: ${workflow.path}`);
    console.log(`Valid: ${workflow.validation.valid ? "yes" : "no"}`);
    for (const error of workflow.validation.errors) {
      console.log(`  error: ${error}`);
    }
    return;
  }

  throw new Error(`Unknown workflow command: ${options.subcommand}`);
}

export async function runAdapterDiscoveryCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const options = parseArgs(args);
  if (options.help || !options.subcommand) {
    printAdapterHelp();
    return;
  }

  if (options.subcommand === "list") {
    const adapters = await listAdapters(cwd);
    if (options.json) {
      console.log(JSON.stringify(adapters, null, 2));
      return;
    }
    if (adapters.length === 0) {
      console.log("No adapters found.");
      return;
    }
    for (const adapter of adapters) {
      console.log(`${adapter.id}\t${adapter.validation.valid ? "valid" : "invalid"}\t${adapter.type}\t${adapter.command}`);
    }
    return;
  }

  if (options.subcommand === "show") {
    if (!options.id) {
      throw new Error("Usage: forge adapter show <adapter-id> [--json]");
    }
    const adapter = await getAdapter(options.id, cwd);
    if (options.json) {
      console.log(JSON.stringify(adapter, null, 2));
      return;
    }
    console.log(`Adapter: ${adapter.id}`);
    console.log(`Path: ${adapter.path}`);
    console.log(`Valid: ${adapter.validation.valid ? "yes" : "no"}`);
    for (const error of adapter.validation.errors) {
      console.log(`  error: ${error}`);
    }
    return;
  }

  if (options.subcommand === "set-command") {
    if (!options.id) {
      throw new Error("Usage: forge adapter set-command <adapter-id> <command>");
    }
    const command = args[2];
    if (!command || args.length > 3) {
      throw new Error("Usage: forge adapter set-command <adapter-id> <command>");
    }
    const { adapter, path } = await loadAdapterConfig(options.id, cwd);
    const previous = adapter.command;
    await writeJsonFile(path, { ...adapter, command });
    console.log(`Adapter: ${adapter.id}`);
    console.log(`Config: ${path}`);
    console.log(`Command: ${previous} -> ${command}`);
    console.log(`Next: forge adapter probe ${adapter.id}`);
    return;
  }

  throw new Error(`Unknown adapter command: ${options.subcommand}`);
}
