#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { runAdapterProbeCommand } from "./adapter-probe-command.js";
import { runInitCommand } from "./init-command.js";
import { listSchemas, loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import { runWorkflowStartCommand } from "./workflow-start-command.js";

const args = process.argv.slice(2);

function printHelp() {
  console.log(`ForgeKit

Usage:
  forge --help
  forge init [--template <id>] [--project-name <name>] [--yes] [--force]
  forge adapter probe <adapter-id> [--json]
  forge workflow start <workflow-id> --input <text> [--yes]
  forge schema list
  forge schema validate <schema-id> <json-file>

MVP-0 commands such as init, workflow start, adapter probe, history, and run show
will be implemented in later phases.`);
}

function fail(message, code = 1) {
  console.error(message);
  process.exitCode = code;
}

async function readJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

async function main() {
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

  if (args[0] === "workflow" && args[1] === "start") {
    await runWorkflowStartCommand(args.slice(2));
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
  fail(error instanceof Error ? error.message : String(error));
});
