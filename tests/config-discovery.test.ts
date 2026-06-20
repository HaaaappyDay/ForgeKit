import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { listAdapters, listRoles, listWorkflows } from "../src/core.js";
import { runAdapterDiscoveryCommand, runWorkflowDiscoveryCommand } from "../src/discovery-command.js";
import { runInitCommand } from "../src/init-command.js";
import { readJsonFile, writeJsonFile } from "../src/json-file.js";
import { runRoleCommand } from "../src/role-command.js";
import type { AdapterConfig, RoleConfig, WorkflowConfig } from "../src/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-discovery-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function captureConsole(fn: () => Promise<void> | void): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

test("configuration discovery lists workflows, roles, and adapters", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--yes"], dir);

    const workflows = await listWorkflows(dir);
    assert.deepEqual(workflows.map((workflow) => workflow.id), ["feature-planning"]);
    assert.equal(workflows[0].validation.valid, true);

    const roles = await listRoles(dir);
    assert.ok(roles.some((role) => role.id === "pm" && role.adapter_id === "codex-local"));

    const adapters = await listAdapters(dir);
    assert.ok(adapters.some((adapter) => adapter.id === "codex-local" && adapter.command === "codex"));

    const workflowJson = await captureConsole(() => runWorkflowDiscoveryCommand(["list", "--json"], dir));
    assert.equal((JSON.parse(workflowJson) as Array<{ id: string }>)[0].id, "feature-planning");

    const roleJson = await captureConsole(() => runRoleCommand(["list", "--json"], dir));
    assert.ok((JSON.parse(roleJson) as Array<{ id: string }>).some((role) => role.id === "pm"));

    const adapterJson = await captureConsole(() => runAdapterDiscoveryCommand(["list", "--json"], dir));
    assert.ok((JSON.parse(adapterJson) as Array<{ id: string }>).some((adapter) => adapter.id === "codex-local"));
  });
});

test("configuration discovery reports invalid individual files without failing the list", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const workflowPath = join(dir, ".forgekit/workflows/generic-plan-review.json");
    const workflow = await readJsonFile<WorkflowConfig>(workflowPath);
    workflow.steps[0].next = ["review"];
    await writeJsonFile(workflowPath, workflow);

    const rolePath = join(dir, ".forgekit/roles/planner.json");
    const role = await readJsonFile<RoleConfig>(rolePath) as Partial<RoleConfig>;
    delete role.name;
    await writeJsonFile(rolePath, role);

    const adapterPath = join(dir, ".forgekit/adapters/codex.json");
    const adapter = await readJsonFile<AdapterConfig>(adapterPath) as Partial<AdapterConfig>;
    delete adapter.command;
    await writeJsonFile(adapterPath, adapter);

    const workflows = await listWorkflows(dir);
    assert.equal(workflows[0].validation.valid, false);
    assert.ok(workflows[0].validation.errors.some((error) => error.includes("MVP-0 supports only linear workflows")));

    const roles = await listRoles(dir);
    const planner = roles.find((candidate) => candidate.id === "planner");
    assert.ok(planner);
    assert.equal(planner.validation.valid, false);
    assert.ok(planner.validation.errors.some((error) => error.includes("name")));

    const adapters = await listAdapters(dir);
    const codex = adapters.find((candidate) => candidate.id === "codex-local");
    assert.ok(codex);
    assert.equal(codex.validation.valid, false);
    assert.ok(codex.validation.errors.some((error) => error.includes("command")));
  });
});
