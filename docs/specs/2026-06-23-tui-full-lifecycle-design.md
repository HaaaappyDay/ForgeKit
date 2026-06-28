# ForgeKit Full-Lifecycle TUI Design

Status: draft
Date: 2026-06-23
Scope: v2 of the ForgeKit TUI — a unified, interactive terminal app covering
project init, run launch, real-time monitoring, history, config browsing, and
adapter probing. The CLI continues to work unchanged alongside the TUI.

> This document is intentionally self-contained. It restates the relevant
> existing code, APIs, and data shapes so the work can be completed from this
> file alone, without prior conversation context. A resumable progress
> checklist is at the end.

## 1. Background and current state

ForgeKit is a zero-runtime-dependency Node.js (`>=20`) CLI written in TypeScript
(native ESM, `.js` import specifiers, 2-space indent, double quotes, semicolons).
Source in `src/`, tests in `tests/` (`node:test` + `node:assert/strict`),
versioned schemas in `schemas/`. Build: `npm run build` (tsc to `dist/`).
Test: `npm test` (compiles to `.tmp/ts-tests/` then `node --test`). Typecheck:
`npm run typecheck`.

### 1.1 What already exists (TUI v1: read-only linear monitor)

Committed in `7c2d2dc` (design spec `8e5e00d`). A zero-dependency ANSI monitor
launched by `forge tui <run-id>` that tails `events.jsonl` and renders a linear
run's steps plus a scrollable artifact reader. Existing files:

- `src/tui/view-model.ts` — pure `buildMonitorViewModel(run: Run, events: RunEvent[], opts?) -> MonitorViewModel`. Types: `MonitorViewModel`, `MonitorStepView`, `MonitorBudgetView`, `MonitorEventView`.
- `src/tui/run-source.ts` — `RunMonitorSource` class: `readRun()` (linear only; throws on agentic), `readNewEvents()` (byte-offset tailing with partial-line carry), `hasEventStream()`, `start(onChange)`, `stop()`. Constructor `{ runId, projectRoot?, pollIntervalMs? }`.
- `src/tui/render.ts` — pure render: `renderMonitor`, `renderReader`, `composeFrame`, `renderFrame`; `ANSI` control strings (`enterAltScreen`, `leaveAltScreen`, `hideCursor`, `showCursor`, `cursorHome`, `clearToEnd`, `clearLine`); `TerminalDimensions { rows, cols }`.
- `src/tui/input.ts` — UI state + pure key reducer: `TuiView`, `KeyName`, `ReaderArtifact`, `ReaderState`, `UiState`, `InputEffect`, `ReduceContext`, `initialUiState()`, `maxScrollTop()`, `reduceKey()`.
- `src/tui/app.ts` — `RunMonitorApp` class: owns terminal lifecycle (alt screen, raw mode, keypress via `node:readline`), throttled repaint (50ms), artifact reader loading (tails `stdout`/`stderr` to last 200 lines), `mount()` and `stop()`.
- `src/tui-command.ts` — `runTuiCommand(args, cwd?)`: parses `<run-id>`, guards agentic and non-TTY, runs `RunMonitorApp`, restores terminal on SIGINT/SIGTERM.
- `src/cli.ts` — dispatch branch `args[0] === "tui"` and help line `forge tui <run-id>`.
- `tests/tui.test.ts` — view-model, render, reducer, and tailing tests.

This v2 refactors `app.ts` into a reusable shell + a "monitor screen" and keeps
`view-model.ts`, `render.ts`, `input.ts`, `run-source.ts` (extended, not rewritten).

### 1.2 Core API available (no new domain logic needed)

`src/core.ts` already exposes everything the TUI needs. Signatures:

```ts
startWorkflowRun(options: {
  workflowId: string; taskInput: string; projectRoot?: string;
  env?: NodeJS.ProcessEnv; eventObservers?: RunEventObserver[];
  eventSinks?: RunEventSink[]; writeEventsJsonl?: boolean;
}): Promise<Run | AgenticRun>;

retryRun(options: { runId: string; projectRoot?: string; /* + observers/sinks/writeEventsJsonl */ }): Promise<Run | AgenticRun>;

buildWorkflowRunPlan(options: { workflowId: string; taskInput: string; projectRoot?: string }): Promise<RunPlan | AgenticRunPlan>;

getRunSnapshot(runId: string, projectRoot?): Promise<Run | AgenticRun>;
listRuns(projectRoot?): Promise<Array<Run | AgenticRun>>;
getRunArtifacts(runId: string, projectRoot?): Promise<RunArtifact[]>;
readRunArtifact(runId: string, artifactRef: string, projectRoot?): Promise<RunArtifactContent>;

listWorkflows(projectRoot?): Promise<WorkflowDiscoveryEntry[]>;
getWorkflow(id: string, projectRoot?): Promise<ConfigDetail<WorkflowConfig>>;
listRoles(projectRoot?): Promise<RoleDiscoveryEntry[]>;
getRole(id: string, projectRoot?): Promise<ConfigDetail<RoleConfig>>;
listAdapters(projectRoot?): Promise<AdapterDiscoveryEntry[]>;
getAdapter(id: string, projectRoot?): Promise<ConfigDetail<AdapterConfig>>;
probeAdapter(id: string, projectRoot?): Promise<AdapterProbeResult>;
```

`RunEventObserver = (event: RunEvent) => void | Promise<void>` (from
`src/run-events.ts`). `isAgenticRun(run)` (from `src/run-store.ts`) discriminates
`Run` vs `AgenticRun`. Relevant types live in `src/types.ts`: `Run`,
`AgenticRun`, `RunEvent`, `RunPlan`, `AgenticRunPlan`, `WorkflowDiscoveryEntry`,
`RoleDiscoveryEntry`, `AdapterDiscoveryEntry`, `ConfigDetail<T>`,
`AdapterProbeResult`, `RunArtifact`, `RunArtifactContent`, `TemplateId`,
`AgenticRun.nodes: RunNode[]`, `AgenticRun.edges: RunEdge[]`,
`RunNode { node_seq, node_id, role_id, status, entry_reason, acceptance, attempts, chosen_next_role, ... }`,
`RunEdge { from, to, type, reason? }`, `AgenticRun.escalation`,
`AgenticRun.active_cursor`.

The only missing reusable API is project init (currently only the CLI command
`runInitCommand` in `src/init-command.ts`). See §6.

## 2. Goals

- One interactive TUI (`forge tui`) covering: project init, launch wizard,
  real-time monitor, history browse, read-only config browse, adapter probe.
