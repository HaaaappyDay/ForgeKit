import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonSchema, SchemaId } from "./types.js";

function findRepoRoot(start: string): string {
  let current = start;
  while (!existsSync(join(current, "schemas"))) {
    const parent = dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
  return current;
}

const repoRoot = findRepoRoot(dirname(dirname(fileURLToPath(import.meta.url))));

const schemaEntries = [
  ["forgekit.adapter.v1", "schemas/adapter.schema.json"],
  ["forgekit.config.v1", "schemas/config.schema.json"],
  ["forgekit.role.v1", "schemas/role.schema.json"],
  ["forgekit.run.v1", "schemas/run.schema.json"],
  ["forgekit.workflow.v1", "schemas/workflow.schema.json"],
  ["handoff.v1", "schemas/handoff.schema.json"],
  ["workflow-summary.v1", "schemas/workflow-summary.schema.json"]
] as const satisfies ReadonlyArray<readonly [SchemaId, string]>;

const schemas = new Map<SchemaId, { id: SchemaId; file: string; absolutePath: string }>(
  schemaEntries.map(([id, file]) => [id, { id, file, absolutePath: join(repoRoot, file) }] as const)
);

export function isSchemaId(id: string): id is SchemaId {
  return schemas.has(id as SchemaId);
}

export function listSchemas(): Array<{ id: SchemaId; file: string }> {
  return [...schemas.values()].map(({ id, file }) => ({ id, file }));
}

export async function loadSchema(id: SchemaId): Promise<JsonSchema> {
  const entry = schemas.get(id);
  if (!entry) {
    throw new Error(`Unknown schema id: ${id}`);
  }
  return JSON.parse(await readFile(entry.absolutePath, "utf8")) as JsonSchema;
}

export function schemaPath(id: SchemaId): string {
  const entry = schemas.get(id);
  if (!entry) {
    throw new Error(`Unknown schema id: ${id}`);
  }
  return entry.absolutePath;
}

export async function schemaText(id: SchemaId): Promise<string> {
  const entry = schemas.get(id);
  if (!entry) {
    throw new Error(`Unknown schema id: ${id}`);
  }
  return readFile(entry.absolutePath, "utf8");
}
