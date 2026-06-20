import { isAbsolute, join, resolve } from "node:path";
import { ForgeKitError, type ForgeKitErrorShape } from "./errors.js";
import { readJsonFile } from "./json-file.js";
import { isNodeErrorCode } from "./node-error.js";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import type { AdapterConfig, ProjectConfig, RoleConfig, SchemaId, WorkflowConfig } from "./types.js";

function invalidConfigCode(schemaId: SchemaId): Pick<ForgeKitErrorShape, "code" | "category"> {
  if (schemaId === "forgekit.workflow.v1") {
    return {
      code: "workflow_invalid",
      category: "workflow"
    };
  }
  return {
    code: "config_invalid",
    category: "config"
  };
}

async function validateBySchema(schemaId: SchemaId, value: unknown, path: string): Promise<void> {
  const schema = await loadSchema(schemaId);
  const result = validateJson(schema, value);
  if (!result.valid) {
    const code = invalidConfigCode(schemaId);
    throw new ForgeKitError({
      ...code,
      retryable: false,
      message: `Invalid ${schemaId} at ${path}:\n${result.errors.join("\n")}`,
      details: {
        schema_id: schemaId,
        path,
        errors: result.errors
      }
    });
  }
}

export function resolveProjectPath(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

export async function loadProjectConfig(
  projectRoot = process.cwd()
): Promise<{ config: ProjectConfig; path: string }> {
  const path = join(projectRoot, ".forgekit/config.json");
  let config: ProjectConfig;
  try {
    config = await readJsonFile<ProjectConfig>(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ForgeKitError({
        code: "config_missing",
        message: `ForgeKit config not found: ${path}`,
        category: "config",
        retryable: false,
        details: { path }
      });
    }
    if (error instanceof SyntaxError) {
      throw new ForgeKitError({
        code: "config_invalid",
        message: `Invalid JSON at ${path}: ${error.message}`,
        category: "config",
        retryable: false,
        details: { path }
      });
    }
    throw error;
  }
  await validateBySchema("forgekit.config.v1", config, path);
  return { config, path };
}

export async function loadAdapterConfig(
  adapterId: string,
  projectRoot = process.cwd()
): Promise<{ adapter: AdapterConfig; path: string }> {
  const { config } = await loadProjectConfig(projectRoot);
  const adapterPath = config.adapters[adapterId];
  if (!adapterPath) {
    throw new ForgeKitError({
      code: "adapter_missing",
      message: `Unknown adapter id: ${adapterId}`,
      category: "adapter",
      retryable: false,
      details: { adapter_id: adapterId }
    });
  }

  const path = resolveProjectPath(projectRoot, adapterPath);
  let adapter: AdapterConfig;
  try {
    adapter = await readJsonFile<AdapterConfig>(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ForgeKitError({
        code: "adapter_missing",
        message: `Adapter config not found: ${path}`,
        category: "adapter",
        retryable: false,
        details: { adapter_id: adapterId, path }
      });
    }
    if (error instanceof SyntaxError) {
      throw new ForgeKitError({
        code: "config_invalid",
        message: `Invalid JSON at ${path}: ${error.message}`,
        category: "config",
        retryable: false,
        details: { adapter_id: adapterId, path }
      });
    }
    throw error;
  }
  await validateBySchema("forgekit.adapter.v1", adapter, path);

  if (adapter.id !== adapterId) {
    throw new ForgeKitError({
      code: "config_invalid",
      message: `Adapter id mismatch: config requested ${adapterId}, file contains ${adapter.id}`,
      category: "config",
      retryable: false,
      details: { adapter_id: adapterId, path, file_adapter_id: adapter.id }
    });
  }

  return { adapter, path };
}

export async function loadRoleConfig(
  roleId: string,
  projectRoot = process.cwd()
): Promise<{ role: RoleConfig; adapterId: string; path: string }> {
  const { config } = await loadProjectConfig(projectRoot);
  const roleEntry = config.roles[roleId];
  if (!roleEntry) {
    throw new ForgeKitError({
      code: "role_missing",
      message: `Unknown role id: ${roleId}`,
      category: "role",
      retryable: false,
      details: { role_id: roleId }
    });
  }

  const path = resolveProjectPath(projectRoot, roleEntry.definition);
  let role: RoleConfig;
  try {
    role = await readJsonFile<RoleConfig>(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ForgeKitError({
        code: "role_missing",
        message: `Role config not found: ${path}`,
        category: "role",
        retryable: false,
        details: { role_id: roleId, path }
      });
    }
    if (error instanceof SyntaxError) {
      throw new ForgeKitError({
        code: "config_invalid",
        message: `Invalid JSON at ${path}: ${error.message}`,
        category: "config",
        retryable: false,
        details: { role_id: roleId, path }
      });
    }
    throw error;
  }
  await validateBySchema("forgekit.role.v1", role, path);

  if (role.id !== roleId) {
    throw new ForgeKitError({
      code: "config_invalid",
      message: `Role id mismatch: config requested ${roleId}, file contains ${role.id}`,
      category: "config",
      retryable: false,
      details: { role_id: roleId, path, file_role_id: role.id }
    });
  }

  return { role, adapterId: roleEntry.adapter, path };
}

export async function loadWorkflowConfig(
  workflowId: string,
  projectRoot = process.cwd()
): Promise<{ workflow: WorkflowConfig; path: string }> {
  const path = join(projectRoot, ".forgekit/workflows", `${workflowId}.json`);
  let workflow: WorkflowConfig;
  try {
    workflow = await readJsonFile<WorkflowConfig>(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ForgeKitError({
        code: "workflow_invalid",
        message: `Workflow config not found: ${path}`,
        category: "workflow",
        retryable: false,
        details: { workflow_id: workflowId, path }
      });
    }
    if (error instanceof SyntaxError) {
      throw new ForgeKitError({
        code: "workflow_invalid",
        message: `Invalid JSON at ${path}: ${error.message}`,
        category: "workflow",
        retryable: false,
        details: { workflow_id: workflowId, path }
      });
    }
    throw error;
  }
  await validateBySchema("forgekit.workflow.v1", workflow, path);

  if (workflow.id !== workflowId) {
    throw new ForgeKitError({
      code: "workflow_invalid",
      message: `Workflow id mismatch: requested ${workflowId}, file contains ${workflow.id}`,
      category: "workflow",
      retryable: false,
      details: { workflow_id: workflowId, path, file_workflow_id: workflow.id }
    });
  }

  return { workflow, path };
}
