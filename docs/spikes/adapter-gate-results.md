# Adapter Spike Gate Results

Status: complete
Date: 2026-06-18

## Scope

This spike validates the MVP-0 adapter assumptions before production implementation:

- Codex command path and alias lookup
- Codex `exec --json --output-schema`
- Codex `exec resume`
- Claude `-p --resume --output-format stream-json --json-schema`
- External session id capture for `run.json.role_sessions`
- Structured JSON output stability

Raw command logs are kept under `spikes/adapter-gate/logs/` and intentionally ignored.

## Findings

### Command discovery

- `codex` is not visible on the current shell `PATH`.
- Codex is executable through the configured absolute path:
  `/home/lotus/.nvm/versions/node/v24.15.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex`
- Codex version: `codex-cli 0.141.0`
- `claude` is visible at `/home/lotus/.local/bin/claude`.
- Claude Code version: `2.1.150`.

### Codex

- `codex exec --json --output-schema <file>` works with the absolute command path.
- `codex exec resume --json --output-schema <file> <session_id>` works and reuses the same `thread_id`.
- The external session id should be captured from the JSONL event:
  `{"type":"thread.started","thread_id":"..."}`
- `turn.completed.usage` exposes token usage fields. MVP-0 can record these opportunistically while still treating cost/token reporting as soft and adapter-specific.
- `codex exec` in this version does not accept the top-level `-a/--ask-for-approval` option. Adapter command construction must avoid passing that option to `exec`.
- Codex rejected the first schema because a `const` field did not include an explicit `type`. Production schemas should include `type` for every constrained property.

Observed successful Codex session:

```json
{
  "role_sessions": {
    "planner": {
      "role_id": "planner",
      "adapter_id": "codex-local",
      "external_session_id": "019eda76-41a5-7c93-b4bd-6fb071c64730",
      "resume_strategy": "codex_exec_resume",
      "status": "active"
    }
  }
}
```

Structured output stability: Codex completed 2 structured calls after schema correction: initial and resume. Both produced schema-shaped JSON and parseable final-message files.

### Claude Code

- `claude -p --output-format stream-json` requires `--verbose`.
- The local Claude startup hooks require `node` on `PATH` in this environment. The adapter/probe should preserve or explicitly provide the Node runtime path when invoking Claude Code.
- `claude -p --verbose --output-format stream-json --json-schema <schema-json>` starts and emits stream JSON events.
- `claude -p --verbose --resume <session_id> --output-format stream-json --json-schema <schema-json>` starts and emits stream JSON events.
- Current environment is not authenticated for Claude Code:
  `Not logged in - Please run /login`
- Because auth failed, Claude structured output stability could not be validated in this environment.
- Claude session id should be captured from `init.session_id` or `result.session_id`, not from hook lifecycle events. In the resume test, hook events used a transient hook session id while `init.session_id` and `result.session_id` used the requested resumed session.

Observed Claude auth-failed session:

```json
{
  "role_sessions": {
    "architect": {
      "role_id": "architect",
      "adapter_id": "claude-code",
      "external_session_id": "93587eb0-18cf-4a08-8fae-6876bc7e0c14",
      "resume_strategy": "claude_resume",
      "status": "auth_failed"
    }
  }
}
```

### Sandbox and runtime notes

- Codex failed inside the restricted sandbox with a read-only filesystem error while initializing its local runtime. Real Codex adapter runs will need the normal CLI runtime environment.
- Claude also needs access to its normal local auth/runtime state.
- For MVP-0, ForgeKit should continue to pass no-write intent through prompt and adapter args where available, but it cannot assume the external CLI can run fully inside ForgeKit's current process sandbox.

## Decision

MVP-0 can proceed with Codex as the primary verified real backend in this environment.

Claude Code adapter type and configuration should remain in the spec and generated config, but this machine cannot complete a real Claude handoff until Claude is logged in or an accepted auth mode is configured.

Adapter implementation requirements from this gate:

- Support adapter `command` as either a command name or absolute path.
- For Codex, capture `external_session_id` from `thread.started.thread_id`.
- For Claude, capture `external_session_id` from `init.session_id` or `result.session_id`.
- Store captured ids in `run.json.role_sessions`.
- Keep structured output correction logic; schema compatibility and model output can fail even when the CLI invocation succeeds.
- Treat usage/cost as opportunistic soft-budget telemetry, not a hard MVP-0 contract.
