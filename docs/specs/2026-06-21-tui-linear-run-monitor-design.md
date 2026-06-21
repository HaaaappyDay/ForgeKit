# ForgeKit TUI Linear Run Monitor Design

Status: draft
Date: 2026-06-21
Scope: v1 of the ForgeKit TUI, a read-only real-time monitor for a single linear run

## Context

The TUI interface foundation (`docs/specs/2026-06-19-tui-interface-foundation-design.draft.md`)
is implemented: a reusable core API (`src/core.ts`), a structured run event protocol
(`forgekit.run-event.v1` with `events.jsonl` plus in-memory observers), read-only artifact
and configuration discovery, and a structured error model. The full suite passes
(`npm test`, 89 tests), including ordered `events.jsonl` emission.

With those stable surfaces in place, this spec defines the first TUI. The goal is the
smallest end-to-end useful product: a real-time monitor that attaches to one run and
shows its progress and artifacts without scraping human-oriented CLI text.

## Goals

- Attach to a single run by id and show its live progress.
- Render linear (`forgekit.run.v1`) run structure: steps, attempts, status, budget.
- Follow run events in real time and refresh authoritative state from `run.json`.
- View text artifacts (prompt, handoff, output, validation, summary) inside the TUI.
- Work for both in-progress and already-completed runs.
- Stay zero-dependency and read-only; never mutate run state or project files.

## Non-Goals

- Do not launch workflows from the TUI (launch stays in `forge workflow start`).
- Do not retry runs from the TUI (retry stays in `forge run retry`).
- Do not browse or edit configuration (workflows, roles, adapters) in v1.
- Do not run adapter probes in v1.
- Do not render agentic (`forgekit.run.v2`) graph runs in v1.
- Do not add any runtime dependency (no Ink, blessed, or similar).
- Do not change MVP-0 `no_write_intent` behavior or any runner logic.

## Scope Summary

| Dimension | Decision |
| --- | --- |
| Purpose | Read-only real-time monitor: live progress + artifact viewing |
| Entry | `forge tui <run-id>`, separate process, tail `events.jsonl` + reload `run.json` |
| Applicability | In-progress and completed runs |
| Run type | Linear `forgekit.run.v1` only |
| Tech | Zero-dependency raw ANSI |
| Artifacts | In-TUI scrollable text reader; `raw.log` shows trailing lines only |
| Excluded | In-TUI launch/retry/config/probe, config editing, agentic graph, token streaming |

## Chosen Approach

The monitor is a separate process that attaches to a run already started by the CLI.
The CLI writes `events.jsonl` during the run; the monitor tails that file for low-latency
updates and reloads `run.json` for authoritative state. This matches the foundation spec's
external process / file protocol and keeps the runner and the monitor fully decoupled.

Live update mechanism: hybrid. Use `fs.watch` on `events.jsonl` as the primary trigger,
plus a low-frequency poll (about once per second) as a fallback so missed `fs.watch`
notifications on Linux/Raspberry Pi or network filesystems do not stall the view. Repaint
through the terminal alternate screen buffer with cursor-home positioning rather than a
full clear, to avoid flicker. Repaints are throttled (coalesced) so bursts of events
produce one frame.

## Architecture

Layered, zero-dependency, read-only. All run and artifact reads go through the existing
core API; the TUI adds no new persistence and no new mutation paths.

### Entry: `src/tui-command.ts`

- Parse `<run-id>` from args.
- Resolve the run with `getRunSnapshot(runId)`. If not found, surface the
  `run_not_found` error. If the run is `forgekit.run.v2`, print a clear "v1 monitor does
  not support agentic runs yet" message and exit non-zero.
- Enter the alternate screen, hide the cursor, set raw/keypress mode.
- Start the app loop (data source + render + input).
- On exit (`q`, Ctrl-C, or error) restore the terminal: leave alternate screen, show
  cursor, restore mode. Restoration must run on all exit paths.

The CLI facade (`src/cli.ts`) gains one dispatch branch (`args[0] === "tui"`) and a help
line `forge tui <run-id>`.

### Data layer: `src/tui/run-source.ts`

- Reads `run.json` via `getRunSnapshot` and tails `events.jsonl` via the exported
  `runEventsPath`.
- Maintains an in-memory tail offset so only newly appended event lines are parsed.
- Watches `events.jsonl` with `fs.watch`; a ~1s interval poll re-checks file size as a
  fallback. Both paths funnel into one "refresh" routine.
- Produces a `MonitorViewModel`: run id, workflow id, run status, ordered step list with
  per-step status / active attempt / attempt count, budget counters and `exceeded` keys,
  and a bounded buffer of the most recent events for an activity feed.
- Emits a change signal to the app loop, which schedules a throttled repaint.

