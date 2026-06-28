import { readFile } from "node:fs/promises";
import { buildWorkflowRunPlan, listWorkflows, startWorkflowRun } from "../../core.js";
import { loadAnyWorkflowConfig } from "../../project-config.js";
import {
  renderForm,
  renderList,
  renderRunPlan,
  truncate,
  wrapText,
  withFooter,
  type FormFieldView,
  type TerminalDimensions
} from "../render.js";
import { LiveMonitorFeed } from "../monitor-feed.js";
import { MonitorScreen } from "./monitor.js";
import {
  initialWizardState,
  reduceWizardKey,
  type WizardState,
  type WizardWorkflowOption
} from "../wizard-state.js";
import type { ScreenContext, KeyInput, Screen } from "../screen.js";
import type { AgenticRunPlan, RunPlan } from "../../types.js";

export class WizardScreen implements Screen {
  readonly title = "New run";
  private readonly ctx: ScreenContext;
  private state: WizardState = initialWizardState();
  private loaded = false;
  private loadError = "";
  private plan: RunPlan | AgenticRunPlan | null = null;
  private planError = "";
  private planLoading = false;

  constructor(ctx: ScreenContext) {
    this.ctx = ctx;
  }

  async onEnter(): Promise<void> {
    try {
      const entries = await listWorkflows(this.ctx.projectRoot);
      const options: WizardWorkflowOption[] = [];
      for (const entry of entries) {
        // `listWorkflows` only validates against the v1 schema, so agentic
        // (v2) workflows always report invalid there. Load each workflow with
        // its own schema to learn the real kind and whether it is runnable.
        let loaded: Awaited<ReturnType<typeof loadAnyWorkflowConfig>> | null = null;
        try {
          loaded = await loadAnyWorkflowConfig(entry.id, this.ctx.projectRoot);
        } catch {
          loaded = null;
        }
        const kind = loaded?.kind ?? (entry.step_count > 0 ? "linear" : "agentic");
        // Linear validity uses the stricter v1 discovery check (entrypoint,
        // step refs, etc.); agentic validity is "loads against the v2 schema".
        const selectable = loaded ? (loaded.kind === "linear" ? entry.validation.valid : true) : false;
        options.push({
          id: entry.id,
          name: loaded?.workflow.name || entry.name || entry.id,
          kind,
          stepCount: loaded && loaded.kind === "linear" ? loaded.workflow.steps.length : entry.step_count,
          selectable
        });
      }
      this.state = { ...this.state, workflows: options };
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
    this.loaded = true;
    this.ctx.shell.requestRepaint();
  }

  render(dims: TerminalDimensions): string[] {
    if (this.state.step === 1) return this.renderStep1(dims);
    if (this.state.step === 2) return this.renderStep2(dims);
    return this.renderStep3(dims);
  }

  private renderStep1(dims: TerminalDimensions): string[] {
    if (this.loadError) {
      return withFooter([truncate(`Failed to list workflows: ${this.loadError}`, dims.cols)], "[Esc back]", dims);
    }
    if (!this.loaded) return withFooter(["Loading workflows\u2026"], "[Esc back]", dims);
    const rows = this.state.workflows.map((w) => {
      const detail = w.kind === "linear" ? `steps:${w.stepCount}` : "agentic";
      const mark = w.selectable ? "" : "  [invalid]";
      return `${w.id}  ${w.name}  (${detail})${mark}`;
    });
    const body = renderList("New run \u2014 pick a workflow (1/3)", rows, this.state.selectedWorkflow, dims, {
      reservedRows: 5
    });
    const selected = this.state.workflows[this.state.selectedWorkflow];
    if (selected) {
      body.push("");
      body.push("Selected workflow:");
      body.push(...wrapText(`  id: ${selected.id}`, dims.cols));
      body.push(...wrapText(`  name: ${selected.name}`, dims.cols));
      body.push(...wrapText(
        selected.kind === "linear" ? `  kind: linear  steps: ${selected.stepCount}` : "  kind: agentic",
        dims.cols
      ));
    }
    if (this.state.message) body.push(truncate(this.state.message, dims.cols));
    return withFooter(body, "[up/down select  Enter next  Esc back  q quit]", dims);
  }

  private renderStep2(dims: TerminalDimensions): string[] {
    const fields: FormFieldView[] = [
      { label: "Task", value: this.state.taskInput, isText: this.state.activeField === "task" },
      {
        label: "Task file",
        value: this.state.filePath,
        isText: this.state.activeField === "file",
        hint: "optional; read at confirm time (like --input-file)"
      }
    ];
    const body = ["New run \u2014 task input (2/3)", ""];
    body.push(...renderForm(fields, this.state.activeField === "task" ? 0 : 1, dims));
    if (this.state.message) {
      body.push("");
      body.push(truncate(this.state.message, dims.cols));
    }
    return withFooter(body, "[type to edit  Tab toggle field  Enter next  Esc back]", dims);
  }

  private renderStep3(dims: TerminalDimensions): string[] {
    let body: string[];
    if (this.planLoading) body = ["Building run plan\u2026"];
    else if (this.planError) body = [truncate(`Plan error: ${this.planError}`, dims.cols)];
    else if (this.plan) body = renderRunPlan(this.plan, dims);
    else body = ["No plan available."];
    if (this.state.message) {
      body.push("");
      body.push(truncate(this.state.message, dims.cols));
    }
    const footer = this.state.canStartRun ? "[Enter start  Esc back]" : "[Esc back]";
    return withFooter(["New run \u2014 confirm (3/3)", "", ...body], footer, dims);
  }

  private async buildPlan(workflowId: string): Promise<void> {
    this.planLoading = true;
    this.plan = null;
    this.planError = "";
    this.state = { ...this.state, canStartRun: false, message: "" };
    this.ctx.shell.requestRepaint();
    try {
      const taskInput = await this.resolveTaskInput();
      this.plan = await buildWorkflowRunPlan({ workflowId, taskInput, projectRoot: this.ctx.projectRoot });
      this.state = { ...this.state, canStartRun: true, message: "" };
    } catch (error) {
      this.planError = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, canStartRun: false };
    }
    this.planLoading = false;
    this.ctx.shell.requestRepaint();
  }