- Same-process execution: the TUI runs workflows in-process via
  `startWorkflowRun` and updates the monitor live through an event observer
  (no stdout scraping; matches the foundation spec's same-process integration).
- Support both linear (`forgekit.run.v1`) and agentic (`forgekit.run.v2`) runs.
  Agentic runs render as a node list / timeline (no graph drawing).
- Keep the CLI fully working and unchanged; TUI and CLI are parallel surfaces.
- Stay zero-runtime-dependency; pure ANSI rendering.
- Preserve v1 behavior: `forge tui <run-id>` still attaches directly to a run.

## 3. Non-Goals

- No retry from the TUI in v2 (CLI `forge run retry` remains; can be added later).
- No config editing (browse only).
- No agentic edge/graph drawing (node list/timeline only).
- No token-level streaming.
- No new runtime dependency (no Ink/blessed).
- No change to runner logic, `no_write_intent` behavior, or schemas.

## 4. Scope decisions (locked)

| Dimension | Decision |
| --- | --- |
| Capabilities | init, launch wizard, monitor, history, config browse (read-only), adapter probe |
| Excluded | retry, config editing, agentic graph drawing |
| Execution | in-process: `startWorkflowRun` + event observer feeds the monitor live |
| Run types | linear + agentic; agentic shown as node list/timeline |
| Task input | inline single-line text OR a task file path (toggle in wizard) |
| Tech | zero-dependency raw ANSI (continues v1) |
| Entry | `forge tui` → home; `forge tui <run-id>` → monitor (back-compat) |

## 5. Architecture

Approach A: a unified app shell with a screen router. One process owns the
terminal; a stack of screens handles rendering and input. Each screen keeps the
v1 pattern: pure state + pure render + a key reducer, with async actions calling
the core API.

### 5.1 Shell — `src/tui/shell.ts`

Extracted from the current `app.ts`. Responsibilities:

- Terminal lifecycle: enter alt screen + hide cursor on start; on exit restore
  cursor + leave alt screen. Must restore on `q`, Ctrl-C (SIGINT), SIGTERM, and
  any thrown error.
- Raw mode + `readline.emitKeypressEvents(stdin)`; map raw keypresses to the
  `KeyName` union (reuse/extend `mapKey` from `app.ts`), plus printable chars and
  Backspace for text input fields (see wizard/init).
- Screen stack: `push(screen)`, `pop()`, `replace(screen)`. `Esc`/back pops; an
  empty stack quits. `q` requests quit from non-text screens. If any
  TUI-launched live run is still active, the shell requires a second quit request
  before ending the process; `Esc` cancels that pending confirmation.
- Throttled repaint (50ms coalescing) calling the active screen's `render(dims)`
  and writing `composeFrame(...)`.
- Resize handling: listen to `process.stdout` `"resize"` and repaint.
- Dimensions helper: `{ rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 }`.

The shell is the only TTY-coupled module and is not unit-tested.

### 5.2 Screen interface — `src/tui/screen.ts`

```ts
export interface ScreenContext {
  projectRoot: string;
  shell: ShellApi;            // push/pop/replace/quit/requestRepaint
  dims(): TerminalDimensions;
}

export interface Screen {
  readonly title: string;
  render(dims: TerminalDimensions): string[];   // content lines (no cursor codes)
  handleKey(key: KeyInput): void | Promise<void>; // mutates state, may call shell
  onEnter?(): void | Promise<void>;
  onExit?(): void;
}
```

`KeyInput` extends `KeyName` with `{ name: KeyName; char?: string }` so text
fields receive printable characters and Backspace. `ShellApi` is the subset of
the shell exposed to screens: `push`, `pop`, `replace`, `quit`,
`requestRepaint`. Screens call `requestRepaint()` after async state changes.

Screens own their state and render pure content lines; the shell frames and
paints. Each screen's reducer/state should be factored into a pure,
unit-testable function where practical (as in v1's `reduceKey`).

### 5.3 Dual-source monitor

Because execution is in-process, the monitor screen accepts events from two
interchangeable sources, both feeding the same pure view-model:

- Live source (run started in this session): pass an `eventObservers` callback to
  `startWorkflowRun`/`retryRun` that appends each `RunEvent` to the monitor's
  in-memory buffer and triggers a repaint. Authoritative state comes from the
  resolved `Run`/`AgenticRun` promise and from periodic `getRunSnapshot`.
- File source (history/attach): reuse `RunMonitorSource` to tail `events.jsonl`
  and reload `run.json`.

Define a small `MonitorFeed` abstraction:

```ts
export interface MonitorFeed {
  load(): Promise<Run | AgenticRun>;       // initial authoritative snapshot
  poll(): Promise<{ run: Run | AgenticRun; newEvents: RunEvent[] }>;
  start(onChange: () => void): void;
  stop(): void;
}
```

- `FileMonitorFeed` wraps `RunMonitorSource` (extend it to also read agentic runs:
  add `readAnyRun`-based loading instead of throwing on agentic).
- `LiveMonitorFeed` is fed by the observer: `poll()` drains the buffered events
  and returns the latest known run (updated on observer events and/or a periodic
  `getRunSnapshot`). `start` registers a timer/observer trigger.

The monitor screen is feed-agnostic and run-type-agnostic (branches on
`isAgenticRun`).

### 5.4 Module/file plan (exact paths)

New:

- `src/tui/shell.ts`
- `src/tui/screen.ts`
- `src/tui/monitor-feed.ts` (`MonitorFeed`, `FileMonitorFeed`, `LiveMonitorFeed`)
- `src/tui/view-model-agentic.ts` (agentic node-list view-model + pure builder)
- `src/tui/screens/home.ts`
- `src/tui/screens/wizard.ts`
- `src/tui/screens/monitor.ts` (refactor of v1 `RunMonitorApp` rendering/state)
- `src/tui/screens/history.ts`
- `src/tui/screens/config.ts`
- `src/tui/screens/adapters.ts`
- `src/tui/screens/init.ts`
- `src/core-init.ts` (reusable init API; see §6)
- tests: `tests/tui-shell-screens.test.ts` (or per-screen files)

Changed:

- `src/tui/app.ts` — replaced by `shell.ts` + `screens/monitor.ts`; remove or
  reduce to a thin re-export. (Keep `tests/tui.test.ts` passing by preserving the
  pure functions it imports: `view-model.ts`, `render.ts`, `input.ts`, and
  `RunMonitorSource` behavior.)
- `src/tui/render.ts` — add render helpers for new screens (menus, lists, forms,
  run-plan preview, agentic node list, probe result). Keep existing exports.
- `src/tui/input.ts` — extend `KeyName` and reducer helpers as needed; keep
  existing exports/behavior.
- `src/tui/run-source.ts` — add agentic-tolerant loading (do not break
  `readRun()` linear contract used by tests; add a separate `readAnyRunSnapshot()`).
- `src/tui-command.ts` — `forge tui` (no arg) → push Home; `forge tui <run-id>`
  → push Monitor with a `FileMonitorFeed` (back-compat).
- `src/cli.ts` — update help text for `forge tui [<run-id>]`.
- `src/init-command.ts` — delegate to `src/core-init.ts` (§6).

## 6. Init refactor — `src/core-init.ts`

Extract the side-effecting body of `runInitCommand` (currently
`src/init-command.ts` lines ~133–173) into a reusable function so both the CLI
and the TUI init screen share it:

```ts
export interface InitProjectOptions {
  templateId: TemplateId;
  projectName: string;
  force: boolean;
  projectRoot?: string; // defaults to process.cwd()
}
export interface InitProjectResult { templateId: TemplateId; forgekitRoot: string; }

export async function initProject(options: InitProjectOptions): Promise<InitProjectResult>;
```

Behavior (preserve exactly): if not `force` and `.forgekit` has entries, throw
`".forgekit already exists. Use --force to write template files into it."`;
create `roles/ workflows/ adapters/ examples/` and `.gitkeep` in
`runs/ cache/ tmp/`; write `config.json` and all template files via
`buildTemplate(templateId, projectName)` with schema validation
(`workflowSchemaId` picks v1/v2). `runInitCommand` keeps arg parsing + interactive
template prompt, then calls `initProject`. Keep `tests/init.test.ts` green.

## 7. Screens (state, keys, core calls, layout)

All layouts are content lines; the shell frames them. Footers list key hints.
Standard keys: `Esc` = back/pop, and on Home it requests quit; `q` = request
quit (non-text screens). Long lists scroll with `up/down`; selection marked with
`>`. If an in-process live run is still active, quit requests are guarded by a
shell-level second confirmation even when the user has returned from Monitor to
Home or another screen.

### 7.1 Home — `screens/home.ts`

- `onEnter`: `listRuns(projectRoot)` for the "Recent" panel (best-effort; on
  error, show empty). Detect whether `.forgekit/config.json` exists to show the
  project name (via `getWorkflow`/reading config; or simply attempt and fall back
  to "(uninitialized)").
- State: selected menu index; recent runs (top ~5).
- Menu: `New run`, `History`, `Config`, `Adapters`, `Initialize project`, `Quit`.
- Keys: `up/down` move; `Enter` → push corresponding screen (or request quit);
  `Esc`/`q` request quit.
- Layout: see §1 conversation sketch — title + project, menu, recent list, footer.

### 7.2 Launch wizard — `screens/wizard.ts`

Three sub-steps in one screen with `step: 1|2|3`:

1. Workflow pick: `onEnter` → `listWorkflows`. List id + name + kind (linear vs
   agentic via the entry's schema/version; `step_count` for linear). Invalid
   entries (`validation.valid === false`) are shown but not selectable. `Enter` →
   step 2.
2. Task input: a single-line text field (printable chars + Backspace) OR a file
   path field; `Tab` toggles which field is active. If a file path is given,
   it is read at confirm time (equivalent to `--input-file`). `Enter` → step 3.
   Empty task (and no file) blocks advancing with an inline message.
3. Confirm run plan: `onEnter`(of step 3) → `buildWorkflowRunPlan({ workflowId, taskInput })`.
   Render `RunPlan` (steps, adapters, budgets, warnings) or `AgenticRunPlan`
   (entrypoint, terminal roles, roles + candidates, budgets, warnings).
   `Enter` → start.
- Start: read file if needed; call `startWorkflowRun({ workflowId, taskInput,
  projectRoot, writeEventsJsonl: true, eventObservers: [liveFeed.observer] })`.
  Do NOT await before navigating: create a `LiveMonitorFeed`, `shell.replace(MonitorScreen(liveFeed))`,
  then let the promise resolve in the background; on resolve/reject the feed marks
  the run terminal and the monitor reflects final state. Errors during start
  surface as a `ForgeKitError` message on the monitor screen.
- `Esc` goes back a step (or pops the wizard from step 1).

### 7.3 Monitor — `screens/monitor.ts`

Refactor of v1. Takes a `MonitorFeed` (live or file) and is run-type-agnostic.

- Linear: reuse `buildMonitorViewModel` + `renderMonitor` (steps, budget, events).
- Agentic: use `view-model-agentic.ts` + an agentic renderer (node list/timeline:
  `node_seq node_id (role) [status] phase`; show `acceptance.verdict` and
  `chosen_next_role`; show `escalation` if present; budget with steps/role_visits).
- Artifact reader: reuse v1 `ReaderState` + `renderReader`; `getRunArtifacts` +
  `readRunArtifact`; tail `stdout`/`stderr` to last 200 lines. For agentic,
  artifacts carry `node_id`/`attempt_id`.
- Keys: `up/down` select step/node or scroll reader; `Enter` open artifacts;
  `left/right` switch artifact; `g/G` top/bottom; `Esc` back to previous screen
  (history/home) or, for a live run, back to home. A live run can continue in
  the background only while the TUI process stays alive; quitting the TUI ends
  in-process runs, and that quit is guarded by the shell-level live-run
  confirmation.
- Live behavior: feed pushes events → repaint; on terminal status, stop polling.

### 7.4 History — `screens/history.ts`

- `onEnter`: `listRuns(projectRoot)` (already sorted by update time).
- List rows: `run_id  status  workflow_id  updated_at` (mirror CLI `forge history`).
- `Enter` → push Monitor with a `FileMonitorFeed(run_id)` (read-only attach;
  works for completed and in-progress runs; agentic supported).
- Scroll for long lists.

### 7.5 Config browse — `screens/config.ts`

- Three tabs: Workflows / Roles / Adapters (`left/right` or `Tab` switches tab).
- Lists via `listWorkflows` / `listRoles` / `listAdapters`; show id, key fields,
  and a `valid`/`invalid` marker (from each entry's `validation`).
- `Enter` on an item → detail via `getWorkflow`/`getRole`/`getAdapter`
  (`ConfigDetail<T>`: full parsed config + validation errors). Render as a
  scrollable pretty-printed view (reuse reader-style scrolling).
- Read-only; no editing.

### 7.6 Adapters — `screens/adapters.ts`

- `onEnter`: `listAdapters`. List id, type, command, and validation marker.
- `Enter` → run `probeAdapter(id)` (async; show "probing…"), then render
  `AdapterProbeResult`: overall `ok`, resolved command, each `check`
  (name/status/message), and auth/billing/write_policy notes.
- `Esc` back to list.

### 7.7 Init — `screens/init.ts`

- Form: template select (`TEMPLATE_IDS` from `src/templates.ts`:
  `blank`, `generic-plan-review`, `feature-planning`, `feature-planning-agentic`),
  project name text field (default `basename(projectRoot)`), and a `force` toggle.
- `Enter` → `initProject({ templateId, projectName, force, projectRoot })`.
  On the `.forgekit already exists` error, show the message and hint to enable
  `force`. On success, show confirmation and offer to go to the wizard/home.

## 8. Rendering additions (`render.ts`)

Add pure helpers returning `string[]` (snapshot-testable), reusing `truncate`
and the existing frame/compose machinery:

- `renderMenu(title, items, selectedIndex, dims)`
- `renderList(title, rows, selectedIndex, dims)` (rows are preformatted strings)
- `renderForm(fields, activeField, dims)` (label + value + caret for text fields)
- `renderRunPlan(plan: RunPlan | AgenticRunPlan, dims)`
- `renderAgenticMonitor(model, ui, dims)` (node list/timeline)
- `renderProbeResult(result: AdapterProbeResult, dims)`
- `renderConfigDetail(detail, dims)`

Text-field caret: render the active field's value with a visible cursor marker
(e.g. trailing `_` or inverse space) since the hardware cursor is hidden.

## 9. Testing strategy

Pure, no TTY:

- Init: `initProject` creates the expected tree and is idempotent under `force`;
  rejects without `force` on a populated `.forgekit` (temp dirs). Keep
  `tests/init.test.ts` green.
- Wizard state machine: step transitions, Tab toggle between task/file fields,
  text editing (append/backspace), empty-task guard, plan fetch on step 3.
- Agentic view-model: `buildAgenticMonitorViewModel(run)` projects nodes,
  acceptance, escalation, budget.
- Renderers: snapshot `renderMenu/renderList/renderForm/renderRunPlan/renderAgenticMonitor/renderProbeResult/renderConfigDetail` for representative inputs.
- Monitor feeds: `LiveMonitorFeed` accumulates observer events and returns them
  via `poll()`; `FileMonitorFeed` tails appended events and loads agentic runs.
- Reuse existing `tests/tui.test.ts` (must stay green).

The shell and screen `handleKey` TTY wiring are not unit-tested; smoke-test
non-interactive paths (`forge tui` requires TTY → clean error; `forge tui <run-id>`
still attaches) and verify `npm test` + `npm run typecheck` pass.

## 10. Acceptance criteria

- `forge tui` (TTY) opens Home with a menu and recent runs.
- From Home → New run: pick a workflow, enter a task (or file), see the run plan,
  start, and land on a live monitor that updates as the run progresses (linear
  and agentic).
- From Home → History: pick any run and view it read-only (linear + agentic),
  including artifacts.
- From Home → Config: browse workflows/roles/adapters with validation status and
  detail views; no editing.
- From Home → Adapters: run a probe and see structured check results.
- From Home → Initialize project: create `.forgekit` from a template; the
  `already exists` case is handled with a clear message and `force` option.
- `forge tui <run-id>` still attaches directly to the monitor (back-compat).
- CLI commands are unchanged and their tests still pass.
- No runtime dependency added; `npm test` and `npm run typecheck` pass.
- Terminal is restored cleanly on quit, Ctrl-C, and error from every screen.

## 11. Backward compatibility and known limitations

- CLI and TUI coexist; no CLI behavior changes.
- Quitting the TUI ends in-process runs (their external agent children die with
  the process). This is documented in the usage guide; users who need detached
  runs use the CLI (`forge workflow start`) and attach with `forge tui <run-id>`.
- No retry, no config editing, no agentic graph drawing in v2.

## 12. Implementation slices (ordered; each independently testable)

Build and verify (`npm run typecheck` + `npm test`) after each slice. Keep
existing tests green throughout.

1. Init refactor: add `src/core-init.ts` (`initProject`); make `runInitCommand`
   delegate to it. Tests: init tree + force behavior.
2. Shell + screen plumbing: `src/tui/screen.ts`, `src/tui/shell.ts` (extract from
   `app.ts`), screen stack + key routing + repaint + terminal lifecycle. Provide a
   trivial placeholder Home to prove the loop.
3. Monitor refactor: move v1 monitor state/rendering into `screens/monitor.ts`
   behind a `MonitorFeed`; implement `FileMonitorFeed` (extend `run-source.ts`).
   Rewire `forge tui <run-id>` through the shell. Keep `tests/tui.test.ts` green.
4. Agentic monitor: `view-model-agentic.ts` + `renderAgenticMonitor`; monitor
   screen branches on `isAgenticRun`; `FileMonitorFeed` loads agentic runs.
5. Home screen: menu + recent runs (`listRuns`); navigation to other screens.
6. History screen: `listRuns` list → attach Monitor via `FileMonitorFeed`.
7. Config screen: tabs + lists (`listWorkflows/Roles/Adapters`) + detail
   (`getWorkflow/Role/Adapter`) with `renderList`/`renderConfigDetail`.
8. Adapters screen: list + `probeAdapter` + `renderProbeResult`.
9. Launch wizard: `screens/wizard.ts` (3 steps) + `renderForm`/`renderRunPlan`;
   `LiveMonitorFeed` + observer wiring; `startWorkflowRun` then `shell.replace`
   to the live Monitor.
10. Init screen: `screens/init.ts` form → `initProject`.
11. Entry + docs: `forge tui` → Home, `forge tui <run-id>` → Monitor; update
    `src/cli.ts` help and add a TUI dashboard section to `docs/usage-guide.md`.

## 13. Progress checklist (update as slices land)

- [x] 1. Init refactor (`core-init.ts`)
- [x] 2. Shell + screen interface
- [x] 3. Monitor refactor + `FileMonitorFeed` (linear, back-compat)
- [x] 4. Agentic monitor view-model + renderer
- [x] 5. Home screen
- [x] 6. History screen
- [x] 7. Config browse screen
- [x] 8. Adapters probe screen
- [x] 9. Launch wizard + `LiveMonitorFeed`
- [x] 10. Init screen
- [x] 11. Entry wiring + usage-guide docs
- [ ] Final: `npm run typecheck` and TUI-focused tests green; full `npm test`
  currently still fails outside the TUI changes in `agentic-runner.test.js` and
  `agentic-template.test.js`.
