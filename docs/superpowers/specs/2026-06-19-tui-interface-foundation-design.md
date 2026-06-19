# ForgeKit TUI Interface Foundation Design

Status: approved for spec review
Date: 2026-06-19
Scope: post-MVP-0 interface foundation for a future TUI

## Context

ForgeKit MVP-0 proves that a local CLI can initialize project config, run a linear role-based workflow, call external CLI agents, validate `handoff.v1`, persist run artifacts, show history, and retry failed runs. The current implementation already has the beginnings of a workflow kernel, but the public surface is still mostly CLI text output plus files under `.forgekit/runs/<run-id>/`.

The future product direction is a TUI. The next phase should not build that TUI yet. It should make the runner, configuration, run state, artifacts, and failures observable through stable interfaces that a TUI can consume without scraping human-readable CLI output.

## Goals

- Make running workflow state observable in real time.
- Keep the CLI working as a thin facade over reusable core APIs.
- Support both same-process Node TUI integration and external process/file-based observation.
- Add read-only configuration discovery for workflows, roles, adapters, and adapter probes.
- Establish stable event and error shapes before adding a full TUI.
- Preserve MVP-0 behavior: linear workflows, no write intent, soft budgets, run artifacts, and retry semantics.

## Non-Goals

- Do not build the TUI.
- Do not add configuration editing.
- Do not add DAG branching, parallel execution, or scheduling changes.
- Do not add token-level streaming.
- Do not copy large adapter raw output into event records.
- Do not change the MVP-0 effective `no_write_intent` workflow behavior.

## Chosen Approach

Use a combined core API and file event protocol.

The core API is the primary integration surface for a future Node-based TUI. The same API also emits structured run events through observer sinks. The CLI uses the core API and can write those events to `.forgekit/runs/<run-id>/events.jsonl`, which gives external TUI processes and scripts a stable file protocol.

This balances two needs:

- A same-process TUI can call ForgeKit directly without parsing stdout.
- A separate process can still monitor a run by reading `events.jsonl` and `run.json`.

## Architecture

### Core API

The core layer owns reusable operations that are currently split across command handlers and runner modules. CLI commands become argument parsing and output formatting wrappers.

Initial API surface:

- `startWorkflowRun(options)` starts a workflow and returns the final `Run`.
- `retryRun(options)` retries a failed run and returns the final `Run`.
- `buildWorkflowRunPlan(options)` returns a structured run plan for confirmation screens.
- `getRunSnapshot(runId)` reads the current `run.json`.
- `listRuns()` returns known runs sorted by update time.
- `getRunArtifacts(runId)` lists artifact references for a run.
- `readRunArtifact(runId, artifactRef)` reads a specific artifact by reference.
- `listWorkflows()` and `getWorkflow(id)` discover workflow config.
- `listRoles()` and `getRole(id)` discover role config.
- `listAdapters()` and `getAdapter(id)` discover adapter config.
- `probeAdapter(id)` runs the existing adapter probe through a reusable API.

### Event Sink

Workflow execution emits structured events through an observer interface. The first sinks should be:

- In-memory callback observer for tests and same-process TUI use.
- JSONL file sink for `.forgekit/runs/<run-id>/events.jsonl`.

Events are append-only facts. `run.json` remains the current state snapshot. A TUI should follow events for live updates and refresh `run.json` when it needs authoritative state.

### CLI Facade

The CLI keeps current commands and behavior while gaining machine-readable output where useful.

Important additions:

- JSON output for history and configuration discovery commands.
- Run plan JSON output.
- Optional event JSONL writing for workflow start and retry.
- Stable error code output when a command fails in JSON mode.

## Run Event Protocol

Event records use `forgekit.run-event.v1` and are written one JSON object per line:

```json
{
  "schema_version": "forgekit.run-event.v1",
  "event_id": "000001",
  "run_id": "20260619T000000Z-feature-planning",
  "timestamp": "2026-06-19T00:00:00.000Z",
  "type": "step_started",
  "step_id": "technical-design",
  "attempt_id": "attempt-01",
  "message": "Step started",
  "data": {}
}
```

Required fields:

- `schema_version`: always `forgekit.run-event.v1`.
- `event_id`: monotonically increasing within a run.
- `run_id`: run identifier.
- `timestamp`: ISO timestamp.
- `type`: stable event type.
- `message`: short human-readable summary.
- `data`: event-specific structured payload.

Context fields such as `step_id`, `role_id`, `adapter_id`, and `attempt_id` are included when relevant.

