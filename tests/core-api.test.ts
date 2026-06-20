import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  getRunArtifacts,
  getRunSnapshot,
  listRuns,
  readRunArtifact,
  startWorkflowRun
} from "../src/core.js";
import { runInitCommand } from "../src/init-command.js";
import { readJsonFile, writeJsonFile } from "../src/json-file.js";
import type { AdapterConfig, RunEvent } from "../src/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-core-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function patchAdapterCommand(projectRoot: string, adapterFile: string, command: string): Promise<void> {
  const path = join(projectRoot, ".forgekit/adapters", adapterFile);
  const adapter = await readJsonFile<AdapterConfig>(path);
  adapter.command = command;
  await writeJsonFile(path, adapter);
}

function fakeHandoffShellFunction(): string {
  return `handoff() {
  prompt="$1"
  run_id=$(printf "%s" "$prompt" | sed -n 's/^- run_id: //p' | head -n 1)
  step_id=$(printf "%s" "$prompt" | sed -n 's/^- step_id: //p' | head -n 1)
  if [ -z "$role_id" ]; then
    role_id=$(printf "%s" "$prompt" | sed -n 's/^- role_id: //p' | head -n 1)
  fi
  if [ -z "$step_id" ]; then
    step_id=$(printf "%s" "$prompt" | sed -n 's/^- id: //p' | sed -n '2p')
  fi
  if [ -z "$role_id" ]; then
    role_id=$(printf "%s" "$prompt" | sed -n 's/^- id: //p' | head -n 1)
  fi
  printf '{"schema_version":"handoff.v1","run_id":"%s","step_id":"%s","role_id":"%s","status":"completed","summary":"Valid handoff for %s","decisions":[],"assumptions":[],"risks":[],"open_questions":[],"out_of_scope":[],"markdown_body":"# Output for %s","next_handoff":{"recommended_role":"next","instructions":"Continue to the next step."},"artifacts":[]}
' "$run_id" "$step_id" "$role_id" "$step_id" "$step_id"
}
`;
}

function successfulAdapterScript(): string {
  return `#!/bin/sh
${fakeHandoffShellFunction()}
if [ "$1" = "-p" ]; then
  for last
  do
    prompt="$last"
  done
else
  prompt=$(cat)
fi
echo '{"type":"thread.started","thread_id":"core-codex-session"}'
echo '{"type":"system","subtype":"init","session_id":"core-claude-session"}'
handoff "$prompt"
exit 0
`;
}

test("core API starts a run with observer events and exposes artifacts", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const fakeAdapter = join(dir, "core-agent");
    await writeExecutable(fakeAdapter, successfulAdapterScript());
    await patchAdapterCommand(dir, "codex.json", fakeAdapter);
    await patchAdapterCommand(dir, "claude-code.json", fakeAdapter);

    const observed: RunEvent[] = [];
    const run = await startWorkflowRun({
      workflowId: "generic-plan-review",
      taskInput: "Plan a launch checklist",
      projectRoot: dir,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      eventObservers: [(event) => {
        observed.push(event);
      }],
      writeEventsJsonl: true
    });

    assert.equal(run.status, "completed");
    assert.ok(observed.some((event) => event.type === "run_completed"));

    const snapshot = await getRunSnapshot(run.run_id, dir);
    assert.equal(snapshot.run_id, run.run_id);

    const history = await listRuns(dir);
    assert.equal(history[0].run_id, run.run_id);

    const artifacts = await getRunArtifacts(run.run_id, dir);
    assert.ok(artifacts.some((artifact) => artifact.ref === "summary.md" && artifact.exists));
    assert.ok(artifacts.some((artifact) => artifact.type === "run_events" && artifact.exists));

    const summary = await readRunArtifact(run.run_id, "summary.md", dir);
    assert.match(summary.content, /# ForgeKit Run Summary/);
  });
});
