import type { MonitorViewModel, MonitorStepView } from "./view-model.js";
import type { AgenticMonitorViewModel, AgenticNodeView } from "./view-model-agentic.js";
import type { ReaderState, UiState } from "./input.js";
import type {
  AdapterProbeResult,
  AgenticRunPlan,
  ConfigDetail,
  RunPlan
} from "../types.js";

export interface TerminalDimensions {
  rows: number;
  cols: number;
}

export const ANSI = {
  enterAltScreen: "\u001b[?1049h",
  leaveAltScreen: "\u001b[?1049l",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  cursorHome: "\u001b[H",
  clearToEnd: "\u001b[0J",
  clearLine: "\u001b[2K"
};

function statusGlyph(status: MonitorStepView["status"]): string {
  switch (status) {
    case "completed":
      return "+";
    case "failed":
      return "x";
    case "skipped":
      return "-";
    case "pending":
      return ".";
    default:
      return "~";
  }
}

function progressBar(done: number, total: number, width: number): string {
  if (total <= 0 || width <= 0) return "";
  const safeWidth = Math.max(4, width);
  const completed = Math.max(0, Math.min(safeWidth, Math.round((done / total) * safeWidth)));
  return `[${"#".repeat(completed)}${".".repeat(safeWidth - completed)}] ${done}/${total}`;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}\u2026`;
}

export function wrapText(text: string, width: number, continuationIndent = "  "): string[] {
  if (width <= 0) return [""];
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    let cut = remaining.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    lines.push(remaining.slice(0, cut));
    remaining = `${continuationIndent}${remaining.slice(cut).trimStart()}`;
  }
  lines.push(remaining);
  return lines;
}

/**
 * Returns the slice of `rows` that keeps `selectedIndex` visible within
 * `viewport` rows, scrolling as the selection moves past either edge.
 */
function scrollWindow(
  rows: string[],
  selectedIndex: number,
  viewport: number
): { slice: string[]; offset: number } {
  if (viewport <= 0 || rows.length <= viewport) return { slice: rows, offset: 0 };
  let offset = 0;
  if (selectedIndex >= viewport) offset = selectedIndex - viewport + 1;
  if (offset > rows.length - viewport) offset = rows.length - viewport;
  if (offset < 0) offset = 0;
  return { slice: rows.slice(offset, offset + viewport), offset };
}

export function renderMonitor(model: MonitorViewModel, ui: UiState, dims: TerminalDimensions): string[] {
  const width = dims.cols;
  const lines: string[] = [];
  const completed = model.steps.filter((step) => step.status === "completed").length;
  const failed = model.steps.filter((step) => step.status === "failed").length;
  const active = model.steps.find((step) => (
    step.status === "starting_session" ||
    step.status === "running" ||
    step.status === "validating" ||
    step.status === "self_correcting"
  ));

  lines.push(truncate(`ForgeKit Monitor   run ${model.runId}`, width));
  lines.push(
    truncate(`workflow ${model.workflowId}   status ${model.status}   duration ${model.durationMs}ms`, width)
  );
  const progress = progressBar(completed, model.steps.length, Math.min(24, Math.max(4, width - 20)));
  lines.push(truncate(`progress ${progress}  failed ${failed}  active ${active?.stepId ?? "none"}`, width));
  lines.push("");

  lines.push("Steps:");
  if (model.steps.length === 0) {
    lines.push("  (no steps)");
  }
  model.steps.forEach((step, index) => {
    const marker = index === ui.selectedStep ? ">" : " ";
    const attempt = step.activeAttempt || (step.attemptCount > 0 ? `${step.attemptCount} attempts` : "no attempts");
    const exit = step.exitCode === null ? "" : ` exit ${step.exitCode}`;
    const line = `${marker} ${step.index}. ${step.stepId} (${step.roleId}) [${statusGlyph(step.status)} ${step.status}] ${attempt}${exit}`;
    lines.push(truncate(line, width));
    if (step.error) lines.push(...wrapText(`     error: ${step.error}`, width, "     "));
  });
  const selectedStep = model.steps[ui.selectedStep];
  if (selectedStep) {
    lines.push("");
    lines.push("Selected step:");
    lines.push(...wrapText(`  id: ${selectedStep.stepId}`, width));
    lines.push(...wrapText(`  role: ${selectedStep.roleId}  status: ${selectedStep.status}`, width));
    if (selectedStep.activeAttempt) lines.push(...wrapText(`  attempt: ${selectedStep.activeAttempt}`, width));
    if (selectedStep.error) lines.push(...wrapText(`  error: ${selectedStep.error}`, width));
  }
  lines.push("");

  const b = model.budget;
  lines.push("Budget:");
  lines.push(truncate(`  invocations ${b.invocations}/${b.maxInvocations}  retries ${b.retries}`, width));
  lines.push(truncate(`  output ${b.outputBytes}/${b.maxOutputBytes}B  exceeded: ${b.exceeded.length ? b.exceeded.join(", ") : "none"}`, width));
  lines.push("");

  lines.push("Events:");
  if (model.recentEvents.length === 0) {
    lines.push("  (no events)");
  }
  for (const event of model.recentEvents) {
    const scope = event.stepId ? ` ${event.stepId}` : "";
    lines.push(...wrapText(`  [${event.eventId}] ${event.type}${scope} - ${event.message}`, width, "    "));
  }

  return lines;
}

export function renderReader(reader: ReaderState, dims: TerminalDimensions): string[] {
  const width = dims.cols;
  const lines: string[] = [];
  const active = reader.artifacts[reader.activeArtifact];
  const refLabel = active ? active.ref : "(none)";
  const typeLabel = active ? active.type : "";

  lines.push(
    truncate(
      `Artifact ${refLabel}  (${typeLabel})  [${reader.activeArtifact + 1}/${reader.artifacts.length}]`,
      width
    )
  );
  const tabs = reader.artifacts
    .map((artifact, index) => (index === reader.activeArtifact ? `*${artifact.type}*` : artifact.type))
    .join("  ");
  lines.push(truncate(tabs, width));
  lines.push("\u2500".repeat(Math.max(0, Math.min(width, 60))));

  const footerRows = 2;
  const headerRows = lines.length;
  const viewport = Math.max(1, dims.rows - headerRows - footerRows);
  const slice = reader.lines.slice(reader.scrollTop, reader.scrollTop + viewport);
  for (const line of slice) {
    const wrapped = wrapText(line, width, "");
    for (const wrappedLine of wrapped) {
      if (lines.length >= dims.rows - footerRows) break;
      lines.push(truncate(wrappedLine, width));
    }
    if (lines.length >= dims.rows - footerRows) break;
  }

  return lines;
}

/**
 * Composes content lines into a full-screen frame: positions the cursor at
 * home, repaints each line clearing to end of line, pads to the terminal
 * height, and clears any trailing rows. Avoids a full clear to reduce flicker.
 */
export function composeFrame(contentLines: string[], dims: TerminalDimensions): string {
  const rows = Math.max(1, dims.rows);
  const visible = contentLines.slice(0, rows);
  const out: string[] = [ANSI.cursorHome];
  for (let i = 0; i < rows; i += 1) {
    const line = visible[i] ?? "";
    out.push(`${ANSI.clearLine}${line}`);
    if (i < rows - 1) out.push("\r\n");
  }
  out.push(ANSI.clearToEnd);
  return out.join("");
}

export function renderFrame(model: MonitorViewModel, ui: UiState, dims: TerminalDimensions): string {
  const footer =
    ui.view === "reader"
      ? "[up/down scroll  left/right artifact  g/G top/bottom  Esc back  q quit]"
      : "[up/down select  Enter artifacts  q quit]";
  const body = ui.view === "reader" && ui.reader ? renderReader(ui.reader, dims) : renderMonitor(model, ui, dims);
  const lines = [...body];
  while (lines.length < dims.rows - 1) lines.push("");
  lines[dims.rows - 1] = truncate(footer, dims.cols);
  return composeFrame(lines, dims);
}

/**
 * Frames a screen's content lines with an optional pinned footer at the last
 * row. Returns content lines only (no cursor codes); the shell composes them.
 */
export function withFooter(body: string[], footer: string, dims: TerminalDimensions): string[] {
  const lines = body.slice(0, Math.max(0, dims.rows - 1));
  while (lines.length < dims.rows - 1) lines.push("");
  lines.push(truncate(footer, dims.cols));
  return lines;
}

export function renderMenu(
  title: string,
  items: string[],
  selectedIndex: number,
  dims: TerminalDimensions
): string[] {
  const width = dims.cols;
  const lines: string[] = [truncate(title, width), ""];
  items.forEach((item, index) => {
    const marker = index === selectedIndex ? ">" : " ";
    lines.push(truncate(`${marker} ${item}`, width));
  });
  return lines;
}

export function renderList(
  title: string,
  rows: string[],
  selectedIndex: number,
  dims: TerminalDimensions,
  options: { reservedRows?: number } = {}
): string[] {
  const width = dims.cols;
  const lines: string[] = [truncate(title, width), ""];
  if (rows.length === 0) {
    lines.push("  (empty)");
    return lines;
  }
  const reserved = options.reservedRows ?? 4;
  const viewport = Math.max(1, dims.rows - lines.length - reserved);
  const { slice, offset } = scrollWindow(rows, selectedIndex, viewport);
  slice.forEach((row, i) => {
    const index = offset + i;
    const marker = index === selectedIndex ? ">" : " ";
    lines.push(truncate(`${marker} ${row}`, width));
  });
  if (rows.length > viewport) {
    lines.push(truncate(`  [${selectedIndex + 1}/${rows.length}]`, width));
  }
  return lines;
}

export interface FormFieldView {
  label: string;
  value: string;
  isText?: boolean;
  hint?: string;
}

export function renderForm(
  fields: FormFieldView[],
  activeField: number,
  dims: TerminalDimensions
): string[] {
  const width = dims.cols;
  const lines: string[] = [];
  fields.forEach((field, index) => {
    const active = index === activeField;
    const marker = active ? ">" : " ";
    const caret = active && field.isText ? "\u2588" : "";
    const value = field.value.length > 0 || !active ? field.value : "";
    lines.push(truncate(`${marker} ${field.label}: ${value}${caret}`, width));
    if (field.hint) lines.push(truncate(`    ${field.hint}`, width));
  });
  return lines;
}

export function renderRunPlan(plan: RunPlan | AgenticRunPlan, dims: TerminalDimensions): string[] {
  const width = dims.cols;
  const lines: string[] = [];
  lines.push(truncate(`Run plan: ${plan.workflow_name} (${plan.workflow_id})`, width));
  lines.push(...wrapText(`task: ${plan.task_input}`, width));
  lines.push("");

  if ("run_mode" in plan && plan.run_mode === "agentic") {
    lines.push(truncate(`mode agentic   entrypoint ${plan.entrypoint}`, width));
    lines.push(truncate(`terminal roles: ${plan.terminal_roles.join(", ") || "(none)"}`, width));
    lines.push("");
    lines.push("Roles:");
    for (const role of plan.roles) {
      const flags = [role.is_entrypoint ? "entry" : "", role.is_terminal ? "terminal" : ""]
        .filter(Boolean)
        .join(",");
      lines.push(
        truncate(
          `  ${role.role_id} (${role.role_name}) [${role.adapter_type}] ${flags}`.trimEnd(),
          width
        )
      );
      lines.push(...wrapText(`    candidates: ${role.candidates.join(", ") || "(none)"}`, width, "    "));
    }
    lines.push("");
    const b = plan.budgets;
    lines.push(
      truncate(
        `Budget: invocations ${b.max_invocations}  steps ${b.max_steps}  role_visits ${b.max_role_visits}  output ${b.max_output_bytes}B`,
        width
      )
    );
  } else {
    const linear = plan as RunPlan;
    lines.push("Steps:");
    for (const step of linear.steps) {
      lines.push(
        truncate(
          `  ${step.index}. ${step.step_id} (${step.role_id}) [${step.adapter_type}] -> ${step.output_schema}`,
          width
        )
      );
      lines.push(...wrapText(`     ${step.objective}`, width, "     "));
    }
    lines.push("");
    const b = linear.budgets;
    lines.push(
      truncate(
        `Budget: invocations ${b.max_invocations}  retries/step ${b.max_retries_per_step}  duration ${b.max_duration_minutes}m  output ${b.max_output_bytes}B`,
        width
      )
    );
  }

  lines.push("");
  lines.push("Adapters:");
  for (const adapter of plan.adapters) {
    lines.push(
      ...wrapText(`  ${adapter.adapter_id} (${adapter.type}) ${adapter.command}  auth ${adapter.auth_mode}`, width)
    );
  }

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of plan.warnings) lines.push(...wrapText(`  ! ${warning}`, width));
  }

  return lines;
}

function agenticNodeLine(node: AgenticNodeView, selected: boolean, active: boolean, width: number): string {
  const marker = selected ? ">" : active ? "*" : " ";
  const verdict = node.verdict ? ` verdict:${node.verdict}` : "";
  const next = node.chosenNextRole ? ` -> ${node.chosenNextRole}` : "";
  const phase = node.phase ? ` ${node.phase}` : "";
  return truncate(
    `${marker} ${node.nodeSeq}. ${node.nodeId} (${node.roleId}) [${node.status}]${phase}${verdict}${next}`,
    width
  );
}

export function renderAgenticMonitor(
  model: AgenticMonitorViewModel,
  ui: UiState,
  dims: TerminalDimensions
): string[] {
  const width = dims.cols;
  const lines: string[] = [];
  const completed = model.nodes.filter((node) => node.status === "completed").length;
  const failed = model.nodes.filter((node) => node.status === "failed" || node.status === "escalated").length;
  lines.push(truncate(`ForgeKit Monitor   run ${model.runId}`, width));
  lines.push(
    truncate(
      `workflow ${model.workflowId}   status ${model.status}   agentic   duration ${model.durationMs}ms`,
      width
    )
  );
  const progress = progressBar(completed, model.nodes.length, Math.min(24, Math.max(4, width - 20)));
  lines.push(
    truncate(`progress ${progress}  failed/escalated ${failed}  active ${model.activeNodeId ?? "none"}`, width)
  );
  lines.push("");

  lines.push("Nodes:");
  lines.push("  legend: > selected  * active  -> chosen next  verdict:<gate>");
  if (model.nodes.length === 0) lines.push("  (no nodes)");
  model.nodes.forEach((node, index) => {
    const selected = index === ui.selectedStep;
    const active = node.nodeId === model.activeNodeId;
    lines.push(agenticNodeLine(node, selected, active, width));
    if (node.unmet.length > 0) lines.push(...wrapText(`     unmet: ${node.unmet.join(", ")}`, width, "     "));
    if (node.error) lines.push(...wrapText(`     error: ${node.error}`, width, "     "));
  });
  const selectedNode = model.nodes[ui.selectedStep];
  if (selectedNode) {
    lines.push("");
    lines.push("Selected node:");
    lines.push(...wrapText(`  id: ${selectedNode.nodeId}`, width));
    lines.push(...wrapText(`  role: ${selectedNode.roleId}  status: ${selectedNode.status}`, width));
    if (selectedNode.phase) lines.push(...wrapText(`  phase: ${selectedNode.phase}`, width));
    if (selectedNode.verdict) lines.push(...wrapText(`  verdict: ${selectedNode.verdict}`, width));
    if (selectedNode.chosenNextRole) lines.push(...wrapText(`  next: ${selectedNode.chosenNextRole}`, width));
  }
  lines.push("");

  if (model.edges.length > 0) {
    lines.push("Route:");
    for (const edge of model.edges.slice(-6)) {
      lines.push(truncate(`  ${edge.from} -${edge.type}-> ${edge.to}`, width));
    }
    if (model.edges.length > 6) lines.push(truncate(`  ... ${model.edges.length - 6} earlier edges`, width));
    lines.push("");
  }

  const b = model.budget;
  const visits = b.roleVisits.map((v) => `${v.roleId}:${v.count}`).join(" ") || "none";
  lines.push("Budget:");
  lines.push(truncate(`  invocations ${b.invocations}/${b.maxInvocations}  steps ${b.steps}/${b.maxSteps}`, width));
  lines.push(
    truncate(
      `  role_visits[${visits}]/${b.maxRoleVisits}  exceeded: ${b.exceeded.length ? b.exceeded.join(", ") : "none"}`,
      width
    )
  );

  if (model.escalation) {
    lines.push("");
    lines.push(truncate(`Escalation: ${model.escalation.reason} at ${model.escalation.atNodeId}`, width));
  }

  lines.push("");
  lines.push("Events:");
  if (model.recentEvents.length === 0) lines.push("  (no events)");
  for (const event of model.recentEvents) {
    const scope = event.nodeId ? ` ${event.nodeId}` : "";
    lines.push(...wrapText(`  [${event.eventId}] ${event.type}${scope} - ${event.message}`, width, "    "));
  }

  return lines;
}

export function renderProbeResult(result: AdapterProbeResult, dims: TerminalDimensions): string[] {
  const width = dims.cols;
  const lines: string[] = [];
  lines.push(truncate(`Runtime adapter probe: ${result.adapter_id} (${result.adapter_type})`, width));
  lines.push(truncate(`overall: ${result.ok ? "OK" : "FAILED"}`, width));
  lines.push(truncate(`command: ${result.command}  resolved: ${result.resolved_command ?? "(not found)"}`, width));
  lines.push("");
  lines.push("Checks:");
  if (result.checks.length === 0) lines.push("  (none)");
  for (const check of result.checks) {
    const glyph = check.status === "passed" ? "+" : "x";
    lines.push(truncate(`  [${glyph}] ${check.name}${check.message ? ` - ${check.message}` : ""}`, width));
  }
  if (result.auth) {
    lines.push("");
    lines.push(truncate(`auth: ${result.auth.mode}${result.auth.description ? ` - ${result.auth.description}` : ""}`, width));
  }
  if (result.billing) {
    lines.push(truncate(`billing: ${result.billing.mode}  cost ${result.billing.cost_tracking}`, width));
  }
  if (result.write_policy) {
    lines.push(
      truncate(`write_policy: ${result.write_policy.default_mode} (${result.write_policy.enforcement})`, width)
    );
  }
  if (result.notes && result.notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const note of result.notes) lines.push(truncate(`  - ${note}`, width));
  }
  if (!result.ok && !result.resolved_command) {
    lines.push("");
    lines.push("Next:");
    lines.push(truncate(`  forge adapter set-command ${result.adapter_id} <command-or-path>`, width));
    lines.push(truncate(`  forge adapter probe ${result.adapter_id}`, width));
  }
  return lines;
}

export function renderConfigDetail(detail: ConfigDetail<unknown>, dims: TerminalDimensions): string[] {
  const width = dims.cols;
  const lines: string[] = [];
  lines.push(truncate(`${detail.id}`, width));
  lines.push(truncate(`path: ${detail.path}`, width));
  lines.push(truncate(`valid: ${detail.validation.valid ? "yes" : "no"}`, width));
  if (!detail.validation.valid && detail.validation.errors.length > 0) {
    lines.push("errors:");
    for (const error of detail.validation.errors) lines.push(truncate(`  ! ${error}`, width));
  }
  lines.push("");
  const pretty = detail.config === null ? "(unparseable)" : JSON.stringify(detail.config, null, 2);
  for (const line of pretty.split("\n")) lines.push(truncate(line, width));
  return lines;
}