Initial event types:

- `run_created`
- `run_started`
- `repo_context_collected`
- `workflow_summary_updated`
- `step_started`
- `attempt_started`
- `adapter_invocation_started`
- `adapter_invocation_completed`
- `validation_started`
- `validation_completed`
- `self_correction_started`
- `artifact_written`
- `step_completed`
- `step_failed`
- `step_skipped`
- `budget_exceeded`
- `run_completed`
- `run_failed`

Large raw logs stay in artifacts. Events reference paths such as `stdout_ref`, `stderr_ref`, `handoff_ref`, `markdown_ref`, and include summary metadata such as byte counts, exit code, duration, and validation validity.

## Error Model

ForgeKit should expose structured errors through API results, run events, and JSON CLI output. The implementation may start with plain objects before introducing custom error classes.

Shape:

```json
{
  "code": "adapter_command_not_found",
  "message": "Command not found or not executable: codex",
  "category": "adapter",
  "retryable": false,
  "details": {
    "adapter_id": "codex-local",
    "command": "codex"
  }
}
```

Initial codes:

- `config_missing`
- `config_invalid`
- `workflow_invalid`
- `role_missing`
- `adapter_missing`
- `adapter_command_not_found`
- `adapter_process_failed`
- `adapter_timeout`
- `handoff_parse_failed`
- `handoff_schema_invalid`
- `handoff_content_invalid`
- `run_not_found`
- `run_not_retryable`
- `artifact_not_found`

This gives a TUI enough information to show actionable states instead of opaque stack traces or unclassified strings.

## Configuration Discovery

Configuration discovery is read-only in this phase.

`listWorkflows()` returns:

- `id`
- `name`
- `version`
- `step_count`
- `path`
- validation status and errors

`listRoles()` returns:

- `id`
- `name`
- `adapter_id`
- `write_policy`
- `path`
- validation status and errors

`listAdapters()` returns:

- `id`
- `type`
- `command`
- `auth`
- `billing`
- `write_policy`
- `path`
- validation status and errors

Detail APIs return the full parsed config plus schema validation results. Discovery should tolerate invalid individual files where possible, returning invalid entries instead of failing the entire list.

## Artifact Access

Artifacts remain stored under `.forgekit/runs/<run-id>/`. The new API should provide a safe reference-based access layer rather than requiring consumers to join paths manually.

The artifact listing should include:

- `summary.md`
- `context/repo-summary.json`
- workflow summary files
- per-attempt `prompt.md`
- per-attempt `raw.log`
- per-attempt `error.log`
- per-attempt `validation.json`
- per-attempt `handoff.json`
- per-attempt `output.md`
- correction prompt and correction logs when present

Each artifact record should include the run-relative ref, type, step id, attempt id when applicable, size when available, and whether the file currently exists.

## Testing Strategy

Core API tests should call the reusable API directly and avoid CLI stdout parsing.

CLI compatibility tests should confirm existing commands still work and that new JSON modes produce stable machine-readable output.

Event tests should run a workflow with a fake adapter and verify:

- `events.jsonl` is created.
- event ids are ordered.
- required fields are present.
- key lifecycle events appear in the expected order.
- artifact refs in events point to files that exist.

Error tests should cover:

- missing config
- invalid config
- missing adapter command
- failed adapter process
- invalid handoff output
- non-retryable run retry
- missing artifact read

Configuration discovery tests should include valid and invalid workflow, role, and adapter files. Invalid entries should be reported with validation errors when discovery can continue.

## Acceptance Criteria

- A fake adapter workflow run produces a valid `run.json`, existing artifacts, and ordered `events.jsonl` records.
- A same-process caller can start a run with an observer callback and receive the same lifecycle events written to JSONL.
- A caller can list workflows, roles, and adapters without running a workflow.
- Invalid individual config files are reported with validation errors when discovery can continue.
- Missing adapter command and invalid handoff failures produce stable error codes in API results, events, and JSON CLI output.
- Existing MVP-0 CLI commands continue to pass their current tests.

## Rollout Notes

This phase should be implemented in small slices:

1. Add event types and file sink while preserving the current runner behavior.
2. Extract core API wrappers around existing workflow, run, history, probe, and config functions.
3. Add read-only artifact and configuration discovery APIs.
4. Add structured errors for the most common failure paths.
5. Add CLI JSON output modes on top of the new APIs.

The TUI should wait until these surfaces are covered by tests and can support a live run monitor without reading human-oriented text output.
