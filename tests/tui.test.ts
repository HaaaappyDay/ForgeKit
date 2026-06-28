import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildMonitorViewModel } from "../src/tui/view-model.js";
import { renderMonitor, renderReader, composeFrame, renderFrame } from "../src/tui/render.js";
import { initialUiState, reduceKey, maxScrollTop, type ReaderState, type UiState } from "../src/tui/input.js";
import { RunMonitorSource } from "../src/tui/run-source.js";
import type { Run, RunEvent } from "../src/types.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    schema_version: "forgekit.run.v1",
    run_id: "20260621T000000Z-demo",
    workflow_id: "feature-planning",
    status: "running",
    created_at: "2026-06-21T00:00:00.000Z",
    updated_at: "2026-06-21T00:01:00.000Z",
    started_at: "2026-06-21T00:00:00.000Z",
    completed_at: "",
    duration_ms: 1234,
    task: { input: "demo task" },
    role_sessions: {},
    budget: {
      max_invocations: 10,
      max_retries_per_step: 1,
      max_duration_minutes: 30,
      max_output_bytes: 1000,
      invocations: 2,
      retries: 0,
      input_chars: 50,
      output_bytes: 300,
      exceeded: []
    },
    steps: [
      {
        index: 1,
        step_id: "discovery",
        role_id: "pm",
        adapter_id: "codex-local",
        status: "completed",
        active_attempt: "attempt-01",
        attempts: [
          {
            attempt_id: "attempt-01",
            status: "completed",
            started_at: "",
            completed_at: "",
            duration_ms: 100,
            prompt_ref: "steps/01-discovery/attempt-01/prompt.md",
            stdout_ref: "steps/01-discovery/attempt-01/raw.log",
            stderr_ref: "steps/01-discovery/attempt-01/error.log",
            handoff_ref: "steps/01-discovery/attempt-01/handoff.json",
            markdown_ref: "steps/01-discovery/attempt-01/output.md",
            validation_ref: "steps/01-discovery/attempt-01/validation.json",
            exit_code: 0,
            external_session_id: "s1",
            correction_count: 0,
            error: ""
          }
        ]
      },
      {
        index: 2,
        step_id: "design",
        role_id: "architect",
        adapter_id: "codex-local",
        status: "running",
        active_attempt: "attempt-01",
        attempts: []
      }
    ],
    ...overrides
  };
}

function makeEvent(seq: number, type: RunEvent["type"], message: string, stepId?: string): RunEvent {
  return {
    schema_version: "forgekit.run-event.v1",
    event_id: String(seq).padStart(6, "0"),
    run_id: "20260621T000000Z-demo",
    timestamp: "2026-06-21T00:00:00.000Z",
    type,
    message,
    data: {},
    ...(stepId ? { step_id: stepId } : {})
  };
}

test("buildMonitorViewModel projects steps, budget, and a bounded event window", () => {
  const run = makeRun();
  const events: RunEvent[] = Array.from({ length: 12 }, (_, i) =>
    makeEvent(i + 1, "step_started", `event ${i + 1}`)
  );
  const model = buildMonitorViewModel(run, events, { maxEvents: 5 });

  assert.equal(model.runId, run.run_id);
  assert.equal(model.status, "running");
  assert.equal(model.steps.length, 2);
  assert.equal(model.steps[0].status, "completed");
  assert.equal(model.steps[0].exitCode, 0);
  assert.equal(model.steps[1].exitCode, null);
  assert.equal(model.budget.invocations, 2);
  assert.equal(model.recentEvents.length, 5);
  assert.equal(model.recentEvents[0].message, "event 8");
  assert.equal(model.recentEvents.at(-1)?.message, "event 12");
});

test("renderMonitor marks the selected step and shows budget and events", () => {
  const model = buildMonitorViewModel(makeRun(), [makeEvent(1, "run_started", "started")]);
  const ui = { ...initialUiState(), selectedStep: 1 };
  const lines = renderMonitor(model, ui, { rows: 24, cols: 100 });
  const text = lines.join("\n");

  assert.match(text, /run 20260621T000000Z-demo/);
  assert.match(text, /Steps:/);
  assert.match(text, /progress/);
  assert.match(text, /> 2\. design \(architect\)/);
  assert.ok(!lines.some((l) => l.startsWith("> 1.")), "step 1 should not be selected");
  assert.match(text, /Budget:/);
  assert.match(text, /invocations 2\/10/);
  assert.match(text, /\[000001\] run_started - started/);
});

