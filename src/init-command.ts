import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isTemplateId, TEMPLATE_IDS } from "./templates.js";
import { initProject } from "./core-init.js";
import { loadProjectConfig } from "./project-config.js";
import type { TemplateId } from "./types.js";

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

export async function runInitCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const options = parseInitArgs(args);
  if (options.help) {
    printInitHelp();
    return;
  }

  const templateId = await chooseTemplate(options.template, options.yes);
  const projectName = options.projectName ?? basename(cwd);

  await initProject({ templateId, projectName, force: options.force, projectRoot: cwd });

  console.log(`Created .forgekit using template: ${templateId}`);
  if (templateId === "blank") {
    console.log("Blank template wrote schema-valid config plus examples; create roles/workflows before running.");
    console.log("Next: copy examples into .forgekit/roles and .forgekit/workflows, then update .forgekit/config.json.");
    return;
  }
  const { config } = await loadProjectConfig(cwd);
  const adapterIds = Object.keys(config.adapters);
  console.log(`Default workflow: ${config.defaults.workflow}`);
  console.log(`Adapters: ${adapterIds.join(", ") || "(none)"}`);
  if (adapterIds.length > 0) {
    console.log("Next:");
    for (const adapterId of adapterIds) {
      console.log(`  forge adapter probe ${adapterId}`);
    }
    console.log(`  forge workflow start --input "Describe the task" --yes`);
    console.log("  forge tui");
  }
}