  private async resolveTaskInput(): Promise<string> {
    if (this.state.filePath.trim() !== "") {
      return readFile(this.state.filePath.trim(), "utf8");
    }
    return this.state.taskInput;
  }

  private async start(): Promise<void> {
    const option = this.state.workflows[this.state.selectedWorkflow];
    if (!option) return;
    let taskInput: string;
    try {
      taskInput = await this.resolveTaskInput();
    } catch (error) {
      this.planError = `Failed to read task file: ${error instanceof Error ? error.message : String(error)}`;
      this.ctx.shell.requestRepaint();
      return;
    }

    const feed = new LiveMonitorFeed({ projectRoot: this.ctx.projectRoot });
    const monitor = new MonitorScreen(this.ctx, feed, { source: "live" });
    const finishLiveRun = this.ctx.shell.beginLiveRun();
    this.ctx.shell.replace(monitor);

    startWorkflowRun({
      workflowId: option.id,
      taskInput,
      projectRoot: this.ctx.projectRoot,
      writeEventsJsonl: true,
      eventObservers: [feed.observer]
    })
      .then((run) => feed.setRun(run))
      .catch((error) => {
        feed.markTerminal();
        monitor.setExternalError(error instanceof Error ? error.message : String(error));
      })
      .finally(finishLiveRun);
  }

  async handleKey(key: KeyInput): Promise<void> {
    // Global quit only on step 1 (text screens consume 'q' as input on step 2).
    if (key.name === "char" && key.char === "q" && this.state.step === 1) {
      void this.ctx.shell.requestQuit();
      return;
    }

    const { state, effect } = reduceWizardKey(this.state, key);
    this.state = state;

    switch (effect.kind) {
      case "pop":
        this.ctx.shell.pop();
        return;
      case "build-plan":
        await this.buildPlan(effect.workflowId);
        return;
      case "start":
        await this.start();
        return;
      default:
        this.ctx.shell.requestRepaint();
    }
  }
}
