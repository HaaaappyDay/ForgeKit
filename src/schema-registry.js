import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const schemaEntries = [
  ["forgekit.adapter.v1", "schemas/adapter.schema.json"],
  ["forgekit.config.v1", "schemas/config.schema.json"],
  ["forgekit.role.v1", "schemas/role.schema.json"],
  ["forgekit.run.v1", "schemas/run.schema.json"],
  ["forgekit.workflow.v1", "schemas/workflow.schema.json"],
  ["handoff.v1", "schemas/handoff.schema.json"],
  ["workflow-summary.v1", "schemas/workflow-summary.schema.json"]
];

const schemas = new Map(
  schemaEntries.map(([id, file]) => [id, { id, file, absolutePath: join(repoRoot, file) }])
);

export function listSchemas() {
  return [...schemas.values()].map(({ id, file }) => ({ id, file }));
}

export async function loadSchema(id) {
  const entry = schemas.get(id);
  if (!entry) {
    throw new Error(`Unknown schema id: ${id}`);
  }
  return JSON.parse(await readFile(entry.absolutePath, "utf8"));
}

export function schemaPath(id) {
  const entry = schemas.get(id);
  if (!entry) {
    throw new Error(`Unknown schema id: ${id}`);
  }
  return entry.absolutePath;
}

export async function schemaText(id) {
  const entry = schemas.get(id);
  if (!entry) {
    throw new Error(`Unknown schema id: ${id}`);
  }
  return readFile(entry.absolutePath, "utf8");
}

