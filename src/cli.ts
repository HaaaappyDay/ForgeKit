#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { runAdapterProbeCommand } from "./adapter-probe-command.js";
import { runAdapterDiscoveryCommand, runWorkflowDiscoveryCommand } from "./discovery-command.js";
import { errorResponse } from "./errors.js";
import { runHistoryCommand } from "./history-command.js";
import { runInitCommand } from "./init-command.js";
import { runRoleCommand } from "./role-command.js";
import { runRunCommand } from "./run-command.js";
import { isSchemaId, listSchemas, loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import { runTuiCommand } from "./tui-command.js";
import { runWorkflowStartCommand } from "./workflow-start-command.js";

const args = process.argv.slice(2);

function printHelp(): void {
  console.log(`ForgeKit

Usage:
  forge --help
  forge init [--template <id>] [--project-name <name>] [--yes] [--force]
  forge adapter probe <adapter-id> [--json]
  forge adapter list [--json]
  forge adapter show <adapter-id> [--json]
  forge workflow start <workflow-id> --input <text> [--yes]
  forge workflow list [--json]
  forge workflow show <workflow-id> [--json]
  forge history [--json]
  forge run show <run-id> [--json]
  forge run retry <run-id> [--json]
  forge role list [--json]
  forge role show <role-id> [--json]
  forge role path <role-id>
  forge tui <run-id>
  forge schema list
  forge schema validate <schema-id> <json-file>
`);
}

function fail(message: string, code = 1): void {
  console.error(message);
  process.exitCode = code;
}

function wantsJsonOutput(): boolean {
  return args.includes("--json") || args.includes("--plan-json");
}

function failError(error: unknown): void {
  if (wantsJsonOutput()) {
    console.error(JSON.stringify(errorResponse(error), null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as unknown;
}

async function main(): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  if (args[0] === "init") {
    await runInitCommand(args.slice(1));
    return;
  }

  if (args[0] === "adapter" && args[1] === "probe") {
    await runAdapterProbeCommand(args.slice(2));
    return;
  }

  if (args[0] === "adapter") {
    await runAdapterDiscoveryCommand(args.slice(1));
    return;
  }

  if (args[0] === "workflow" && args[1] === "start") {
    await runWorkflowStartCommand(args.slice(2));
    return;
  }

  if (args[0] === "workflow") {
    await runWorkflowDiscoveryCommand(args.slice(1));
    return;
  }

  if (args[0] === "history") {
    await runHistoryCommand(args.slice(1));
    return;
  }

  if (args[0] === "run") {
    await runRunCommand(args.slice(1));
    return;
  }

  if (args[0] === "role") {
    await runRoleCommand(args.slice(1));
    return;
  }

  if (args[0] === "tui") {
    await runTuiCommand(args.slice(1));
    return;
  }

  if (args[0] !== "schema") {
    fail(`Command not implemented: ${args.join(" ")}`, 2);
    return;
  }

  const schemaCommand = args[1];

  if (schemaCommand === "list") {
    for (const schema of listSchemas()) {
      console.log(`${schema.id}\t${schema.file}`);
    }
    return;
  }

  if (schemaCommand === "validate") {
    const [, , schemaId, jsonFile] = args;
    if (!schemaId || !jsonFile) {
      fail("Usage: forge schema validate <schema-id> <json-file>", 2);
      return;
    }
    if (!isSchemaId(schemaId)) {
      throw new Error(`Unknown schema id: ${schemaId}`);
    }

    const schema = await loadSchema(schemaId);
    const value = await readJson(jsonFile);
    const result = validateJson(schema, value);
    if (!result.valid) {
      for (const error of result.errors) {
        console.error(error);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`valid: ${schemaId} ${jsonFile}`);
    return;
  }

  fail(`Unknown schema command: ${schemaCommand ?? ""}`, 2);
}

main().catch((error) => {
  failError(error);
});
