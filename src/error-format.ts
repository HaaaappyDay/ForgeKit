import { toForgeKitError } from "./errors.js";
import type { ForgeKitError, ForgeKitErrorCode } from "./errors.js";

function stringDetail(error: ForgeKitError, key: string): string {
  const value = error.details[key];
  return typeof value === "string" ? value : "";
}

function suggestionsFor(error: ForgeKitError): string[] {
  const adapterId = stringDetail(error, "adapter_id") || "<adapter-id>";
  const workflowId = stringDetail(error, "workflow_id") || "<workflow-id>";
  const runId = stringDetail(error, "run_id") || "<run-id>";
  const path = stringDetail(error, "path");

  const byCode: Partial<Record<ForgeKitErrorCode, string[]>> = {
    command_invalid: [
      "Run `forge --help` to see top-level commands.",
      "Run `<command> --help` for command-specific usage."
    ],
    config_missing: [
      "Initialize this project with `forge init` or `forge tui`.",
      "Run commands from the project root that contains `.forgekit/config.json`."
    ],
    config_invalid: [
      path ? `Fix the JSON or schema errors in ${path}.` : "Fix the reported JSON or schema errors.",
      "Use `forge schema validate <schema-id> <json-file>` for a focused validation check."
    ],
    workflow_invalid: [
      `Inspect the workflow with \`forge workflow show ${workflowId}\`.`,
      "Use `forge workflow list` to see available workflow IDs and validation status."
    ],
    role_missing: [
      "Use `forge role list` to see configured roles.",
      "Check `.forgekit/config.json` role mappings."
    ],
    adapter_missing: [
      "Use `forge adapter list` to see configured adapters.",
      "Check `.forgekit/config.json` adapter mappings."
    ],
    adapter_command_not_found: [
      `Run \`forge adapter probe ${adapterId}\` for details.`,
      `Set the executable with \`forge adapter set-command ${adapterId} <command-or-path>\`.`
    ],
    adapter_process_failed: [
      `Run \`forge adapter probe ${adapterId}\` to check runtime availability.`,
      "Open the run artifacts with `forge tui <run-id>` or inspect `.forgekit/runs/<run-id>/`."
    ],
    adapter_timeout: [
      "Retry the run if the external CLI was temporarily slow.",
      "Increase `timeout_seconds` in the adapter config if this is expected."
    ],
    handoff_parse_failed: [
      "Open the failed attempt artifact and inspect `raw.log`.",
      "Retry after adjusting the role prompt or adapter behavior."
    ],
    handoff_schema_invalid: [
      "Open `validation.json` for the failed attempt.",
      "Use `forge schema validate handoff.v1 <handoff.json>` on generated handoffs."
    ],
    handoff_content_invalid: [
      "Open `validation.json` for the failed attempt.",
      "Retry after correcting the role instructions or workflow routing."
    ],
    route_target_not_allowed: [
      "Inspect the agentic workflow handoff targets.",
      `Run \`forge workflow show ${workflowId}\` to review workflow config.`
    ],
    premature_final: [
      "Inspect terminal roles and the role handoff output.",
      `Run \`forge workflow show ${workflowId}\` to review workflow config.`
    ],
    acceptance_verdict_invalid: [
      "Open the acceptance verdict artifact for schema details.",
      "Retry after adjusting the receiving role instructions."
    ],
    run_escalated: [
      `Open the run with \`forge run show ${runId}\` or \`forge tui ${runId}\`.`,
      "Review escalation details and latest artifacts before retrying manually."
    ],
    run_not_found: [
      "Use `forge history` to list known runs.",
      "Check that you are in the project root for this `.forgekit` workspace."
    ],
    run_not_retryable: [
      `Inspect the run with \`forge run show ${runId}\`.`,
      "Only failed runs are retryable."
    ],
    artifact_not_found: [
      `Open the run with \`forge run show ${runId}\`.`,
      "Check the artifact ref from `run.json` or the TUI artifact list."
    ]
  };

  return byCode[error.code] ?? [];
}

export function formatErrorText(error: unknown): string {
  const forgeError = toForgeKitError(error);
  const lines = [
    `Error ${forgeError.code} (${forgeError.category}, retryable: ${forgeError.retryable ? "yes" : "no"})`,
    forgeError.message
  ];
  const suggestions = suggestionsFor(forgeError);
  if (suggestions.length > 0) {
    lines.push("", "Next steps:");
    for (const suggestion of suggestions) {
      lines.push(`  - ${suggestion}`);
    }
  }
  return lines.join("\n");
}
