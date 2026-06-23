import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadSchema, listSchemas } from "../src/schema-registry.js";
import { validateJson } from "../src/schema-validator.js";
import type { SchemaId } from "../src/types.js";

const validFixtures: Record<SchemaId, string> = {
  "forgekit.adapter.v1": "tests/fixtures/valid/adapter-codex.json",
  "forgekit.config.v1": "tests/fixtures/valid/config.json",
  "forgekit.role.v1": "tests/fixtures/valid/role-planner.json",
  "forgekit.run-event.v1": "tests/fixtures/valid/run-event.json",
  "forgekit.run.v1": "tests/fixtures/valid/run.json",
  "forgekit.workflow.v1": "tests/fixtures/valid/workflow-feature-planning.json",
  "handoff.v1": "tests/fixtures/valid/handoff.json",
  "workflow-summary.v1": "tests/fixtures/valid/workflow-summary.json",
  "forgekit.workflow.v2": "tests/fixtures/valid/workflow-feature-planning-agentic.json",
  "handoff.v2": "tests/fixtures/valid/handoff-agentic.json",
  "acceptance-verdict.v1": "tests/fixtures/valid/acceptance-verdict.json",
  "forgekit.run.v2": "tests/fixtures/valid/run-agentic.json"
};

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

test("registry exposes every Phase 1 schema", () => {
  const ids = listSchemas().map((schema) => schema.id);
  assert.deepEqual(ids, Object.keys(validFixtures));
});

for (const [schemaId, fixturePath] of Object.entries(validFixtures) as Array<[SchemaId, string]>) {
  test(`${schemaId} accepts its valid fixture`, async () => {
    const schema = await loadSchema(schemaId);
    const fixture = await readJson(fixturePath);
    const result = validateJson(schema, fixture);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });
}

test("handoff.v1 requires markdown_body", async () => {
  const schema = await loadSchema("handoff.v1");
  const fixture = await readJson("tests/fixtures/invalid/handoff-missing-markdown.json");
  const result = validateJson(schema, fixture);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("markdown_body")));
});

test("forgekit.workflow.v2 rejects non-agentic mode", async () => {
  const schema = await loadSchema("forgekit.workflow.v2");
  const fixture = await readJson("tests/fixtures/invalid/workflow-v2-bad-mode.json");
  const result = validateJson(schema, fixture);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes(".mode")));
});

test("handoff.v2 rejects unknown next_handoff kind", async () => {
  const schema = await loadSchema("handoff.v2");
  const fixture = await readJson("tests/fixtures/invalid/handoff-v2-bad-kind.json");
  const result = validateJson(schema, fixture);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("next_handoff.kind")));
});

test("acceptance-verdict.v1 rejects unknown verdict", async () => {
  const schema = await loadSchema("acceptance-verdict.v1");
  const fixture = await readJson("tests/fixtures/invalid/acceptance-verdict-bad-verdict.json");
  const result = validateJson(schema, fixture);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes(".verdict")));
});

test("forgekit.run.v2 rejects unknown status", async () => {
  const schema = await loadSchema("forgekit.run.v2");
  const fixture = await readJson("tests/fixtures/invalid/run-v2-bad-status.json");
  const result = validateJson(schema, fixture);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes(".status")));
});
