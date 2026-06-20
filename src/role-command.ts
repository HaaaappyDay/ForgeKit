import { ForgeKitError } from "./errors.js";
import { getRole, listRoles } from "./core.js";
import { loadProjectConfig, resolveProjectPath } from "./project-config.js";

function printHelp(): void {
  console.log(`Usage:
  forge role list [--json]
  forge role show <role-id> [--json]
  forge role path <role-id>`);
}

export async function runRoleCommand(args: string[], cwd = process.cwd()): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || !args[0]) {
    printHelp();
    return;
  }

  const json = args.includes("--json");

  if (args[0] === "list") {
    const roles = await listRoles(cwd);
    if (json) {
      console.log(JSON.stringify(roles, null, 2));
      return;
    }
    if (roles.length === 0) {
      console.log("No roles found.");
      return;
    }
    for (const role of roles) {
      console.log(`${role.id}\t${role.validation.valid ? "valid" : "invalid"}\t${role.adapter_id}\t${role.write_policy}`);
    }
    return;
  }

  if (args[0] === "show") {
    const roleId = args[1];
    if (!roleId) {
      throw new Error("Usage: forge role show <role-id> [--json]");
    }
    const role = await getRole(roleId, cwd);
    if (json) {
      console.log(JSON.stringify(role, null, 2));
      return;
    }
    console.log(`Role: ${role.id}`);
    console.log(`Path: ${role.path}`);
    console.log(`Valid: ${role.validation.valid ? "yes" : "no"}`);
    for (const error of role.validation.errors) {
      console.log(`  error: ${error}`);
    }
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
    throw new ForgeKitError({
      code: "role_missing",
      message: `Unknown role id: ${roleId}`,
      category: "role",
      retryable: false,
      details: { role_id: roleId }
    });
  }

  const path = resolveProjectPath(cwd, role.definition);
  console.log(path);
  console.log("Edit this JSON file to change the role contract. CLI overrides cannot broaden write policy.");
}
