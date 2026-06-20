import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ForgeKitError } from "./errors.js";
import { isNodeErrorCode } from "./node-error.js";
import { loadProjectConfig, resolveProjectPath } from "./project-config.js";
import { validateLinearWorkflow } from "./run-plan.js";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import type {
  AdapterConfig,
  AdapterDiscoveryEntry,
  ConfigDetail,
  ConfigDiscoveryValidation,
  RoleConfig,
  RoleDiscoveryEntry,
  SchemaId,
  WorkflowConfig,
  WorkflowDiscoveryEntry
} from "./types.js";

interface ParsedConfig<T> {
  config: T | null;
  validation: ConfigDiscoveryValidation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function fileId(path: string): string {
  return basename(path).replace(/\.json$/i, "");
}

async function readAndValidateConfig<T>(
  path: string,
  schemaId: SchemaId,
  extraValidation?: (config: T) => string[]
): Promise<ParsedConfig<T>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        config: null,
        validation: {
          valid: false,
          errors: [`Invalid JSON at ${path}: ${error.message}`]
        }
      };
    }
    if (isNodeErrorCode(error, "ENOENT")) {
      return {
        config: null,
        validation: {
          valid: false,
          errors: [`File not found: ${path}`]
        }
      };
    }
    throw error;
  }

  const schema = await loadSchema(schemaId);
  const result = validateJson(schema, parsed);
  const errors = [...result.errors];
  if (result.valid && extraValidation) {
    errors.push(...extraValidation(parsed as T));
  }
  return {
    config: result.valid ? parsed as T : null,
    validation: {
      valid: errors.length === 0,
      errors
    }
  };
}

async function listJsonFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(path, entry.name))
      .sort();
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

function workflowEntry(path: string, parsed: ParsedConfig<WorkflowConfig>): WorkflowDiscoveryEntry {
  const value = parsed.config ?? {};
  return {
    id: isRecord(value) ? stringValue(value.id, fileId(path)) : fileId(path),
    name: isRecord(value) ? stringValue(value.name) : "",
    version: isRecord(value) ? stringValue(value.version) : "",
    step_count: isRecord(value) && Array.isArray(value.steps) ? value.steps.length : 0,
    path,
    validation: parsed.validation
  };
}

function roleEntry(
  roleId: string,
  adapterId: string,
  path: string,
  parsed: ParsedConfig<RoleConfig>
): RoleDiscoveryEntry {
  const value = parsed.config ?? {};
  const writePolicy = isRecord(value) && isRecord(value.write_policy) ? stringValue(value.write_policy.mode) : "";
  return {
    id: isRecord(value) ? stringValue(value.id, roleId) : roleId,
    name: isRecord(value) ? stringValue(value.name) : "",
    adapter_id: adapterId,
    write_policy: writePolicy,
    path,
    validation: parsed.validation
  };
}

function adapterEntry(adapterId: string, path: string, parsed: ParsedConfig<AdapterConfig>): AdapterDiscoveryEntry {
  const value = parsed.config ?? {};
  const auth = isRecord(value) && isRecord(value.auth) ? stringValue(value.auth.mode) : "";
  const billing = isRecord(value) && isRecord(value.billing) ? stringValue(value.billing.mode) : "";
  const writePolicy = isRecord(value) && isRecord(value.write_policy) ? stringValue(value.write_policy.default_mode) : "";
  return {
    id: isRecord(value) ? stringValue(value.id, adapterId) : adapterId,
    type: isRecord(value) ? stringValue(value.type) : "",
    command: isRecord(value) ? stringValue(value.command) : "",
    auth,
    billing,
    write_policy: writePolicy,
    path,
    validation: parsed.validation
  };
}

