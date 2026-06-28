import {
  getAdapter,
  getRole,
  getWorkflow,
  listAdapters,
  listRoles,
  listWorkflows
} from "../../core.js";
import { loadAnyWorkflowConfig } from "../../project-config.js";
import {
  renderConfigDetail,
  renderList,
  truncate,
  withFooter,
  type TerminalDimensions
} from "../render.js";
import { maxScrollTop } from "../input.js";
import type { ScreenContext, KeyInput, Screen } from "../screen.js";
import type {
  AdapterDiscoveryEntry,
  ConfigDetail,
  RoleDiscoveryEntry,
  WorkflowDiscoveryEntry
} from "../../types.js";

type Tab = "workflows" | "roles" | "adapters";
const TABS: Tab[] = ["workflows", "roles", "adapters"];

interface TabState {
  loaded: boolean;
  rows: string[];
  ids: string[];
  selected: number;
  error: string;
}

function emptyTab(): TabState {
  return { loaded: false, rows: [], ids: [], selected: 0, error: "" };
}

function validMark(valid: boolean): string {
  return valid ? "[valid]" : "[invalid]";
}

async function workflowRow(
  entry: WorkflowDiscoveryEntry,
  projectRoot: string
): Promise<{ row: string; id: string }> {
  try {
    const loaded = await loadAnyWorkflowConfig(entry.id, projectRoot);
    const valid = loaded.kind === "linear" ? entry.validation.valid : true;
    const detail = loaded.kind === "linear"
      ? `linear steps:${loaded.workflow.steps.length}`
      : `agentic roles:${Object.keys(loaded.workflow.roles).length}`;
    return {
      id: entry.id,
      row: `${entry.id}  ${loaded.workflow.name || entry.name || entry.id}  ${detail}  ${validMark(valid)}`
    };
  } catch {
    return {
      id: entry.id,
      row: `${entry.id}  ${entry.name}  steps:${entry.step_count}  ${validMark(false)}`
    };
  }
}

export class ConfigScreen implements Screen {
  readonly title = "Config";
  private readonly ctx: ScreenContext;
  private tab: Tab = "workflows";
  private readonly state: Record<Tab, TabState> = {
    workflows: emptyTab(),
    roles: emptyTab(),
    adapters: emptyTab()
  };
  private mode: "list" | "detail" = "list";
  private detail: ConfigDetail<unknown> | null = null;
  private detailError = "";
  private detailScroll = 0;
  private detailLoading = false;

  constructor(ctx: ScreenContext) {
    this.ctx = ctx;
  }

  async onEnter(): Promise<void> {
    await this.loadTab(this.tab);
  }

