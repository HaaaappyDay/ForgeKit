import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInitCommand } from "../src/init-command.js";
import { readJsonFile, writeJsonFile } from "../src/json-file.js";
import { runWorkflow } from "../src/workflow-runner.js";
import type { AdapterConfig, RunEvent } from "../src/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-errors-"));
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

function readJsonlEvents(text: string): RunEvent[] {
  return text.trim().split(/\r?\n/).map((line) => JSON.parse(line) as RunEvent);
}

test("missing adapter command records adapter_command_not_found in events", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);
    await patchAdapterCommand(dir, "codex.json", "definitely-missing-forgekit-agent");

    const run = await runWorkflow({
      workflowId: "generic-plan-review",
      taskInput: "Plan a launch checklist",
      projectRoot: dir,
      env: { PATH: "/usr/bin:/bin", HOME: dir },
      writeEventsJsonl: true
    });

    assert.equal(run.status, "failed");
    assert.equal(run.steps[0].attempts[0].error_code, "adapter_command_not_found");
    const events = readJsonlEvents(await readFile(join(dir, ".forgekit/runs", run.run_id, "events.jsonl"), "utf8"));
    assert.ok(events.some((event) => (
      event.type === "adapter_invocation_completed" &&
      event.data.error_code === "adapter_command_not_found"
    )));
    assert.equal(events.at(-1)?.type, "run_failed");
  });
});

test("invalid handoff output records handoff_parse_failed in events", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const invalidAdapter = join(dir, "invalid-handoff-agent");
    await writeExecutable(
      invalidAdapter,
      `#!/bin/sh
echo '{"type":"thread.started","thread_id":"invalid-handoff-session"}'
echo 'not a handoff'
exit 0
`
    );
    await patchAdapterCommand(dir, "codex.json", invalidAdapter);
    await patchAdapterCommand(dir, "claude-code.json", invalidAdapter);

    const run = await runWorkflow({
      workflowId: "generic-plan-review",
      taskInput: "Plan a launch checklist",
      projectRoot: dir,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      writeEventsJsonl: true
    });

    assert.equal(run.status, "failed");
    assert.equal(run.steps[0].attempts[0].error_code, "handoff_parse_failed");
    const events = readJsonlEvents(await readFile(join(dir, ".forgekit/runs", run.run_id, "events.jsonl"), "utf8"));
    assert.ok(events.some((event) => (
      event.type === "validation_completed" &&
      event.data.error_code === "handoff_parse_failed"
    )));
    assert.equal(events.at(-1)?.type, "run_failed");
  });
});
