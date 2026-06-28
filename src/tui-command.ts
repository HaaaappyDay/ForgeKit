import { getRunSnapshot } from "./core.js";
import { TuiShell, shellContext } from "./tui/shell.js";
import { FileMonitorFeed } from "./tui/monitor-feed.js";
import { MonitorScreen } from "./tui/screens/monitor.js";
import { HomeScreen } from "./tui/screens/home.js";
import type { Screen } from "./tui/screen.js";

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
  forge tui [<run-id>]

With no argument, opens the ForgeKit dashboard: start runs, monitor them live,
browse history, view config (read-only), probe adapters, and initialize a
project. With a <run-id>, attaches directly to that run's monitor (read-only),
following .forgekit/runs/<run-id>/events.jsonl. Works for linear and agentic,
in-progress and completed runs.

Note: runs started from the dashboard execute in this process; quitting the TUI
while they are still running asks for confirmation because it ends them. For
detached runs use 'forge workflow start' then attach with 'forge tui <run-id>'.`);
}

export async function runTuiCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return;
  }

  if (!process.stdout.isTTY) {
    console.error("forge tui requires an interactive terminal (TTY).");
    process.exitCode = 1;
    return;
  }

  const shell = new TuiShell({ projectRoot: cwd });
  const ctx = shellContext(shell);

  let initial: Screen;
  if (options.runId) {
    // Validate the run exists up front so a bad id fails before entering the
    // alt screen (back-compat with the v1 direct-attach behavior).
    await getRunSnapshot(options.runId, cwd);
    const feed = new FileMonitorFeed({ runId: options.runId, projectRoot: cwd });
    initial = new MonitorScreen(ctx, feed, { source: "attached" });
  } else {
    initial = new HomeScreen(ctx);
  }

  const onSigint = () => {
    void shell.requestQuit();
  };
  const onSigterm = () => shell.stop();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    await shell.run(initial);
  } finally {
    shell.stop();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