### Artifact layer

Reuses `getRunArtifacts(runId)` to list artifacts for the selected step/attempt and
`readRunArtifact(runId, ref)` to read content. For `raw.log` (type `stdout`) and other
potentially large logs, only the trailing N lines are loaded and rendered. Text artifacts
(`prompt.md`, `handoff.json`, `output.md`, `validation.json`, `summary.md`) are read in
full and shown in the reader.

### Render layer: `src/tui/render.ts`

Pure functions mapping `MonitorViewModel` (and reader state) to an ANSI frame string. No
I/O. Two views:

1. Monitor view: header (run id, workflow, status, elapsed/duration), step list with
   status glyphs and the active attempt, a budget line (invocations/retries/output bytes
   vs limits, with exceeded keys highlighted), and a recent-events activity feed.
2. Artifact reader: a scrollable pager for the selected artifact, with a title bar
   (ref, type, size) and scroll position indicator.

Keeping render as pure `state -> string` makes it snapshot-testable and keeps ANSI
sequences out of the data layer.

### Input layer: `src/tui/input.ts`

Uses `node:readline` keypress events:

- Up/Down: move selection in the step list (monitor view) or scroll (reader view).
- Enter: open the artifact list / reader for the selected step's active attempt.
- Esc: return from reader to monitor view.
- `g` / `G`: jump to top / bottom in the reader.
- `q` or Ctrl-C: quit and restore the terminal.

Input is decoupled from rendering: keypresses mutate a small app/UI state object, which
triggers a repaint.

## Run Event Usage

The monitor consumes `forgekit.run-event.v1` records. For v1 it cares primarily about the
linear lifecycle types already emitted by the runner: `run_created`, `run_started`,
`repo_context_collected`, `step_started`, `attempt_started`,
`adapter_invocation_started`, `adapter_invocation_completed`, `validation_started`,
`validation_completed`, `self_correction_started`, `artifact_written`, `step_completed`,
`step_failed`, `step_skipped`, `budget_exceeded`, `run_completed`, `run_failed`. Unknown
or agentic-only event types are tolerated (shown in the feed by `type`/`message`) but do
not drive structural rendering. `run.json` remains the authoritative state; events drive
liveness and the activity feed.

## Error Handling

- Missing run: report `run_not_found` and exit non-zero before entering the alternate
  screen.
- Agentic run id: explicit unsupported-in-v1 message, exit non-zero.
- Missing `events.jsonl` (e.g. a run that predates event writing, or a completed run):
  fall back to a one-shot `run.json` render with a note that no live event stream is
  available; the monitor still works as a post-mortem viewer.
- Artifact read failure (`artifact_not_found`): show the error inline in the reader and
  return to the monitor view; never crash the loop.
- Any uncaught error in the loop restores the terminal before propagating.

## Testing Strategy

- Data layer: build fixture run directories under a temp dir (a `run.json` plus an
  `events.jsonl`), then assert the synthesized `MonitorViewModel` is correct, that tailing
  only parses newly appended lines, and that the poll fallback picks up appended events.
- Render layer: snapshot pure `viewModel -> frame` output for representative states
  (running, failed with skipped downstream, completed, budget exceeded) and for the
  artifact reader (scroll positions, large `raw.log` tail).
- Error paths: missing run id, agentic run id, missing `events.jsonl`, artifact not found.
- No real TTY interaction is tested; input handling is exercised by feeding synthetic
  keypress events into the state reducer.

## Acceptance Criteria

- `forge tui <run-id>` attaches to an existing linear run and renders its steps, statuses,
  active attempt, and budget.
- While a run is in progress (events appended to `events.jsonl`), the monitor reflects new
  steps/attempts and status changes without restart.
- A completed run with no live writer still renders fully from `run.json`.
- Selecting a step opens its artifacts; text artifacts render in a scrollable reader and
  `raw.log` shows only trailing lines.
- An agentic run id produces a clear unsupported message and non-zero exit, not a crash.
- The terminal is restored cleanly on quit, Ctrl-C, and error.
- No runtime dependency is added; existing tests continue to pass.

## Rollout Notes

Implement in small slices:

1. `run-source.ts` view-model synthesis from `run.json` + `events.jsonl` (no watch yet),
   with data-layer tests.
2. `render.ts` pure monitor view + snapshot tests.
3. `tui-command.ts` wiring, alternate screen lifecycle, and CLI dispatch for a one-shot
   render.
4. Live updates: `fs.watch` + poll fallback + throttled repaint.
5. Artifact reader view, input navigation, and reader tests.

Later phases (out of scope here) can add the agentic graph view, in-TUI launch/retry, and
configuration browsing, reusing the same core API.