  private async loadTab(tab: Tab): Promise<void> {
    const state = this.state[tab];
    if (state.loaded) return;
    try {
      if (tab === "workflows") {
        const entries = await listWorkflows(this.ctx.projectRoot);
        const rows = await Promise.all(entries.map((entry) => workflowRow(entry, this.ctx.projectRoot)));
        state.rows = rows.map((row) => row.row);
        state.ids = rows.map((row) => row.id);
      } else if (tab === "roles") {
        const entries = await listRoles(this.ctx.projectRoot);
        state.rows = entries.map(
          (e: RoleDiscoveryEntry) =>
            `${e.id}  ${e.name}  adapter:${e.adapter_id}  ${validMark(e.validation.valid)}`
        );
        state.ids = entries.map((e) => e.id);
      } else {
        const entries = await listAdapters(this.ctx.projectRoot);
        state.rows = entries.map(
          (e: AdapterDiscoveryEntry) => `${e.id}  ${e.type}  ${e.command}  ${validMark(e.validation.valid)}`
        );
        state.ids = entries.map((e) => e.id);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
    state.loaded = true;
    this.ctx.shell.requestRepaint();
  }

  render(dims: TerminalDimensions): string[] {
    const width = dims.cols;
    const tabLine = TABS.map((t) => (t === this.tab ? `[${t}]` : ` ${t} `)).join("  ");

    if (this.mode === "detail") {
      const header = [truncate(tabLine, width), ""];
      const viewport = Math.max(1, dims.rows - header.length - 2);
      const detailLines = this.renderDetailLines(dims);
      const slice = detailLines.slice(this.detailScroll, this.detailScroll + viewport);
      const body = [...header, ...(this.detailLoading ? ["Loading\u2026"] : slice.map((l) => truncate(l, width)))];
      return withFooter(body, "[up/down scroll  g/G top/bottom  Esc back]", dims);
    }

    const state = this.state[this.tab];
    const body = [truncate(tabLine, width), ""];
    if (state.error) {
      body.push(truncate(`error: ${state.error}`, width));
    } else if (!state.loaded) {
      body.push("Loading\u2026");
    } else {
      body.push(...renderList(`Config: ${this.tab}`, state.rows, state.selected, dims, { reservedRows: 6 }));
    }
    return withFooter(body, "[up/down select  left/right tab  Enter detail  Esc back  q quit]", dims);
  }

  private async openDetail(): Promise<void> {
    const state = this.state[this.tab];
    const id = state.ids[state.selected];
    if (!id) return;
    this.mode = "detail";
    this.detailLoading = true;
    this.detail = null;
    this.detailError = "";
    this.detailScroll = 0;
    this.ctx.shell.requestRepaint();
    try {
      let detail: ConfigDetail<unknown>;
      if (this.tab === "workflows") {
        const loaded = await loadAnyWorkflowConfig(id, this.ctx.projectRoot);
        if (loaded.kind === "linear") {
          detail = await getWorkflow(id, this.ctx.projectRoot);
        } else {
          detail = {
            id,
            path: loaded.path,
            config: loaded.workflow,
            validation: { valid: true, errors: [] }
          };
        }
      } else if (this.tab === "roles") detail = await getRole(id, this.ctx.projectRoot);
      else detail = await getAdapter(id, this.ctx.projectRoot);
      this.detail = detail;
    } catch (error) {
      this.detailError = `Failed to load detail: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.detailLoading = false;
    this.ctx.shell.requestRepaint();
  }

  private renderDetailLines(dims: TerminalDimensions): string[] {
    if (this.detail) return renderConfigDetail(this.detail, dims);
    if (this.detailError) return [this.detailError];
    return [];
  }

  private switchTab(delta: number): void {
    const index = (TABS.indexOf(this.tab) + delta + TABS.length) % TABS.length;
    this.tab = TABS[index];
    void this.loadTab(this.tab);
    this.ctx.shell.requestRepaint();
  }

  handleKey(key: KeyInput): void {
    if (this.mode === "detail") {
      const dims = this.ctx.dims();
      const max = maxScrollTop(this.renderDetailLines(dims).length, Math.max(1, dims.rows - 4));
      switch (key.name) {
        case "up":
          this.detailScroll = Math.max(0, this.detailScroll - 1);
          break;
        case "down":
          this.detailScroll = Math.min(max, this.detailScroll + 1);
          break;
        case "char":
          if (key.char === "g") this.detailScroll = 0;
          else if (key.char === "G") this.detailScroll = max;
          break;
        case "escape":
          this.mode = "list";
          break;
        default:
          break;
      }
      this.ctx.shell.requestRepaint();
      return;
    }

    const state = this.state[this.tab];
    switch (key.name) {
      case "up":
        state.selected = Math.max(0, state.selected - 1);
        break;
      case "down":
        state.selected = Math.min(Math.max(0, state.rows.length - 1), state.selected + 1);
        break;
      case "left":
        this.switchTab(-1);
        return;
      case "right":
      case "tab":
        this.switchTab(1);
        return;
      case "enter":
        void this.openDetail();
        return;
      case "escape":
        this.ctx.shell.pop();
        return;
      case "char":
        if (key.char === "q") void this.ctx.shell.requestQuit();
        break;
      default:
        break;
    }
    this.ctx.shell.requestRepaint();
  }
}
