import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { buildTemplate, isTemplateId, TEMPLATE_IDS } from "./templates.js";
import { writeJsonFile } from "./json-file.js";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import { isNodeErrorCode } from "./node-error.js";
import type { SchemaId, TemplateId } from "./types.js";

interface InitOptions {
  template?: string;
  projectName?: string;
  yes: boolean;
  force: boolean;
  help?: boolean;
}

function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = {
    yes: false,
    force: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--template") {
      options.template = args[index + 1];
      index += 1;
    } else if (arg === "--project-name") {
      options.projectName = args[index + 1];
      index += 1;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown init option: ${arg}`);
    }
  }

  return options;
}

function printInitHelp(): void {
  console.log(`Usage:
  forge init [--template <${TEMPLATE_IDS.join("|")}>] [--project-name <name>] [--yes] [--force]

Options:
  --template       Template to copy into .forgekit
  --project-name   Project name written to .forgekit/config.json
  --yes, -y        Use defaults without interactive prompts
  --force          Allow writing into an existing .forgekit directory`);
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

async function chooseTemplate(current: string | undefined, yes: boolean): Promise<TemplateId> {
  if (current) {
    if (!isTemplateId(current)) {
      throw new Error(`Unknown template: ${current}. Expected one of: ${TEMPLATE_IDS.join(", ")}`);
    }
    return current;
  }

  if (yes || !process.stdin.isTTY) {
    return "feature-planning";
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Choose template (${TEMPLATE_IDS.join(", ")}) [feature-planning]: `
    );
    const selected = answer.trim() || "feature-planning";
    if (!isTemplateId(selected)) {
      throw new Error(`Unknown template: ${selected}. Expected one of: ${TEMPLATE_IDS.join(", ")}`);
    }
    return selected;
  } finally {
    rl.close();
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

export async function runInitCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const options = parseInitArgs(args);
  if (options.help) {
    printInitHelp();
    return;
  }

  const templateId = await chooseTemplate(options.template, options.yes);
  const projectName = options.projectName ?? basename(cwd);
  const forgekitRoot = join(cwd, ".forgekit");

  if (!options.force && (await directoryHasEntries(forgekitRoot))) {
    throw new Error(".forgekit already exists. Use --force to write template files into it.");
  }

  const template = buildTemplate(templateId, projectName);

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

  console.log(`Created .forgekit using template: ${templateId}`);
  if (templateId === "blank") {
    console.log("Blank template wrote schema-valid config plus examples; create roles/workflows before running.");
  }
}
