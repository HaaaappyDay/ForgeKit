import readline, { type Key } from "node:readline";
import { ANSI, composeFrame, truncate, type TerminalDimensions } from "./render.js";
import type { KeyName } from "./input.js";
import type { KeyInput, Screen, ShellApi } from "./screen.js";

export interface ShellOptions {
  projectRoot: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

const REPAINT_THROTTLE_MS = 50;
const LIVE_RUN_QUIT_MESSAGE = "warning: Live run is still running. Press q/Ctrl-C again to quit and stop it, or Esc to stay.";

function withTransientLine(
  lines: string[],
  line: string,
  dims: TerminalDimensions
): string[] {
  if (!line) return lines;
  const nextLine = truncate(line, dims.cols);
  if (lines.length >= dims.rows && dims.rows > 1) {
    const next = [...lines];
    next[dims.rows - 2] = nextLine;
    return next;
  }
  return [...lines, nextLine];
}

export function withTransientError(
  lines: string[],
  message: string,
  dims: TerminalDimensions
): string[] {
  return withTransientLine(lines, message ? `error: ${message}` : "", dims);
}

function mapKeyInput(str: string | undefined, key: Key): KeyInput {
  if (key.ctrl && key.name === "c") return { name: "quit" };
  switch (key.name) {
    case "up":
      return { name: "up" };
    case "down":
      return { name: "down" };
    case "left":
      return { name: "left" };
    case "right":
      return { name: "right" };
    case "return":
    case "enter":
      return { name: "enter" };
    case "escape":
      return { name: "escape" };
    case "tab":
      return { name: "tab" };
    case "backspace":
      return { name: "backspace" };
    default:
      break;
  }
  // Note: 'g'/'G' are intentionally NOT mapped to top/bottom here so they can
  // be typed into text fields. Scrolling screens translate the 'g'/'G' chars
  // into top/bottom themselves (see monitor/config/adapters screens).
  // Printable single character (covers letters, digits, punctuation, space).
  if (typeof str === "string" && str.length === 1 && !key.ctrl && !key.meta) {
    const code = str.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      return { name: "char", char: str };
    }
  }
  return { name: "other" };
}

/**
 * Owns the terminal lifecycle and a stack of screens. Maps raw keypresses to
 * `KeyInput`, routes them to the active screen, and repaints (throttled) by
 * framing the active screen's content lines. The only TTY-coupled module.
 */
export class TuiShell implements ShellApi {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly projectRoot: string;
  private readonly stack: Screen[] = [];

  private repaintScheduled = false;
  private stopped = false;
  private mounted = false;
  private onKeypress?: (str: string | undefined, key: Key) => void;
  private onResize?: () => void;
  private resolveExit?: () => void;
  private transientError = "";
  private activeLiveRuns = 0;
  private liveQuitConfirmPending = false;

