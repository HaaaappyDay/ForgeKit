import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listAdapters, listRoles, listRuns, listWorkflows } from "../../core.js";
import { loadAnyWorkflowConfig } from "../../project-config.js";
import { renderMenu, truncate, wrapText, withFooter, type TerminalDimensions } from "../render.js";
import { FileMonitorFeed } from "../monitor-feed.js";
import type { ScreenContext, KeyInput, Screen } from "../screen.js";
import type { AgenticRun, Run } from "../../types.js";
import type { ProjectConfig } from "../../types.js";
import { HistoryScreen } from "./history.js";
import { ConfigScreen } from "./config.js";
import { AdaptersScreen } from "./adapters.js";
import { InitScreen } from "./init.js";
import { MonitorScreen } from "./monitor.js";
import { WizardScreen } from "./wizard.js";

interface MenuItem {
  label: string;
  action: () => void;
}

const RECENT_LIMIT = 5;

export class HomeScreen implements Screen {
  readonly title = "Home";
  private readonly ctx: ScreenContext;
  private selected = 0;
  private recent: Array<Run | AgenticRun> = [];
  private projectName = "(uninitialized)";
  private defaultWorkflow = "";
  private setupLines: string[] = ["Setup: missing .forgekit/config.json"];
  private readonly items: MenuItem[];

  constructor(ctx: ScreenContext) {
    this.ctx = ctx;
    this.items = [
      { label: "New run", action: () => this.ctx.shell.push(new WizardScreen(this.ctx)) },
      { label: "History", action: () => this.ctx.shell.push(new HistoryScreen(this.ctx)) },
      { label: "Config", action: () => this.ctx.shell.push(new ConfigScreen(this.ctx)) },
      { label: "Adapters", action: () => this.ctx.shell.push(new AdaptersScreen(this.ctx)) },
      { label: "Initialize project", action: () => this.ctx.shell.push(new InitScreen(this.ctx)) },
      { label: "Quit", action: () => { void this.ctx.shell.requestQuit(); } }
    ];
  }

  async onEnter(): Promise<void> {
    try {
      const text = await readFile(join(this.ctx.projectRoot, ".forgekit", "config.json"), "utf8");
      const config = JSON.parse(text) as ProjectConfig;
      if (config.project?.name) this.projectName = config.project.name;
      this.defaultWorkflow = config.defaults?.workflow ?? "";
      try {
        const [workflows, roles, adapters] = await Promise.all([
          listWorkflows(this.ctx.projectRoot),
          listRoles(this.ctx.projectRoot),
          listAdapters(this.ctx.projectRoot)
        ]);
        const workflowHealth = await Promise.all(workflows.map(async (entry) => {
          try {
            const loaded = await loadAnyWorkflowConfig(entry.id, this.ctx.projectRoot);
            return loaded.kind === "linear" ? entry.validation.valid : true;
          } catch {
            return false;
          }
        }));
        const invalidWorkflows = workflowHealth.filter((valid) => !valid).length;
        const invalidRoles = roles.filter((entry) => !entry.validation.valid).length;
        const invalidAdapters = adapters.filter((entry) => !entry.validation.valid).length;
        this.setupLines = [
          `Setup: ready  default workflow: ${this.defaultWorkflow || "(none)"}`,
          `Config: workflows ${workflows.length}${invalidWorkflows ? ` (${invalidWorkflows} invalid)` : ""}  roles ${roles.length}${invalidRoles ? ` (${invalidRoles} invalid)` : ""}  adapters ${adapters.length}${invalidAdapters ? ` (${invalidAdapters} invalid)` : ""}`,
          "Next: New run, Adapters probe, or Config detail"
        ];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setupLines = [
          `Setup: config found  default workflow: ${this.defaultWorkflow || "(none)"}`,
          `Health check failed: ${message}`,
          "Next: open Config detail or run forge schema validate"
        ];
      }
    } catch {
      this.projectName = "(uninitialized)";
      this.defaultWorkflow = "";
      this.setupLines = [
        "Setup: missing .forgekit/config.json",
        "Next: Initialize project, then probe adapters before starting a run"
      ];
    }
    try {
      const runs = await listRuns(this.ctx.projectRoot);
      this.recent = runs.slice(0, RECENT_LIMIT);
    } catch {
      this.recent = [];
    }
    this.selected = Math.min(this.selected, Math.max(0, this.selectableCount() - 1));
    this.ctx.shell.requestRepaint();
  }

  private selectableCount(): number {
    return this.items.length + this.recent.length;
  }

  private selectedRecentIndex(): number {
    return this.selected - this.items.length;
  }

  render(dims: TerminalDimensions): string[] {
    const width = dims.cols;
    const body = renderMenu(
      `ForgeKit   project: ${this.projectName}`,
      this.items.map((item) => item.label),
      this.selected < this.items.length ? this.selected : -1,
      dims
    );
    body.push("");
    for (const line of this.setupLines) {
      body.push(...wrapText(line, width));
    }
    body.push("");
    body.push(truncate("Recent runs:", width));
    if (this.recent.length === 0) {
      body.push("  (none)");
    } else {
      for (let index = 0; index < this.recent.length; index += 1) {
        const run = this.recent[index];
        const marker = this.selectedRecentIndex() === index ? ">" : " ";
        body.push(truncate(`${marker} ${run.run_id}  ${run.status}  ${run.workflow_id}`, width));
      }
      const selectedRun = this.recent[this.selectedRecentIndex()];
      if (selectedRun) {
        body.push("");
        body.push("Selected recent run:");
        body.push(...wrapText(`  id: ${selectedRun.run_id}`, width));
        body.push(...wrapText(`  workflow: ${selectedRun.workflow_id}  status: ${selectedRun.status}`, width));
        body.push(...wrapText(`  task: ${selectedRun.task.input}`, width));
      }
    }
    return withFooter(body, "[up/down select  Enter open  Esc quit  q quit]", dims);
  }

  handleKey(key: KeyInput): void {
    switch (key.name) {
      case "up":
        this.selected = Math.max(0, this.selected - 1);
        break;
      case "down":
        this.selected = Math.min(Math.max(0, this.selectableCount() - 1), this.selected + 1);
        break;
      case "enter": {
        if (this.selected < this.items.length) {
          this.items[this.selected]?.action();
          break;
        }
        const run = this.recent[this.selectedRecentIndex()];
        if (!run) break;
        const feed = new FileMonitorFeed({ runId: run.run_id, projectRoot: this.ctx.projectRoot });
        this.ctx.shell.push(new MonitorScreen(this.ctx, feed, { source: "attached" }));
        break;
      }
      case "escape":
        void this.ctx.shell.requestQuit();
        break;
      case "char":
        if (key.char === "q") void this.ctx.shell.requestQuit();
        break;
      default:
        break;
    }
  }
}
