import { basename } from "node:path";
import { initProject } from "../../core-init.js";
import { TEMPLATE_IDS } from "../../templates.js";
import { renderForm, truncate, withFooter, type FormFieldView, type TerminalDimensions } from "../render.js";
import { WizardScreen } from "./wizard.js";
import type { ScreenContext, KeyInput, Screen } from "../screen.js";
import type { TemplateId } from "../../types.js";

type InitField = 0 | 1 | 2; // template, project name, force
const FORCE_WARNING =
  "Force overwrites generated .forgekit files: config.json, roles/, workflows/, adapters/, examples/.";

export class InitScreen implements Screen {
  readonly title = "Initialize project";
  private readonly ctx: ScreenContext;
  private templateIndex = TEMPLATE_IDS.indexOf("feature-planning");
  private projectName: string;
  private force = false;
  private activeField: InitField = 0;
  private message = "";
  private forceConfirmPending = false;
  private done = false;

  constructor(ctx: ScreenContext) {
    this.ctx = ctx;
    this.projectName = basename(ctx.projectRoot) || "project";
    if (this.templateIndex < 0) this.templateIndex = 0;
  }

  private get templateId(): TemplateId {
    return TEMPLATE_IDS[this.templateIndex];
  }

  render(dims: TerminalDimensions): string[] {
    if (this.done) {
      const body = [
        truncate(`Created .forgekit using template: ${this.templateId}`, dims.cols),
        "",
        "Press Enter to return home, or n to start a new run."
      ];
      return withFooter(body, "[Enter home  n new run  Esc back]", dims);
    }

    const fields: FormFieldView[] = [
      { label: "Template", value: this.templateId, hint: "left/right to change" },
      { label: "Project name", value: this.projectName, isText: this.activeField === 1 },
      { label: "Force", value: this.force ? "yes" : "no", hint: "left/right or space to toggle" }
    ];
    const body = ["Initialize project", ""];
    body.push(...renderForm(fields, this.activeField, dims));
    if (this.force) {
      body.push("");
      body.push(truncate(`Warning: ${FORCE_WARNING}`, dims.cols));
      if (this.forceConfirmPending) {
        body.push(truncate("Press Enter again to create with Force, or turn Force off.", dims.cols));
      }
    }
    if (this.message) {
      body.push("");
      body.push(truncate(this.message, dims.cols));
    }
    return withFooter(body, "[up/down field  left/right change  type name  Enter create  Esc back]", dims);
  }

  private cycleTemplate(delta: number): void {
    const count = TEMPLATE_IDS.length;
    this.templateIndex = (this.templateIndex + delta + count) % count;
    this.forceConfirmPending = false;
  }

  private toggleForce(): void {
    this.force = !this.force;
    this.forceConfirmPending = false;
    if (this.force) this.message = "";
  }

  private async submit(): Promise<void> {
    if (this.force && !this.forceConfirmPending) {
      this.forceConfirmPending = true;
      this.message = "Force requires confirmation before writing template files.";
      this.ctx.shell.requestRepaint();
      return;
    }
    this.message = "Creating\u2026";
    this.ctx.shell.requestRepaint();
    try {
      await initProject({
        templateId: this.templateId,
        projectName: this.projectName.trim() || basename(this.ctx.projectRoot) || "project",
        force: this.force,
        projectRoot: this.ctx.projectRoot
      });
      this.done = true;
      this.message = "";
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.message = msg.includes("already exists") ? `${msg} (Force overwrites generated template files)` : msg;
    }
    this.ctx.shell.requestRepaint();
  }

  async handleKey(key: KeyInput): Promise<void> {
    if (this.done) {
      if (key.name === "enter") this.ctx.shell.pop();
      else if (key.name === "char" && key.char === "n") this.ctx.shell.replace(new WizardScreen(this.ctx));
      else if (key.name === "escape") this.ctx.shell.pop();
      return;
    }

    switch (key.name) {
      case "up":
        this.activeField = Math.max(0, this.activeField - 1) as InitField;
        break;
      case "down":
        this.activeField = Math.min(2, this.activeField + 1) as InitField;
        break;
      case "left":
        if (this.activeField === 0) this.cycleTemplate(-1);
        else if (this.activeField === 2) this.toggleForce();
        break;
      case "right":
        if (this.activeField === 0) this.cycleTemplate(1);
        else if (this.activeField === 2) this.toggleForce();
        break;
      case "char":
        if (this.activeField === 1 && typeof key.char === "string") {
          this.projectName += key.char;
          this.forceConfirmPending = false;
        } else if (this.activeField === 2 && key.char === " ") {
          this.toggleForce();
        }
        break;
      case "backspace":
        if (this.activeField === 1) {
          this.projectName = this.projectName.slice(0, -1);
          this.forceConfirmPending = false;
        }
        break;
      case "enter":
        await this.submit();
        return;
      case "escape":
        this.ctx.shell.pop();
        return;
      default:
        break;
    }
    this.ctx.shell.requestRepaint();
  }
}
