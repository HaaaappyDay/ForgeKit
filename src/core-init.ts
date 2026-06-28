import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTemplate } from "./templates.js";
import { writeJsonFile } from "./json-file.js";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import { isNodeErrorCode } from "./node-error.js";
import type { SchemaId, TemplateId } from "./types.js";

export interface InitProjectOptions {
  templateId: TemplateId;
  projectName: string;
  force: boolean;
  projectRoot?: string;
}

export interface InitProjectResult {
  templateId: TemplateId;
  forgekitRoot: string;
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function workflowSchemaId(value: unknown): SchemaId {
  const schemaVersion = (value as { schema_version?: string } | null)?.schema_version;
  return schemaVersion === "forgekit.workflow.v2" ? "forgekit.workflow.v2" : "forgekit.workflow.v1";
}

function validateGenerated(schemaId: SchemaId, value: unknown, path: string): Promise<void> {
  return loadSchema(schemaId).then((schema) => {
    const result = validateJson(schema, value);
    if (!result.valid) {
      throw new Error(`Generated invalid ${schemaId} at ${path}:\n${result.errors.join("\n")}`);
    }
  });
}

async function writeGeneratedJson(
  root: string,
  relativePath: string,
  value: unknown,
  schemaId: SchemaId
): Promise<void> {
  const target = join(root, relativePath);
  await validateGenerated(schemaId, value, target);
  await writeJsonFile(target, value);
}

async function writeGitkeep(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, ".gitkeep"), "", "utf8");
}

/**
 * Side-effecting project initializer shared by the CLI `init` command and the
 * TUI init screen. Writes a schema-valid `.forgekit` tree from a template.
 */
export async function initProject(options: InitProjectOptions): Promise<InitProjectResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const forgekitRoot = join(projectRoot, ".forgekit");

  if (!options.force && (await directoryHasEntries(forgekitRoot))) {
    throw new Error(".forgekit already exists. Use --force to write template files into it.");
  }

  const template = buildTemplate(options.templateId, options.projectName);

  await mkdir(join(forgekitRoot, "roles"), { recursive: true });
  await mkdir(join(forgekitRoot, "workflows"), { recursive: true });
  await mkdir(join(forgekitRoot, "adapters"), { recursive: true });
  await mkdir(join(forgekitRoot, "examples"), { recursive: true });
  await writeGitkeep(join(forgekitRoot, "runs"));
  await writeGitkeep(join(forgekitRoot, "cache"));
  await writeGitkeep(join(forgekitRoot, "tmp"));

  await writeGeneratedJson(forgekitRoot, "config.json", template.config, "forgekit.config.v1");

  for (const [file, value] of Object.entries(template.roles)) {
    await writeGeneratedJson(forgekitRoot, `roles/${file}`, value, "forgekit.role.v1");
  }

  for (const [file, value] of Object.entries(template.workflows)) {
    await writeGeneratedJson(forgekitRoot, `workflows/${file}`, value, workflowSchemaId(value));
  }

  for (const [file, value] of Object.entries(template.adapters)) {
    await writeGeneratedJson(forgekitRoot, `adapters/${file}`, value, "forgekit.adapter.v1");
  }

  for (const [file, value] of Object.entries(template.examples)) {
    const schemaId: SchemaId = file.startsWith("roles/") ? "forgekit.role.v1" : workflowSchemaId(value);
    await writeGeneratedJson(forgekitRoot, `examples/${file}`, value, schemaId);
  }

  return { templateId: options.templateId, forgekitRoot };
}
