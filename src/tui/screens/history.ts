import { listRuns } from "../../core.js";
import { isAgenticRun } from "../../run-store.js";
import { renderList, truncate, wrapText, withFooter, type TerminalDimensions } from "../render.js";
import { FileMonitorFeed } from "../monitor-feed.js";
import { MonitorScreen } from "./monitor.js";
import type { ScreenContext, KeyInput, Screen } from "../screen.js";
import type { AgenticRun, Run } from "../../types.js";

export class HistoryScreen implements Screen {
  readonly title = "History";
  private readonly ctx: ScreenContext;
  private runs: Array<Run | AgenticRun> = [];
  private selected = 0;
  private error = "";
  private loaded = false;

  constructor(ctx: ScreenContext) {
    this.ctx = ctx;
  }

  async onEnter(): Promise<void> {
    try {
      this.runs = await listRuns(this.ctx.projectRoot);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.loaded = true;
    this.ctx.shell.requestRepaint();
  }

  private runIssue(run: Run | AgenticRun): string {
    if (isAgenticRun(run)) {
      if (run.escalation) return `escalation: ${run.escalation.reason} at ${run.escalation.at_node_id}`;
      const failed = run.nodes.find((node) => node.status === "failed");
      if (failed?.attempts.at(-1)?.error) return `failure: ${failed.attempts.at(-1)?.error}`;
      return "";
    }
    const failed = run.steps.find((step) => step.status === "failed");
    if (failed?.attempts.at(-1)?.error) return `failure: ${failed.attempts.at(-1)?.error}`;
    return "";
  }

  render(dims: TerminalDimensions): string[] {
    if (this.error) {
      return withFooter([truncate(`Failed to list runs: ${this.error}`, dims.cols)], "[Esc back]", dims);
    }
    if (!this.loaded) {
      return withFooter(["Loading history\u2026"], "[Esc back]", dims);
    }
    const rows = this.runs.map(
      (run) => `${run.run_id}  ${run.status}  ${run.workflow_id}  ${run.updated_at}`
    );
    const body = renderList("Run history", rows, this.selected, dims);
    const selectedRun = this.runs[this.selected];
    if (selectedRun) {
      body.push("");
      body.push("Selected run:");
      body.push(...wrapText(`  id: ${selectedRun.run_id}`, dims.cols));
      body.push(...wrapText(`  workflow: ${selectedRun.workflow_id}  status: ${selectedRun.status}`, dims.cols));
      body.push(...wrapText(`  updated: ${selectedRun.updated_at}`, dims.cols));
      body.push(...wrapText(`  task: ${selectedRun.task.input}`, dims.cols));
      const issue = this.runIssue(selectedRun);
      if (issue) body.push(...wrapText(`  ${issue}`, dims.cols));
      body.push(...wrapText(`  summary: .forgekit/runs/${selectedRun.run_id}/summary.md`, dims.cols));
    }
    return withFooter(body, "[up/down select  Enter open  Esc back  q quit]", dims);
  }

  handleKey(key: KeyInput): void {
    switch (key.name) {
      case "up":
        this.selected = Math.max(0, this.selected - 1);
        break;
      case "down":
        this.selected = Math.min(Math.max(0, this.runs.length - 1), this.selected + 1);
        break;
      case "enter": {
        const run = this.runs[this.selected];
        if (!run) break;
        const feed = new FileMonitorFeed({ runId: run.run_id, projectRoot: this.ctx.projectRoot });
        this.ctx.shell.push(new MonitorScreen(this.ctx, feed, { source: "attached" }));
        break;
      }
      case "escape":
        this.ctx.shell.pop();
        break;
      case "char":
        if (key.char === "q") void this.ctx.shell.requestQuit();
        break;
      default:
        break;
    }
  }
}
