import { listAdapters, probeAdapter } from "../../core.js";
import {
  renderList,
  renderProbeResult,
  truncate,
  wrapText,
  withFooter,
  type TerminalDimensions
} from "../render.js";
import { maxScrollTop } from "../input.js";
import type { ScreenContext, KeyInput, Screen } from "../screen.js";
import type { AdapterDiscoveryEntry, AdapterProbeResult } from "../../types.js";

export class AdaptersScreen implements Screen {
  readonly title = "Adapters";
  private readonly ctx: ScreenContext;
  private adapters: AdapterDiscoveryEntry[] = [];
  private selected = 0;
  private loaded = false;
  private error = "";

  private mode: "list" | "probe" = "list";
  private probing = false;
  private probeAdapterLabel = "";
  private probeLines: string[] = [];
  private probeScroll = 0;

  constructor(ctx: ScreenContext) {
    this.ctx = ctx;
  }

  async onEnter(): Promise<void> {
    try {
      this.adapters = await listAdapters(this.ctx.projectRoot);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.loaded = true;
    this.ctx.shell.requestRepaint();
  }

  render(dims: TerminalDimensions): string[] {
    const width = dims.cols;
    if (this.mode === "probe") {
      const viewport = Math.max(1, dims.rows - 2);
      const slice = this.probing
        ? [truncate(`Runtime adapter probe: ${this.probeAdapterLabel}`, width), "", "probing\u2026"]
        : this.probeLines.slice(this.probeScroll, this.probeScroll + viewport).map((l) => truncate(l, width));
      return withFooter(slice, "[up/down scroll  g/G top/bottom  Esc back]", dims);
    }

    if (this.error) {
      return withFooter([truncate(`Failed to list adapters: ${this.error}`, width)], "[Esc back]", dims);
    }
    if (!this.loaded) {
      return withFooter(["Loading adapters\u2026"], "[Esc back]", dims);
    }
    const rows = this.adapters.map(
      (a) => `${a.id}  ${a.type}  ${a.command}  ${a.validation.valid ? "[config valid]" : "[config invalid]"}`
    );
    const body = renderList("Adapters", rows, this.selected, dims);
    const adapter = this.adapters[this.selected];
    if (adapter) {
      body.push("");
      body.push("Selected adapter:");
      body.push(...wrapText(`  id: ${adapter.id}`, width));
      body.push(...wrapText(`  type: ${adapter.type}`, width));
      body.push(...wrapText(`  command: ${adapter.command}`, width));
      body.push(...wrapText(`  config validation: ${adapter.validation.valid ? "valid" : "invalid"}`, width));
    }
    return withFooter(body, "[up/down select  Enter probe  Esc back  q quit]", dims);
  }

  private async runProbe(): Promise<void> {
    const adapter = this.adapters[this.selected];
    if (!adapter) return;
    this.mode = "probe";
    this.probing = true;
    this.probeAdapterLabel = `${adapter.id} (${adapter.type})`;
    this.probeScroll = 0;
    this.ctx.shell.requestRepaint();
    try {
      const result: AdapterProbeResult = await probeAdapter(adapter.id, this.ctx.projectRoot);
      this.probeLines = renderProbeResult(result, this.ctx.dims());
    } catch (error) {
      this.probeLines = [`Probe failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    this.probing = false;
    this.ctx.shell.requestRepaint();
  }

  handleKey(key: KeyInput): void {
    if (this.mode === "probe") {
      const dims = this.ctx.dims();
      const max = maxScrollTop(this.probeLines.length, Math.max(1, dims.rows - 2));
      switch (key.name) {
        case "up":
          this.probeScroll = Math.max(0, this.probeScroll - 1);
          break;
        case "down":
          this.probeScroll = Math.min(max, this.probeScroll + 1);
          break;
        case "char":
          if (key.char === "g") this.probeScroll = 0;
          else if (key.char === "G") this.probeScroll = max;
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

    switch (key.name) {
      case "up":
        this.selected = Math.max(0, this.selected - 1);
        break;
      case "down":
        this.selected = Math.min(Math.max(0, this.adapters.length - 1), this.selected + 1);
        break;
      case "enter":
        void this.runProbe();
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
