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

export async function loadRoleConfig(roleId, projectRoot = process.cwd()) {
  const { config } = await loadProjectConfig(projectRoot);
  const roleEntry = config.roles[roleId];
  if (!roleEntry) {
    throw new Error(`Unknown role id: ${roleId}`);
  }

  const path = resolveProjectPath(projectRoot, roleEntry.definition);
  const role = await readJsonFile(path);
  await validateBySchema("forgekit.role.v1", role, path);

  if (role.id !== roleId) {
    throw new Error(`Role id mismatch: config requested ${roleId}, file contains ${role.id}`);
  }

  return { role, adapterId: roleEntry.adapter, path };
}

export async function loadWorkflowConfig(workflowId, projectRoot = process.cwd()) {
  const path = join(projectRoot, ".forgekit/workflows", `${workflowId}.json`);
  const workflow = await readJsonFile(path);
  await validateBySchema("forgekit.workflow.v1", workflow, path);

  if (workflow.id !== workflowId) {
    throw new Error(`Workflow id mismatch: requested ${workflowId}, file contains ${workflow.id}`);
  }

  return { workflow, path };
}

