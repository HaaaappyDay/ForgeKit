export type TuiView = "monitor" | "reader";

export type KeyName =
  | "up"
  | "down"
  | "enter"
  | "escape"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "tab"
  | "backspace"
  | "char"
  | "quit"
  | "other";

export interface ReaderArtifact {
  ref: string;
  type: string;
}

export interface ReaderState {
  stepIndex: number;
  artifacts: ReaderArtifact[];
  activeArtifact: number;
  lines: string[];
  scrollTop: number;
}

export interface UiState {
  view: TuiView;
  selectedStep: number;
  reader: ReaderState | null;
}

export type InputEffect =
  | { kind: "none" }
  | { kind: "quit" }
  | { kind: "open-artifacts"; stepIndex: number }
  | { kind: "switch-artifact"; delta: number };

export interface ReduceContext {
  stepCount: number;
  viewportRows: number;
}

export function initialUiState(): UiState {
  return { view: "monitor", selectedStep: 0, reader: null };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function maxScrollTop(lineCount: number, viewportRows: number): number {
  return Math.max(0, lineCount - Math.max(1, viewportRows));
}

/**
 * Pure key reducer. Navigation and scrolling mutate UI state directly; actions
 * that need I/O (opening or switching artifacts, quitting) are returned as
 * effects for the app loop to perform.
 */
export function reduceKey(ui: UiState, key: KeyName, ctx: ReduceContext): { ui: UiState; effect: InputEffect } {
  if (key === "quit") {
    return { ui, effect: { kind: "quit" } };
  }

  if (ui.view === "monitor") {
    switch (key) {
      case "up":
        return { ui: { ...ui, selectedStep: clamp(ui.selectedStep - 1, 0, Math.max(0, ctx.stepCount - 1)) }, effect: { kind: "none" } };
      case "down":
        return { ui: { ...ui, selectedStep: clamp(ui.selectedStep + 1, 0, Math.max(0, ctx.stepCount - 1)) }, effect: { kind: "none" } };
      case "enter":
        if (ctx.stepCount === 0) return { ui, effect: { kind: "none" } };
        return { ui, effect: { kind: "open-artifacts", stepIndex: ui.selectedStep } };
      default:
        return { ui, effect: { kind: "none" } };
    }
  }

  // reader view
  const reader = ui.reader;
  if (!reader) {
    return { ui: { ...ui, view: "monitor" }, effect: { kind: "none" } };
  }
  const max = maxScrollTop(reader.lines.length, ctx.viewportRows);
  switch (key) {
    case "escape":
      return { ui: { ...ui, view: "monitor", reader: null }, effect: { kind: "none" } };
    case "up":
      return { ui: { ...ui, reader: { ...reader, scrollTop: clamp(reader.scrollTop - 1, 0, max) } }, effect: { kind: "none" } };
    case "down":
      return { ui: { ...ui, reader: { ...reader, scrollTop: clamp(reader.scrollTop + 1, 0, max) } }, effect: { kind: "none" } };
    case "top":
      return { ui: { ...ui, reader: { ...reader, scrollTop: 0 } }, effect: { kind: "none" } };
    case "bottom":
      return { ui: { ...ui, reader: { ...reader, scrollTop: max } }, effect: { kind: "none" } };
    case "left":
      return { ui, effect: { kind: "switch-artifact", delta: -1 } };
    case "right":
      return { ui, effect: { kind: "switch-artifact", delta: 1 } };
    default:
      return { ui, effect: { kind: "none" } };
  }
}
