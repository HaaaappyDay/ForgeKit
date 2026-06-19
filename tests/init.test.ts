import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInitCommand } from "../src/init-command.js";
import { readJsonFile } from "../src/json-file.js";
import { loadSchema } from "../src/schema-registry.js";
import { validateJson } from "../src/schema-validator.js";
import type { ProjectConfig, SchemaId, WorkflowConfig } from "../src/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-init-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function assertValidJson<T>(schemaId: SchemaId, path: string): Promise<T> {
  const schema = await loadSchema(schemaId);
  const value = await readJsonFile<T>(path);
  const result = validateJson(schema, value);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  return value;
}

test("init creates feature-planning template", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "feature-planning", "--project-name", "demo", "--yes"], dir);

    const config = await assertValidJson<ProjectConfig>("forgekit.config.v1", join(dir, ".forgekit/config.json"));
    assert.equal(config.project.name, "demo");
    assert.equal(config.defaults.workflow, "feature-planning");
    assert.deepEqual(Object.keys(config.roles), ["pm", "architect", "engineer", "qa"]);

    await assertValidJson("forgekit.workflow.v1", join(dir, ".forgekit/workflows/feature-planning.json"));
    await assertValidJson("forgekit.role.v1", join(dir, ".forgekit/roles/pm.json"));
    await assertValidJson("forgekit.adapter.v1", join(dir, ".forgekit/adapters/codex.json"));
    await assertValidJson("forgekit.adapter.v1", join(dir, ".forgekit/adapters/claude-code.json"));
  });
});

test("init creates generic-plan-review template", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "generic-plan-review", "--yes"], dir);

    const config = await assertValidJson<ProjectConfig>("forgekit.config.v1", join(dir, ".forgekit/config.json"));
    assert.equal(config.defaults.workflow, "generic-plan-review");
    assert.deepEqual(Object.keys(config.roles), ["planner", "specialist", "reviewer"]);

    const workflow = await assertValidJson<WorkflowConfig>(
      "forgekit.workflow.v1",
      join(dir, ".forgekit/workflows/generic-plan-review.json")
    );
    assert.deepEqual(
      workflow.steps.map((step) => step.id),
      ["plan", "specialist-analysis", "review"]
    );
  });
});

test("init creates schema-valid blank workspace with examples only", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "blank", "--yes"], dir);

    const config = await assertValidJson<ProjectConfig>("forgekit.config.v1", join(dir, ".forgekit/config.json"));
    assert.equal(config.defaults.workflow, "custom-workflow");
    assert.deepEqual(config.roles, {});

    assert.deepEqual(await readdir(join(dir, ".forgekit/roles")), []);
    assert.deepEqual(await readdir(join(dir, ".forgekit/workflows")), []);
    await assertValidJson("forgekit.role.v1", join(dir, ".forgekit/examples/roles/example-role.json"));
    await assertValidJson("forgekit.workflow.v1", join(dir, ".forgekit/examples/workflows/custom-workflow.json"));
  });
});

test("init refuses to overwrite an existing .forgekit without --force", async () => {
  await withTempProject(async (dir) => {
    await runInitCommand(["--template", "blank", "--yes"], dir);

    await assert.rejects(
      () => runInitCommand(["--template", "feature-planning", "--yes"], dir),
      /\.forgekit already exists/
    );

    const configText = await readFile(join(dir, ".forgekit/config.json"), "utf8");
    assert.match(configText, /custom-workflow/);
  });
});