export async function listWorkflows(projectRoot = process.cwd()): Promise<WorkflowDiscoveryEntry[]> {
  const workflowDir = join(projectRoot, ".forgekit/workflows");
  const entries: WorkflowDiscoveryEntry[] = [];
  for (const path of await listJsonFiles(workflowDir)) {
    const parsed = await readAndValidateConfig<WorkflowConfig>(
      path,
      "forgekit.workflow.v1",
      (workflow) => {
        const errors: string[] = [];
        if (workflow.id !== fileId(path)) {
          errors.push(`Workflow id mismatch: file ${fileId(path)} contains ${workflow.id}`);
        }
        try {
          validateLinearWorkflow(workflow);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        return errors;
      }
    );
    entries.push(workflowEntry(path, parsed));
  }
  return entries;
}

export async function getWorkflow(id: string, projectRoot = process.cwd()): Promise<ConfigDetail<WorkflowConfig>> {
  const path = join(projectRoot, ".forgekit/workflows", `${id}.json`);
  const parsed = await readAndValidateConfig<WorkflowConfig>(
    path,
    "forgekit.workflow.v1",
    (workflow) => {
      const errors: string[] = [];
      if (workflow.id !== id) errors.push(`Workflow id mismatch: requested ${id}, file contains ${workflow.id}`);
      try {
        validateLinearWorkflow(workflow);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      return errors;
    }
  );
  return {
    id,
    path,
    config: parsed.config,
    validation: parsed.validation
  };
}

export async function listRoles(projectRoot = process.cwd()): Promise<RoleDiscoveryEntry[]> {
  const { config } = await loadProjectConfig(projectRoot);
  const entries: RoleDiscoveryEntry[] = [];
  for (const [roleId, roleConfig] of Object.entries(config.roles).sort(([left], [right]) => left.localeCompare(right))) {
    const path = resolveProjectPath(projectRoot, roleConfig.definition);
    const parsed = await readAndValidateConfig<RoleConfig>(
      path,
      "forgekit.role.v1",
      (role) => role.id === roleId ? [] : [`Role id mismatch: config requested ${roleId}, file contains ${role.id}`]
    );
    entries.push(roleEntry(roleId, roleConfig.adapter, path, parsed));
  }
  return entries;
}

export async function getRole(id: string, projectRoot = process.cwd()): Promise<ConfigDetail<RoleConfig>> {
  const { config } = await loadProjectConfig(projectRoot);
  const roleConfig = config.roles[id];
  if (!roleConfig) {
    throw new ForgeKitError({
      code: "role_missing",
      message: `Unknown role id: ${id}`,
      category: "role",
      retryable: false,
      details: { role_id: id }
    });
  }
  const path = resolveProjectPath(projectRoot, roleConfig.definition);
  const parsed = await readAndValidateConfig<RoleConfig>(
    path,
    "forgekit.role.v1",
    (role) => role.id === id ? [] : [`Role id mismatch: requested ${id}, file contains ${role.id}`]
  );
  return {
    id,
    path,
    config: parsed.config,
    validation: parsed.validation
  };
}

export async function listAdapters(projectRoot = process.cwd()): Promise<AdapterDiscoveryEntry[]> {
  const { config } = await loadProjectConfig(projectRoot);
  const entries: AdapterDiscoveryEntry[] = [];
  for (const [adapterId, adapterPath] of Object.entries(config.adapters).sort(([left], [right]) => left.localeCompare(right))) {
    const path = resolveProjectPath(projectRoot, adapterPath);
    const parsed = await readAndValidateConfig<AdapterConfig>(
      path,
      "forgekit.adapter.v1",
      (adapter) => adapter.id === adapterId
        ? []
        : [`Adapter id mismatch: config requested ${adapterId}, file contains ${adapter.id}`]
    );
    entries.push(adapterEntry(adapterId, path, parsed));
  }
  return entries;
}

export async function getAdapter(id: string, projectRoot = process.cwd()): Promise<ConfigDetail<AdapterConfig>> {
  const { config } = await loadProjectConfig(projectRoot);
  const adapterPath = config.adapters[id];
  if (!adapterPath) {
    throw new ForgeKitError({
      code: "adapter_missing",
      message: `Unknown adapter id: ${id}`,
      category: "adapter",
      retryable: false,
      details: { adapter_id: id }
    });
  }
  const path = resolveProjectPath(projectRoot, adapterPath);
  const parsed = await readAndValidateConfig<AdapterConfig>(
    path,
    "forgekit.adapter.v1",
    (adapter) => adapter.id === id ? [] : [`Adapter id mismatch: requested ${id}, file contains ${adapter.id}`]
  );
  return {
    id,
    path,
    config: parsed.config,
    validation: parsed.validation
  };
}