  constructor(options: ShellOptions) {
    this.projectRoot = options.projectRoot;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  dims(): TerminalDimensions {
    return { rows: this.output.rows ?? 24, cols: this.output.columns ?? 80 };
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  private active(): Screen | undefined {
    return this.stack.at(-1);
  }

  push(screen: Screen): void {
    this.stack.push(screen);
    void this.enter(screen);
  }

  replace(screen: Screen): void {
    const current = this.stack.pop();
    if (current?.onExit) current.onExit();
    this.stack.push(screen);
    void this.enter(screen);
  }

  pop(): void {
    const current = this.stack.pop();
    if (current?.onExit) current.onExit();
    if (this.stack.length === 0) {
      this.quit();
      return;
    }
    this.requestRepaint();
  }

  quit(): void {
    this.stop();
  }

  beginLiveRun(): () => void {
    this.activeLiveRuns += 1;
    this.liveQuitConfirmPending = false;
    this.requestRepaint();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeLiveRuns = Math.max(0, this.activeLiveRuns - 1);
      if (this.activeLiveRuns === 0) this.liveQuitConfirmPending = false;
      this.requestRepaint();
    };
  }

  private confirmQuitIfLiveRunsActive(): boolean {
    if (this.activeLiveRuns === 0) return true;
    if (this.liveQuitConfirmPending) return true;
    this.liveQuitConfirmPending = true;
    this.requestRepaint();
    return false;
  }

  private clearLiveQuitConfirmation(): void {
    if (!this.liveQuitConfirmPending) return;
    this.liveQuitConfirmPending = false;
    this.requestRepaint();
  }

  async requestQuit(): Promise<void> {
    const screen = this.active();
    if (!screen) {
      if (this.confirmQuitIfLiveRunsActive()) this.quit();
      return;
    }
    let shouldQuit = true;
    try {
      shouldQuit = screen.requestQuit ? await screen.requestQuit() : true;
    } catch (error) {
      this.transientError = error instanceof Error ? error.message : String(error);
      shouldQuit = false;
    }
    if (!shouldQuit) {
      this.requestRepaint();
      return;
    }
    if (this.confirmQuitIfLiveRunsActive()) this.quit();
  }

  requestRepaint(): void {
    if (this.repaintScheduled || this.stopped) return;
    this.repaintScheduled = true;
    setTimeout(() => {
      this.repaintScheduled = false;
      this.repaint();
    }, REPAINT_THROTTLE_MS);
  }

  private async enter(screen: Screen): Promise<void> {
    if (screen.onEnter) {
      try {
        await screen.onEnter();
      } catch (error) {
        this.transientError = error instanceof Error ? error.message : String(error);
      }
    }
    this.requestRepaint();
  }

  private repaint(): void {
    if (this.stopped) return;
    const screen = this.active();
    if (!screen) return;
    const dims = this.dims();
    let lines: string[];
    try {
      lines = screen.render(dims);
    } catch (error) {
      lines = [`Render error: ${error instanceof Error ? error.message : String(error)}`];
    }
    lines = this.liveQuitConfirmPending
      ? withTransientLine(lines, LIVE_RUN_QUIT_MESSAGE, dims)
      : withTransientError(lines, this.transientError, dims);
    this.output.write(composeFrame(lines, dims));
  }

  private async dispatch(key: KeyInput): Promise<void> {
    const screen = this.active();
    if (!screen) {
      this.quit();
      return;
    }
    if (this.liveQuitConfirmPending && key.name === "escape") {
      this.clearLiveQuitConfirmation();
      return;
    }
    if (key.name === "quit") {
      await this.requestQuit();
      return;
    }
    const quitKey = key.name === "char" && key.char === "q";
    const liveQuitPendingBefore = this.liveQuitConfirmPending;
    try {
      await screen.handleKey(key);
      if (!this.liveQuitConfirmPending) this.transientError = "";
    } catch (error) {
      this.transientError = error instanceof Error ? error.message : String(error);
    }
    if (!this.stopped && liveQuitPendingBefore && !quitKey && this.liveQuitConfirmPending) {
      this.clearLiveQuitConfirmation();
    }
    this.requestRepaint();
  }

  async run(initial: Screen): Promise<void> {
    if (this.mounted) return;
    this.mounted = true;

    this.output.write(ANSI.enterAltScreen + ANSI.hideCursor);
    if (this.input.isTTY) this.input.setRawMode(true);
    readline.emitKeypressEvents(this.input);
    this.input.resume();

    this.onKeypress = (str, key) => {
      void this.dispatch(mapKeyInput(str, key));
    };
    this.input.on("keypress", this.onKeypress);

    this.onResize = () => this.requestRepaint();
    this.output.on("resize", this.onResize);

    this.push(initial);

    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    while (this.stack.length > 0) {
      const screen = this.stack.pop();
      if (screen?.onExit) screen.onExit();
    }
    if (this.onKeypress) this.input.off("keypress", this.onKeypress);
    if (this.onResize) this.output.off("resize", this.onResize);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    this.output.write(ANSI.showCursor + ANSI.leaveAltScreen);
    if (this.resolveExit) this.resolveExit();
  }
}

/** Builds a ScreenContext-compatible accessor bundle from a shell. */
export function shellContext(shell: TuiShell): {
  projectRoot: string;
  shell: ShellApi;
  dims: () => TerminalDimensions;
} {
  return {
    projectRoot: shell.getProjectRoot(),
    shell,
    dims: () => shell.dims()
  };
}