test("renderReader shows the active artifact tab and a scrolled viewport", () => {
  const reader: ReaderState = {
    stepIndex: 0,
    artifacts: [
      { ref: "a/output.md", type: "markdown" },
      { ref: "a/handoff.json", type: "handoff" }
    ],
    activeArtifact: 1,
    lines: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`),
    scrollTop: 10
  };
  const lines = renderReader(reader, { rows: 12, cols: 80 });
  const text = lines.join("\n");

  assert.match(text, /Artifact a\/handoff\.json/);
  assert.match(text, /\[2\/2\]/);
  assert.match(text, /\*handoff\*/);
  assert.match(text, /line 11/);
  assert.ok(!text.includes("line 1\n") || text.includes("line 11"), "viewport starts at scrollTop");
});

test("renderFrame pins the footer to the last row and fits the height", () => {
  const model = buildMonitorViewModel(makeRun(), []);
  const frame = renderFrame(model, initialUiState(), { rows: 20, cols: 80 });
  assert.match(frame, /Enter artifacts/);
  assert.ok(frame.startsWith("\u001b[H"), "frame starts at cursor home");
});

test("composeFrame truncates content to the terminal height", () => {
  const content = Array.from({ length: 40 }, (_, i) => `row ${i + 1}`);
  const frame = composeFrame(content, { rows: 5, cols: 80 });
  assert.ok(frame.includes("row 1"));
  assert.ok(frame.includes("row 5"));
  assert.ok(!frame.includes("row 6"));
});

test("reduceKey navigates the step list and clamps at the ends", () => {
  const ctx = { stepCount: 2, viewportRows: 10 };
  let ui = initialUiState();
  ui = reduceKey(ui, "down", ctx).ui;
  assert.equal(ui.selectedStep, 1);
  ui = reduceKey(ui, "down", ctx).ui;
  assert.equal(ui.selectedStep, 1, "clamped at last step");
  ui = reduceKey(ui, "up", ctx).ui;
  assert.equal(ui.selectedStep, 0);
  ui = reduceKey(ui, "up", ctx).ui;
  assert.equal(ui.selectedStep, 0, "clamped at first step");
});

test("reduceKey emits open-artifacts on Enter and quit on q", () => {
  const ctx = { stepCount: 2, viewportRows: 10 };
  const ui: UiState = { ...initialUiState(), selectedStep: 1 };
  const open = reduceKey(ui, "enter", ctx);
  assert.deepEqual(open.effect, { kind: "open-artifacts", stepIndex: 1 });
  const quit = reduceKey(ui, "quit", ctx);
  assert.equal(quit.effect.kind, "quit");
});

test("reduceKey scrolls and switches artifacts in reader view", () => {
  const ctx = { stepCount: 2, viewportRows: 5 };
  const reader: ReaderState = {
    stepIndex: 0,
    artifacts: [
      { ref: "a", type: "markdown" },
      { ref: "b", type: "handoff" }
    ],
    activeArtifact: 0,
    lines: Array.from({ length: 20 }, (_, i) => `l${i}`),
    scrollTop: 0
  };
  let ui: UiState = { view: "reader", selectedStep: 0, reader };

  ui = reduceKey(ui, "down", ctx).ui;
  assert.equal(ui.reader?.scrollTop, 1);
  ui = reduceKey(ui, "bottom", ctx).ui;
  assert.equal(ui.reader?.scrollTop, maxScrollTop(20, 5));
  ui = reduceKey(ui, "top", ctx).ui;
  assert.equal(ui.reader?.scrollTop, 0);

  const right = reduceKey(ui, "right", ctx);
  assert.deepEqual(right.effect, { kind: "switch-artifact", delta: 1 });

  const back = reduceKey(ui, "escape", ctx);
  assert.equal(back.ui.view, "monitor");
  assert.equal(back.ui.reader, null);
});

async function withRunDir(fn: (root: string, runId: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "forgekit-tui-"));
  const runId = "20260621T000000Z-demo";
  const runDir = join(root, ".forgekit/runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(makeRun(), null, 2)}\n`, "utf8");
  try {
    await fn(root, runId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("RunMonitorSource tails only newly appended event lines", async () => {
  await withRunDir(async (root, runId) => {
    const source = new RunMonitorSource({ runId, projectRoot: root });
    const eventsPath = join(root, ".forgekit/runs", runId, "events.jsonl");

    assert.equal(await source.hasEventStream(), false);
    assert.deepEqual(await source.readNewEvents(), []);

    await writeFile(eventsPath, `${JSON.stringify(makeEvent(1, "run_started", "a"))}\n`, "utf8");
    let batch = await source.readNewEvents();
    assert.equal(batch.length, 1);
    assert.equal(batch[0].event_id, "000001");

    assert.deepEqual(await source.readNewEvents(), [], "no new events without appends");

    await appendFile(eventsPath, `${JSON.stringify(makeEvent(2, "step_started", "b"))}\n`, "utf8");
    await appendFile(eventsPath, `${JSON.stringify(makeEvent(3, "step_completed", "c"))}\n`, "utf8");
    batch = await source.readNewEvents();
    assert.deepEqual(batch.map((e) => e.event_id), ["000002", "000003"]);
  });
});

test("RunMonitorSource carries a partial trailing line until it completes", async () => {
  await withRunDir(async (root, runId) => {
    const source = new RunMonitorSource({ runId, projectRoot: root });
    const eventsPath = join(root, ".forgekit/runs", runId, "events.jsonl");
    const full = JSON.stringify(makeEvent(1, "run_started", "a"));

    await writeFile(eventsPath, full.slice(0, 10), "utf8");
    assert.deepEqual(await source.readNewEvents(), [], "incomplete line is not parsed");

    await appendFile(eventsPath, `${full.slice(10)}\n`, "utf8");
    const batch = await source.readNewEvents();
    assert.equal(batch.length, 1);
    assert.equal(batch[0].event_id, "000001");
  });
});

test("RunMonitorSource readRun rejects agentic runs", async () => {
  await withRunDir(async (root, runId) => {
    const runDir = join(root, ".forgekit/runs", runId);
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ schema_version: "forgekit.run.v2", run_mode: "agentic", run_id: runId }),
      "utf8"
    );
    const source = new RunMonitorSource({ runId, projectRoot: root });
    await assert.rejects(() => source.readRun(), /agentic/);
  });
});
