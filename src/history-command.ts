import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isNodeErrorCode } from "./node-error.js";
import { readRun } from "./run-store.js";
import type { Run } from "./types.js";

async function listRunIds(projectRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(projectRoot, ".forgekit/runs"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

export async function loadRunHistory(projectRoot = process.cwd()): Promise<Run[]> {
  const runs: Run[] = [];
  for (const runId of await listRunIds(projectRoot)) {
    try {
      runs.push(await readRun(projectRoot, runId));
    } catch {
      // Ignore incomplete or manually corrupted run directories in the list view.
    }
  }
  return runs.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export async function runHistoryCommand(_args: string[], cwd = process.cwd()): Promise<void> {
  const runs = await loadRunHistory(cwd);
  if (runs.length === 0) {
    console.log("No ForgeKit runs found.");
    return;
  }

  for (const run of runs) {
    console.log(`${run.run_id}\t${run.status}\t${run.workflow_id}\t${run.updated_at}`);
  }
}
