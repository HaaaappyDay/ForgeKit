import { isAbsolute, join, resolve } from "node:path";
import { readJsonFile } from "./json-file.js";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";

async function validateBySchema(schemaId, value, path) {
  const schema = await loadSchema(schemaId);
  const result = validateJson(schema, value);
  if (!result.valid) {
    throw new Error(`Invalid ${schemaId} at ${path}:\n${result.errors.join("\n")}`);
  }
}

export function resolveProjectPath(projectRoot, path) {
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

export async function loadProjectConfig(projectRoot = process.cwd()) {
  const path = join(projectRoot, ".forgekit/config.json");
  const config = await readJsonFile(path);
  await validateBySchema("forgekit.config.v1", config, path);
  return { config, path };
}

export async function loadAdapterConfig(adapterId, projectRoot = process.cwd()) {
  const { config } = await loadProjectConfig(projectRoot);
  const adapterPath = config.adapters[adapterId];
  if (!adapterPath) {
    throw new Error(`Unknown adapter id: ${adapterId}`);
  }

  const path = resolveProjectPath(projectRoot, adapterPath);
  const adapter = await readJsonFile(path);
  await validateBySchema("forgekit.adapter.v1", adapter, path);

  if (adapter.id !== adapterId) {
    throw new Error(`Adapter id mismatch: config requested ${adapterId}, file contains ${adapter.id}`);
  }

  return { adapter, path };
}

