import type { MonitorViewModel, MonitorStepView } from "./view-model.js";
import type { ReaderState, UiState } from "./input.js";

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

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}\u2026`;
}

export function renderMonitor(model: MonitorViewModel, ui: UiState, dims: TerminalDimensions): string[] {
  const width = dims.cols;
  const lines: string[] = [];

  lines.push(truncate(`ForgeKit Monitor   run ${model.runId}`, width));
  lines.push(
    truncate(`workflow ${model.workflowId}   status ${model.status}   duration ${model.durationMs}ms`, width)
  );
  lines.push("");

  lines.push("Steps:");
  if (model.steps.length === 0) {
    lines.push("  (no steps)");
  }
  model.steps.forEach((step, index) => {
    const marker = index === ui.selectedStep ? ">" : " ";
    const attempt = step.activeAttempt || (step.attemptCount > 0 ? `${step.attemptCount} attempts` : "no attempts");
    const exit = step.exitCode === null ? "" : ` exit ${step.exitCode}`;
    let line = `${marker} ${step.index}. ${step.stepId} (${step.roleId}) [${statusGlyph(step.status)} ${step.status}] ${attempt}${exit}`;
    lines.push(truncate(line, width));
    if (step.error) lines.push(truncate(`     error: ${step.error}`, width));
  });
  lines.push("");

  const b = model.budget;
  lines.push(
    truncate(
      `Budget: invocations ${b.invocations}/${b.maxInvocations}  retries ${b.retries}  output ${b.outputBytes}/${b.maxOutputBytes}B  exceeded: ${b.exceeded.length ? b.exceeded.join(", ") : "none"}`,
      width
    )
  );
  lines.push("");

  lines.push("Events:");
  if (model.recentEvents.length === 0) {
    lines.push("  (no events)");
  }
  for (const event of model.recentEvents) {
    const scope = event.stepId ? ` ${event.stepId}` : "";
    lines.push(truncate(`  [${event.eventId}] ${event.type}${scope} - ${event.message}`, width));
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
    lines.push(truncate(line, width));
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
