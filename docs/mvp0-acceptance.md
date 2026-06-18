# MVP-0 Acceptance Report

Status: passed with Codex fallback
Date: 2026-06-18

## Scope

This acceptance pass verifies the MVP-0 goal: a ForgeKit workflow run can orchestrate role-scoped CLI agent calls, persist run trace artifacts, validate handoffs, produce `summary.md`, and support history/show/retry inspection.

## Environment

- Source checkout: `/home/lotus/projects/ForgeKit`
- Acceptance workspace: `/tmp/forgekit-mvp0-acceptance-u4CZNm`
- Template: `feature-planning`
- Real backend used for completed workflow: Codex
- Claude Code adapter type and config remained present, but role mapping was temporarily changed so every role used `codex-local`.

## Commands Verified

- `forge init --template feature-planning --project-name acceptance --yes`
- `forge adapter probe codex-local --json`
- `forge adapter probe claude-code --json`
- `forge workflow start feature-planning --input "..."`
- `forge run retry <run-id>`
- `forge history`
- `forge run show <run-id>`
- `forge role path architect`
- `forge schema validate forgekit.run.v1 <run.json>`

## Results

- Run id: `20260618T125653Z-feature-planning`
- Final status: `completed`
- Completed steps: `clarify-requirement`, `technical-design`, `implementation-plan`, `test-plan`
- Handoff validation: all completed attempts had `validation.valid = true`
- Role sessions: all four roles captured Codex `external_session_id` values in `run.json.role_sessions`
- Artifacts present for completed steps: `prompt.md`, `raw.log`, `error.log`, `handoff.json`, `output.md`, `validation.json`
- Final summary present: `.forgekit/runs/20260618T125653Z-feature-planning/summary.md`
- Retry behavior verified: the failed first step kept `attempt-01` and `attempt-02`; successful retry wrote `attempt-03` without overwriting prior artifacts.

## Notable Findings

- Codex failed inside the restricted filesystem sandbox while initializing its local runtime. Running the real retry outside the sandbox allowed the workflow to proceed.
- A non-git acceptance workspace initially failed Codex's repository check. ForgeKit now passes `--skip-git-repo-check` for Codex `exec` and `exec resume`, covered by tests.
- Claude Code basic probe passed in this environment. Full Claude structured handoff stability was not part of this acceptance pass because MVP-0 allows a single real backend fallback when one backend is unavailable or not validated.
- Soft budget observation worked. The completed run recorded invocation counts, retries, input/output sizes, and `max_retries_per_step` as a soft exceeded flag after multiple acceptance retries.

## Test Suite

`npm test` passed after the acceptance fix:

- `tests/adapter-execute.test.js`
- `tests/adapter-probe.test.js`
- `tests/handoff.test.js`
- `tests/init.test.js`
- `tests/run-commands.test.js`
- `tests/run-plan.test.js`
- `tests/schema.test.js`
- `tests/workflow-runner.test.js`

## Remaining Non-Blocking Follow-Ups

- Full Claude Code structured workflow run should be repeated once local Claude auth/runtime is confirmed.
- Workflow summary currently accumulates repeated assumptions/risks/open questions verbatim; MVP-0 accepts this, but deduplication would improve readability.
- Real backend runs should be documented as requiring normal CLI runtime access outside restrictive filesystem sandboxes.
