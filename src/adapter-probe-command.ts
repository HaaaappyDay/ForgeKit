import { getAdapter, probeAdapter } from "./core.js";
import type { AdapterProbeResult } from "./types.js";

interface ProbeCommandOptions {
  adapterId?: string;
  json: boolean;
  help: boolean;
}

function parseProbeArgs(args: string[]): ProbeCommandOptions {
  const options: ProbeCommandOptions = {
    json: false,
    help: false
  };

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (!options.adapterId) {
      options.adapterId = arg;
    } else {
      throw new Error(`Unknown adapter probe option: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage:
  forge adapter probe <adapter-id> [--json]

Basic probe checks the adapter config, command resolution, lightweight startup,
and declared auth/billing/write policy. It does not validate structured output stability.

If the command cannot be found, set it with:
  forge adapter set-command <adapter-id> <command-or-path>`);
}

function printTextResult(result: AdapterProbeResult, adapterPath: string): void {
  console.log(`Adapter: ${result.adapter_id}`);
  console.log(`Type: ${result.adapter_type}`);
  console.log(`Config: ${adapterPath}`);
  console.log(`Command: ${result.command}`);
  console.log(`Resolved: ${result.resolved_command ?? "(not found)"}`);
  console.log("");
  console.log("Checks:");
  for (const check of result.checks) {
    console.log(`  ${check.status === "passed" ? "PASS" : "FAIL"} ${check.name}`);
    if (check.exit_code !== undefined) console.log(`    exit_code: ${check.exit_code}`);
    if (check.stdout) console.log(`    stdout: ${check.stdout.split("\n")[0]}`);
    if (check.stderr) console.log(`    stderr: ${check.stderr.split("\n")[0]}`);
    if (check.message) console.log(`    message: ${check.message}`);
    if (check.error) console.log(`    error: ${check.error}`);
  }
  console.log("");
  console.log("Auth & billing:");
  console.log(`  auth.mode: ${result.auth?.mode ?? "unknown"}`);
  console.log(`  billing.mode: ${result.billing?.mode ?? "unknown"}`);
  console.log(`  cost_tracking: ${result.billing?.cost_tracking ?? "unknown"}`);
  console.log("");
  console.log("Write policy:");
  console.log(`  default_mode: ${result.write_policy?.default_mode ?? "unknown"}`);
  console.log(`  enforcement: ${result.write_policy?.enforcement ?? "unknown"}`);
  if (result.notes?.length) {
    console.log("");
    console.log("Notes:");
    for (const note of result.notes) {
      console.log(`  - ${note}`);
    }
  }
  console.log("");
  console.log(`Result: ${result.ok ? "passed" : "failed"}`);
  if (!result.ok && !result.resolved_command) {
    console.log("");
    console.log("Next:");
    console.log(`  forge adapter set-command ${result.adapter_id} <command-or-path>`);
    console.log(`  forge adapter probe ${result.adapter_id}`);
  }
}

export async function runAdapterProbeCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const options = parseProbeArgs(args);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.adapterId) {
    throw new Error("Usage: forge adapter probe <adapter-id> [--json]");
  }

  const detail = await getAdapter(options.adapterId, cwd);
  const result = await probeAdapter(options.adapterId, cwd);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextResult(result, detail.path);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}
