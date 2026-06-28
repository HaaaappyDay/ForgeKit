import type { TerminalDimensions } from "./render.js";
import type { KeyName } from "./input.js";

/** A single key event delivered to a screen. `char` carries the printable
 *  character when `name === "char"` (used by text input fields). */
export interface KeyInput {
  name: KeyName;
  char?: string;
}

/** The subset of the shell exposed to screens. */
export interface ShellApi {
  push(screen: Screen): void;
  pop(): void;
  replace(screen: Screen): void;
  requestQuit(): void | Promise<void>;
  quit(): void;
  requestRepaint(): void;
  beginLiveRun(): () => void;
}

export interface ScreenContext {
  projectRoot: string;
  shell: ShellApi;
  dims(): TerminalDimensions;
}

export interface Screen {
  readonly title: string;
  render(dims: TerminalDimensions): string[];
  handleKey(key: KeyInput): void | Promise<void>;
  requestQuit?(): boolean | Promise<boolean>;
  onEnter?(): void | Promise<void>;
  onExit?(): void;
}
