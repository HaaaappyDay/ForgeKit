import { loadProjectConfig, resolveProjectPath } from "./project-config.js";

function printHelp() {
  console.log(`Usage:
  forge role path <role-id>`);
}

export async function runRoleCommand(args, cwd = process.cwd()) {
  if (args.includes("--help") || args.includes("-h") || !args[0]) {
    printHelp();
    return;
  }

  if (args[0] !== "path") {
    throw new Error(`Unknown role command: ${args[0]}`);
  }
  const roleId = args[1];
  if (!roleId) {
    throw new Error("Usage: forge role path <role-id>");
  }

  const { config } = await loadProjectConfig(cwd);
  const role = config.roles[roleId];
  if (!role) {
    throw new Error(`Unknown role id: ${roleId}`);
  }

  const path = resolveProjectPath(cwd, role.definition);
  console.log(path);
  console.log("Edit this JSON file to change the role contract. CLI overrides cannot broaden write policy.");
}

