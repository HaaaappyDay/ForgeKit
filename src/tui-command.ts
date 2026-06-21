import { getRunSnapshot } from "./core.js";
import { isAgenticRun } from "./run-store.js";
import { RunMonitorApp } from "./tui/app.js";

interface TuiCommandOptions {
  runId?: string;
  help: boolean;
}

function parseArgs(args: string[]): TuiCommandOptions {
  return {
    runId: args.find((arg) => !arg.startsWith("-")),
    help: args.includes("--help") || args.includes("-h")
  };
}

function printHelp(): void {
  console.log(`Usage:
  forge tui <run-id>

Read-only real-time monitor for a linear run. Attaches to an existing run,
follows .forgekit/runs/<run-id>/events.jsonl, and lets you browse step
artifacts. Works for in-progress and completed runs.`);
}

export async function runTuiCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const options = parseArgs(args);
  if (options.help || !options.runId) {
    printHelp();
    if (!options.runId && !options.help) process.exitCode = 2;
    return;
  }

  const run = await getRunSnapshot(options.runId, cwd);
  if (isAgenticRun(run)) {
    console.error(
      `Run ${options.runId} is an agentic run. The v1 monitor only supports linear (forgekit.run.v1) runs.`
    );
    process.exitCode = 1;
    return;
  }

  if (!process.stdout.isTTY) {
    console.error("forge tui requires an interactive terminal (TTY).");
    process.exitCode = 1;
    return;
  }

  const app = new RunMonitorApp({ runId: options.runId, projectRoot: cwd });
  const onSignal = () => app.stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await app.mount();
  } finally {
    app.stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
