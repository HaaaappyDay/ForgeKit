import type { KeyInput } from "./screen.js";

export type WizardStep = 1 | 2 | 3;
export type WizardField = "task" | "file";

export interface WizardWorkflowOption {
  id: string;
  name: string;
  kind: "linear" | "agentic";
  stepCount: number;
  selectable: boolean;
}

export interface WizardState {
  step: WizardStep;
  workflows: WizardWorkflowOption[];
  selectedWorkflow: number;
  taskInput: string;
  filePath: string;
  activeField: WizardField;
  canStartRun: boolean;
  message: string;
}

export type WizardEffect =
  | { kind: "none" }
  | { kind: "build-plan"; workflowId: string }
  | { kind: "start" }
  | { kind: "pop" };

export function initialWizardState(): WizardState {
  return {
    step: 1,
    workflows: [],
    selectedWorkflow: 0,
    taskInput: "",
    filePath: "",
    activeField: "task",
    canStartRun: false,
    message: ""
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function moveSelection(state: WizardState, delta: number): WizardState {
  const count = state.workflows.length;
  if (count === 0) return state;
  return { ...state, selectedWorkflow: clamp(state.selectedWorkflow + delta, 0, count - 1), message: "" };
}

/**
 * Pure key reducer for the launch wizard. Handles step transitions, the
 * task/file field toggle, and text editing. I/O actions (loading workflows,
 * building the plan, starting the run) are signalled as effects for the screen.
 */
export function reduceWizardKey(state: WizardState, key: KeyInput): { state: WizardState; effect: WizardEffect } {
  if (state.step === 1) {
    switch (key.name) {
      case "up":
        return { state: moveSelection(state, -1), effect: { kind: "none" } };
      case "down":
        return { state: moveSelection(state, 1), effect: { kind: "none" } };
      case "enter": {
        const option = state.workflows[state.selectedWorkflow];
        if (!option) return { state, effect: { kind: "none" } };
        if (!option.selectable) {
          return { state: { ...state, message: "Workflow is invalid and cannot be run." }, effect: { kind: "none" } };
        }
        return { state: { ...state, step: 2, message: "" }, effect: { kind: "none" } };
      }
      case "escape":
        return { state, effect: { kind: "pop" } };
      default:
        return { state, effect: { kind: "none" } };
    }
  }

  if (state.step === 2) {
    switch (key.name) {
      case "tab":
        return {
          state: { ...state, activeField: state.activeField === "task" ? "file" : "task", message: "" },
          effect: { kind: "none" }
        };
      case "backspace": {
        if (state.activeField === "task") {
          return { state: { ...state, taskInput: state.taskInput.slice(0, -1), message: "" }, effect: { kind: "none" } };
        }
        return { state: { ...state, filePath: state.filePath.slice(0, -1), message: "" }, effect: { kind: "none" } };
      }
      case "char": {
        if (typeof key.char !== "string") return { state, effect: { kind: "none" } };
        if (state.activeField === "task") {
          return { state: { ...state, taskInput: state.taskInput + key.char, message: "" }, effect: { kind: "none" } };
        }
        return { state: { ...state, filePath: state.filePath + key.char, message: "" }, effect: { kind: "none" } };
      }
      case "enter": {
        if (state.taskInput.trim() === "" && state.filePath.trim() === "") {
          return { state: { ...state, message: "Enter a task or a task file path." }, effect: { kind: "none" } };
        }
        if (state.taskInput.trim() !== "" && state.filePath.trim() !== "") {
          return {
            state: { ...state, message: "Use either Task or Task file, not both." },
            effect: { kind: "none" }
          };
        }
        const option = state.workflows[state.selectedWorkflow];
        if (!option) return { state, effect: { kind: "none" } };
        return {
          state: { ...state, step: 3, canStartRun: false, message: "" },
          effect: { kind: "build-plan", workflowId: option.id }
        };
      }
      case "escape":
        return { state: { ...state, step: 1, message: "" }, effect: { kind: "none" } };
      default:
        return { state, effect: { kind: "none" } };
    }
  }

  // step 3: confirm
  switch (key.name) {
    case "enter":
      if (!state.canStartRun) {
        return {
          state: { ...state, message: "Run plan is not ready. Press Esc to revise the input." },
          effect: { kind: "none" }
        };
      }
      return { state, effect: { kind: "start" } };
    case "escape":
      return { state: { ...state, step: 2, canStartRun: false, message: "" }, effect: { kind: "none" } };
    default:
      return { state, effect: { kind: "none" } };
  }
}
