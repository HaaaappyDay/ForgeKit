import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { initProject } from "../src/core-init.js";
import {
  initialWizardState,
  reduceWizardKey,
  type WizardState,
  type WizardWorkflowOption
} from "../src/tui/wizard-state.js";
import { buildAgenticMonitorViewModel } from "../src/tui/view-model-agentic.js";
import {
  renderAgenticMonitor,
  renderForm,
  renderList,
  renderMenu,
  renderProbeResult,
  renderRunPlan,
  renderConfigDetail
} from "../src/tui/render.js";
import { initialUiState } from "../src/tui/input.js";
import { FileMonitorFeed, LiveMonitorFeed, type MonitorFeed } from "../src/tui/monitor-feed.js";
import { ConfigScreen } from "../src/tui/screens/config.js";
import { HomeScreen } from "../src/tui/screens/home.js";
import { HistoryScreen } from "../src/tui/screens/history.js";
import { InitScreen } from "../src/tui/screens/init.js";
import { MonitorScreen } from "../src/tui/screens/monitor.js";
import { TuiShell, withTransientError } from "../src/tui/shell.js";
import type { KeyInput, Screen, ScreenContext } from "../src/tui/screen.js";
import type {
  AdapterProbeResult,
  AgenticRun,
  AgenticRunPlan,
  ConfigDetail,
  RunEvent,
  RunPlan
} from "../src/types.js";

const DIMS = { rows: 24, cols: 100 };

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-tui2-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// initProject
// ---------------------------------------------------------------------------

test("initProject creates the expected .forgekit tree", async () => {
  await withTempProject(async (dir) => {
    const result = await initProject({
      templateId: "feature-planning",
      projectName: "demo",
      force: false,
      projectRoot: dir
    });
    assert.equal(result.templateId, "feature-planning");
    const entries = (await readdir(join(dir, ".forgekit"))).sort();
    assert.ok(entries.includes("config.json"));
    assert.ok(entries.includes("roles"));
    assert.ok(entries.includes("workflows"));
    assert.ok(entries.includes("adapters"));
    assert.ok(entries.includes("runs"));
  });
});

test("initProject rejects a populated .forgekit without force, and is idempotent with force", async () => {
  await withTempProject(async (dir) => {
    await initProject({ templateId: "blank", projectName: "demo", force: false, projectRoot: dir });
    await assert.rejects(
      () => initProject({ templateId: "feature-planning", projectName: "demo", force: false, projectRoot: dir }),
      /\.forgekit already exists/
    );
    await initProject({ templateId: "feature-planning", projectName: "demo", force: true, projectRoot: dir });
    const config = JSON.parse(
      await readFile(join(dir, ".forgekit/config.json"), "utf8")
    ) as { defaults: { workflow: string } };
    assert.equal(config.defaults.workflow, "feature-planning");
  });
});

test("InitScreen explains Force scope and requires a second Enter before writing", async () => {
  await withTempProject(async (dir) => {
    const configPath = join(dir, ".forgekit/config.json");
    const { ctx } = testScreenContext(dir);
    const screen = new InitScreen(ctx);

    await screen.handleKey(key("down"));
    await screen.handleKey(key("down"));
    await screen.handleKey(key("char", " "));

    let text = screen.render(DIMS).join("\n");
    assert.match(text, /Force overwrites generated \.forgekit files/);
    await screen.handleKey(key("enter"));
    await assert.rejects(() => readFile(configPath, "utf8"), /ENOENT/);

    text = screen.render(DIMS).join("\n");
    assert.match(text, /Press Enter again/);
    await screen.handleKey(key("enter"));

    const config = JSON.parse(await readFile(configPath, "utf8")) as { schema_version: string };
    assert.equal(config.schema_version, "forgekit.config.v1");
  });
});

test("InitScreen success returns home by default and uses n for new run", async () => {
  await withTempProject(async (dir) => {
    const { ctx, shellState } = testScreenContext(dir);
    const screen = new InitScreen(ctx);
    await screen.handleKey(key("enter"));

    let text = screen.render(DIMS).join("\n");
    assert.match(text, /Press Enter to return home/);
    assert.match(text, /n to start a new run/);

    await screen.handleKey(key("enter"));
    assert.equal(shellState.popCount, 1);
    assert.deepEqual(shellState.replacedTitles, []);
  });

  await withTempProject(async (dir) => {
    const { ctx, shellState } = testScreenContext(dir);
    const screen = new InitScreen(ctx);
    await screen.handleKey(key("enter"));
    await screen.handleKey(key("char", "n"));
    assert.deepEqual(shellState.replacedTitles, ["New run"]);
  });
});

test("HomeScreen lets users select and open recent runs", async () => {
  await withTempProject(async (dir) => {
    const run = makeAgenticRun({ run_id: "20260623T000000Z-home-recent" });
    const runDir = join(dir, ".forgekit/runs", run.run_id);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");

    const { ctx, shellState } = testScreenContext(dir);
    const screen = new HomeScreen(ctx);
    await screen.onEnter?.();
    for (let i = 0; i < 6; i += 1) {
      screen.handleKey(key("down"));
    }

    const text = screen.render(DIMS).join("\n");
    assert.match(text, /> 20260623T000000Z-home-recent/);
    screen.handleKey(key("enter"));
    assert.deepEqual(shellState.pushedTitles, ["Monitor"]);
  });
});

test("HomeScreen Esc and q request a guarded quit", async () => {
  const { ctx, shellState } = testScreenContext();
  const screen = new HomeScreen(ctx);

  screen.handleKey(key("escape"));
  assert.equal(shellState.requestQuitCount, 1);

  screen.handleKey(key("char", "q"));
  assert.equal(shellState.requestQuitCount, 2);
  assert.equal(shellState.quitCount, 0);
});

test("HistoryScreen previews selected run task, issue, and summary path", async () => {
  await withTempProject(async (dir) => {
    const run = makeAgenticRun({
      run_id: "20260623T000000Z-history-preview",
      status: "escalated",
      escalation: { reason: "max_steps", at_node_id: "node-02", latest_artifacts: [] }
    });
    const runDir = join(dir, ".forgekit/runs", run.run_id);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");

    const { ctx } = testScreenContext(dir);
    const screen = new HistoryScreen(ctx);
    await screen.onEnter?.();

    const text = screen.render(DIMS).join("\n");
    assert.match(text, /Selected run:/);
    assert.match(text, /task: demo/);
    assert.match(text, /escalation: max_steps at node-02/);
    assert.match(text, /\.forgekit\/runs\/20260623T000000Z-history-preview\/summary\.md/);
  });
});

test("ConfigScreen treats agentic workflows as valid v2 workflows", async () => {
  await withTempProject(async (dir) => {
    await initProject({
      templateId: "feature-planning-agentic",
      projectName: "demo",
      force: false,
      projectRoot: dir
    });

    const { ctx } = testScreenContext(dir);
    const screen = new ConfigScreen(ctx);
    await screen.onEnter?.();

    let text = screen.render(DIMS).join("\n");
    assert.match(text, /feature-planning-agentic/);
    assert.match(text, /agentic roles:/);
    assert.match(text, /\[valid\]/);
    assert.doesNotMatch(text, /\[invalid\]/);

    screen.handleKey(key("enter"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    text = screen.render(DIMS).join("\n");
    assert.match(text, /"schema_version": "forgekit\.workflow\.v2"/);
    assert.match(text, /valid: yes/);
  });
});

test("ConfigScreen detail rerenders from raw detail when terminal width changes", async () => {
  await withTempProject(async (dir) => {
    const workflowDir = join(dir, ".forgekit/workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "long.json"),
      `${JSON.stringify({
        schema_version: "forgekit.workflow.v2",
        id: "long",
        name: "A long workflow name that should reappear after resize",
        version: "1.0.0",
        mode: "agentic_run",
        entrypoint: "pm",
        repo_context: "summary",
        roles: { pm: { objective: "plan" } },
        terminal_roles: ["pm"]
      }, null, 2)}\n`,
      "utf8"
    );

    const dims = { rows: 24, cols: 32 };
    const { ctx } = testScreenContext(dir, dims);
    const screen = new ConfigScreen(ctx);
    await screen.onEnter?.();
    screen.handleKey(key("enter"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    let text = screen.render(dims).join("\n");
    assert.match(text, /"name": "A long workflow name…/);

    dims.cols = 100;
    text = screen.render(dims).join("\n");
    assert.match(text, /A long workflow name that should reappear after resize/);
  });
});

// ---------------------------------------------------------------------------
// Wizard state machine
// ---------------------------------------------------------------------------

function wizardWithWorkflows(overrides: Partial<WizardState> = {}): WizardState {
  const workflows: WizardWorkflowOption[] = [
    { id: "feature-planning", name: "Feature Planning", kind: "linear", stepCount: 4, selectable: true },
    { id: "broken", name: "Broken", kind: "linear", stepCount: 0, selectable: false }
  ];
  return { ...initialWizardState(), workflows, ...overrides };
}

function key(name: KeyInput["name"], char?: string): KeyInput {
  return char === undefined ? { name } : { name, char };
}

class StaticMonitorFeed implements MonitorFeed {
  private run: AgenticRun;

  constructor(run: AgenticRun) {
    this.run = run;
  }

  async load(): Promise<AgenticRun> {
    return this.run;
  }

  async poll(): Promise<{ run: AgenticRun; newEvents: RunEvent[] }> {
    return { run: this.run, newEvents: [] };
  }

  start(): void {}

  stop(): void {}
}

function testScreenContext(projectRoot = "/tmp/forgekit-test", dims = DIMS): {
  ctx: ScreenContext;
  shellState: {
    quitCount: number;
    requestQuitCount: number;
    liveRunCount: number;
    popCount: number;
    repaintCount: number;
    pushedTitles: string[];
    replacedTitles: string[];
  };
} {
  const shellState: {
    quitCount: number;
    requestQuitCount: number;
    liveRunCount: number;
    popCount: number;
    repaintCount: number;
    pushedTitles: string[];
    replacedTitles: string[];
  } = {
    quitCount: 0,
    requestQuitCount: 0,
    liveRunCount: 0,
    popCount: 0,
    repaintCount: 0,
    pushedTitles: [],
    replacedTitles: []
  };
  const ctx: ScreenContext = {
    projectRoot,
    dims: () => dims,
    shell: {
      push(screen: Screen): void {
        shellState.pushedTitles.push(screen.title);
      },
      pop(): void {
        shellState.popCount += 1;
      },
      replace(screen: Screen): void {
        shellState.replacedTitles.push(screen.title);
      },
      quit(): void {
        shellState.quitCount += 1;
      },
      requestQuit(): void {
        shellState.requestQuitCount += 1;
      },
      requestRepaint(): void {
        shellState.repaintCount += 1;
      },
      beginLiveRun(): () => void {
        shellState.liveRunCount += 1;
        let finished = false;
        return () => {
          if (finished) return;
          finished = true;
          shellState.liveRunCount -= 1;
        };
      }
    }
  };
  return { ctx, shellState };
}

test("wizard step 1 blocks invalid workflows and advances on a valid one", () => {
  let state = wizardWithWorkflows();
  state = reduceWizardKey(state, key("down")).state; // select 'broken'
  const blocked = reduceWizardKey(state, key("enter"));
  assert.equal(blocked.state.step, 1);
  assert.match(blocked.state.message, /invalid/);

  state = reduceWizardKey(blocked.state, key("up")).state; // back to valid
  const advanced = reduceWizardKey(state, key("enter"));
  assert.equal(advanced.state.step, 2);
});

test("wizard step 2 toggles fields, edits text, and guards empty task", () => {
  let state = wizardWithWorkflows({ step: 2 });
  state = reduceWizardKey(state, key("char", "h")).state;
  state = reduceWizardKey(state, key("char", "i")).state;
  assert.equal(state.taskInput, "hi");
  state = reduceWizardKey(state, key("backspace")).state;
  assert.equal(state.taskInput, "h");
  state = reduceWizardKey(state, key("char", "g")).state;
  assert.equal(state.taskInput, "hg", "g is a normal printable character in text fields");

  state = reduceWizardKey(state, key("tab")).state;
  assert.equal(state.activeField, "file");
  state = reduceWizardKey(state, key("char", "f")).state;
  assert.equal(state.filePath, "f");

  // Clear both -> empty guard blocks advancing.
  const cleared = wizardWithWorkflows({ step: 2 });
  const guarded = reduceWizardKey(cleared, key("enter"));
  assert.equal(guarded.state.step, 2);
  assert.match(guarded.state.message, /Enter a task/);
});

test("wizard step 2 emits build-plan on enter with a non-empty task", () => {
  const state = wizardWithWorkflows({ step: 2, taskInput: "do it" });
  const result = reduceWizardKey(state, key("enter"));
  assert.equal(result.state.step, 3);
  assert.deepEqual(result.effect, { kind: "build-plan", workflowId: "feature-planning" });
});

test("wizard step 2 rejects simultaneous task text and task file input", () => {
  const state = wizardWithWorkflows({ step: 2, taskInput: "do it", filePath: "task.md" });
  const result = reduceWizardKey(state, key("enter"));
  assert.equal(result.state.step, 2);
  assert.equal(result.effect.kind, "none");
  assert.match(result.state.message, /either Task or Task file/);
});

test("wizard step 3 starts on enter only after a run plan is ready", () => {
  const blocked = reduceWizardKey(wizardWithWorkflows({ step: 3, taskInput: "do it" }), key("enter"));
  assert.equal(blocked.effect.kind, "none");
  assert.match(blocked.state.message, /Run plan is not ready/);

  const state = wizardWithWorkflows({ step: 3, taskInput: "do it", canStartRun: true });
  assert.deepEqual(reduceWizardKey(state, key("enter")).effect, { kind: "start" });
  assert.equal(reduceWizardKey(state, key("escape")).state.step, 2);
});

// ---------------------------------------------------------------------------
// Agentic view-model
// ---------------------------------------------------------------------------

function makeAgenticRun(overrides: Partial<AgenticRun> = {}): AgenticRun {
  return {
    schema_version: "forgekit.run.v2",
    run_id: "20260623T000000Z-agentic",
    workflow_id: "feature-planning-agentic",
    run_mode: "agentic",
    status: "running",
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:01:00.000Z",
    started_at: "2026-06-23T00:00:00.000Z",
    completed_at: "",
    duration_ms: 4200,
    task: { input: "demo" },
    active_cursor: { role_id: "architect", node_id: "node-02", phase: "work" },
    nodes: [
      {
        node_seq: 1,
        node_id: "node-01",
        role_id: "pm",
        adapter_id: "codex",
        entry_reason: "entrypoint",
        entered_from: null,
        objective: "scope",
        status: "completed",
        acceptance: { incoming_handoff_ref: "h0", verdict: "accept", verdict_ref: "v0", unmet: [] },
        attempts: [],
        handoff_ref: "h1",
        chosen_next_role: "architect"
      },
      {
        node_seq: 2,
        node_id: "node-02",
        role_id: "architect",
        adapter_id: "codex",
        entry_reason: "handoff",
        entered_from: "node-01",
        objective: "design",
        status: "running",
        acceptance: { incoming_handoff_ref: "h1", verdict: "reject", verdict_ref: "v1", unmet: ["tests"] },
        attempts: [],
        handoff_ref: "",
        chosen_next_role: null
      }
    ],
    edges: [{ from: "node-01", to: "node-02", type: "handoff" }],
    role_sessions: {},
    budget: {
      max_invocations: 20,
      max_retries_per_step: 1,
      max_duration_minutes: 60,
      max_output_bytes: 100000,
      max_steps: 30,
      max_role_visits: 5,
      invocations: 3,
      retries: 0,
      steps: 2,
      role_visits: { pm: 1, architect: 1 },
      input_chars: 10,
      output_bytes: 500,
      exceeded: []
    },
    escalation: null,
    ...overrides
  };
}

test("buildAgenticMonitorViewModel projects nodes, acceptance, budget, and active node", () => {
  const model = buildAgenticMonitorViewModel(makeAgenticRun(), []);
  assert.equal(model.nodes.length, 2);
  assert.equal(model.activeNodeId, "node-02");
  assert.equal(model.nodes[0].verdict, "accept");
  assert.equal(model.nodes[0].chosenNextRole, "architect");
  assert.deepEqual(model.nodes[1].unmet, ["tests"]);
  assert.deepEqual(model.edges, [{ from: "node-01", to: "node-02", type: "handoff" }]);
  assert.equal(model.budget.steps, 2);
  assert.deepEqual(
    model.budget.roleVisits.map((v) => `${v.roleId}:${v.count}`),
    ["pm:1", "architect:1"]
  );
});

test("buildAgenticMonitorViewModel surfaces escalation when present", () => {
  const run = makeAgenticRun({
    status: "escalated",
    escalation: { reason: "max_steps", at_node_id: "node-02", latest_artifacts: ["a"] }
  });
  const model = buildAgenticMonitorViewModel(run, []);
  assert.equal(model.escalation?.reason, "max_steps");
  assert.equal(model.escalation?.atNodeId, "node-02");
});

test("live running monitor labels in-process mode and requires quit confirmation", async () => {
  const { ctx, shellState } = testScreenContext();
  const screen = new MonitorScreen(ctx, new StaticMonitorFeed(makeAgenticRun()), { source: "live" });
  await screen.onEnter?.();

  let text = screen.render(DIMS).join("\n");
  assert.match(text, /mode: live in-process; quitting TUI stops this run/);
  assert.match(text, /Esc home/);

  await screen.handleKey(key("char", "q"));
  assert.equal(shellState.requestQuitCount, 1);
  assert.equal(shellState.quitCount, 0);
});

test("TuiShell protects active live runs outside the monitor", async () => {
  let exitCount = 0;
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  input.isTTY = false;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  output.rows = DIMS.rows;
  output.columns = DIMS.cols;

  const shell = new TuiShell({ projectRoot: "/tmp/forgekit-test", input, output });
  const finishLiveRun = shell.beginLiveRun();
  shell.push({
    title: "Passive",
    render: () => ["Passive"],
    handleKey: () => {},
    onExit: () => {
      exitCount += 1;
    }
  });

  await shell.requestQuit();
  assert.equal(exitCount, 0);

  await shell.requestQuit();
  assert.equal(exitCount, 1);
  finishLiveRun();
});

test("live monitor Esc returns home when no quit confirmation is pending", async () => {
  const { ctx, shellState } = testScreenContext();
  const screen = new MonitorScreen(ctx, new StaticMonitorFeed(makeAgenticRun()), { source: "live" });
  await screen.onEnter?.();

  await screen.handleKey(key("escape"));

  assert.equal(shellState.quitCount, 0);
  assert.equal(shellState.popCount, 1);
});

test("attached monitor labels read-only mode and quits without confirmation", async () => {
  const { ctx, shellState } = testScreenContext();
  const screen = new MonitorScreen(ctx, new StaticMonitorFeed(makeAgenticRun()), { source: "attached" });
  await screen.onEnter?.();

  const text = screen.render(DIMS).join("\n");
  assert.match(text, /mode: attached read-only; quitting closes viewer only/);

  await screen.handleKey(key("char", "q"));
  assert.equal(shellState.requestQuitCount, 1);
  assert.equal(shellState.quitCount, 0);
});

test("monitor shows feedback when the selected node has no artifacts", async () => {
  await withTempProject(async (dir) => {
    const run = makeAgenticRun({ run_id: "20260623T000000Z-agentic-no-artifacts" });
    const runDir = join(dir, ".forgekit/runs", run.run_id);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");

    const { ctx } = testScreenContext(dir);
    const screen = new MonitorScreen(ctx, new StaticMonitorFeed(run), { source: "attached" });
    await screen.onEnter?.();
    await screen.handleKey(key("enter"));

    const text = screen.render(DIMS).join("\n");
    assert.match(text, /No artifacts for node node-01 yet/);
  });
});

test("live monitor does not require quit confirmation after the run ends", async () => {
  const { ctx, shellState } = testScreenContext();
  const screen = new MonitorScreen(
    ctx,
    new StaticMonitorFeed(makeAgenticRun({ status: "completed", active_cursor: null, completed_at: "2026-06-23T00:02:00.000Z" })),
    { source: "live" }
  );
  await screen.onEnter?.();

  const text = screen.render(DIMS).join("\n");
  assert.match(text, /mode: live in-process; run has ended/);

  await screen.handleKey(key("char", "q"));
  assert.equal(shellState.requestQuitCount, 1);
});

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

test("renderMenu marks the selected item", () => {
  const lines = renderMenu("Title", ["A", "B", "C"], 1, DIMS);
  const text = lines.join("\n");
  assert.match(text, /Title/);
  assert.match(text, /> B/);
  assert.ok(!text.includes("> A"));
});

test("renderList shows a position indicator when scrolling", () => {
  const rows = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`);
  const lines = renderList("List", rows, 40, { rows: 10, cols: 60 });
  const text = lines.join("\n");
  assert.match(text, /row 41/);
  assert.match(text, /\[41\/50\]/);
});

test("renderForm shows a caret on the active text field", () => {
  const lines = renderForm(
    [
      { label: "Task", value: "hello", isText: true },
      { label: "File", value: "", isText: false }
    ],
    0,
    DIMS
  );
  assert.match(lines.join("\n"), /> Task: hello\u2588/);
});

test("renderRunPlan renders linear and agentic plans", () => {
  const linear: RunPlan = {
    workflow_id: "wf",
    workflow_name: "WF",
    task_input: "t",
    steps: [
      {
        index: 1,
        step_id: "plan",
        objective: "obj",
        role_id: "pm",
        role_name: "PM",
        adapter_id: "codex",
        adapter_type: "codex",
        role_write_policy: "no_write_intent",
        output_schema: "handoff.v1"
      }
    ],
    adapters: [
      {
        adapter_id: "codex",
        type: "codex",
        command: "codex",
        auth_mode: "external_cli_auth",
        billing_mode: "user_subscription",
        cost_tracking: "unavailable",
        budget_policy: "soft",
        write_policy_default: "no_write_intent",
        write_policy_enforcement: "best_effort"
      }
    ],
    context: { repo: "r", sharing: "s", mode: "m" },
    budgets: {
      max_invocations: 10,
      max_retries_per_step: 1,
      max_duration_minutes: 30,
      max_output_bytes: 1000,
      token_budget: "soft"
    },
    warnings: ["heads up"]
  };
  const linearText = renderRunPlan(linear, DIMS).join("\n");
  assert.match(linearText, /Steps:/);
  assert.match(linearText, /1\. plan \(pm\)/);
  assert.match(linearText, /! heads up/);

  const narrowLinearText = renderRunPlan(
    {
      ...linear,
      task_input: "alpha beta gamma delta task-tail",
      steps: [{ ...linear.steps[0], objective: "objective alpha beta gamma objective-tail" }]
    },
    { rows: 24, cols: 24 }
  ).join("\n");
  assert.match(narrowLinearText, /task-tail/);
  assert.match(narrowLinearText, /objective-tail/);

  const agentic: AgenticRunPlan = {
    workflow_id: "wf2",
    workflow_name: "WF2",
    run_mode: "agentic",
    task_input: "t",
    entrypoint: "pm",
    terminal_roles: ["qa"],
    roles: [
      {
        role_id: "pm",
        role_name: "PM",
        adapter_id: "codex",
        adapter_type: "codex",
        role_write_policy: "no_write_intent",
        objective: "scope",
        is_entrypoint: true,
        is_terminal: false,
        candidates: ["architect"],
        candidate_source: "workflow"
      }
    ],
    adapters: [],
    context: { repo: "r", sharing: "s", mode: "m" },
    budgets: {
      max_invocations: 20,
      max_retries_per_step: 1,
      max_duration_minutes: 60,
      max_output_bytes: 1000,
      max_steps: 30,
      max_role_visits: 5,
      token_budget: "soft"
    },
    warnings: []
  };
  const agenticText = renderRunPlan(agentic, DIMS).join("\n");
  assert.match(agenticText, /mode agentic/);
  assert.match(agenticText, /candidates: architect/);
});

test("renderAgenticMonitor lists nodes and marks selection and active node", () => {
  const model = buildAgenticMonitorViewModel(makeAgenticRun(), []);
  const ui = { ...initialUiState(), selectedStep: 0 };
  const text = renderAgenticMonitor(model, ui, DIMS).join("\n");
  assert.match(text, /> 1\. node-01 \(pm\)/);
  assert.match(text, /\* 2\. node-02 \(architect\)/);
  assert.match(text, /legend: > selected  \* active/);
  assert.match(text, /Selected node:/);
  assert.match(text, /Route:/);
  assert.match(text, /node-01 -handoff-> node-02/);
  assert.match(text, /unmet: tests/);
});

test("renderProbeResult shows overall status and per-check glyphs", () => {
  const result: AdapterProbeResult = {
    adapter_id: "codex",
    adapter_type: "codex",
    ok: false,
    command: "codex",
    resolved_command: null,
    checks: [
      { name: "command_resolves", status: "failed", message: "not found" },
      { name: "version", status: "passed" }
    ]
  };
  const text = renderProbeResult(result, DIMS).join("\n");
  assert.match(text, /Runtime adapter probe/);
  assert.match(text, /overall: FAILED/);
  assert.match(text, /\[x\] command_resolves - not found/);
  assert.match(text, /\[\+\] version/);
  assert.match(text, /forge adapter set-command codex <command-or-path>/);
});

test("renderConfigDetail shows validation errors and pretty config", () => {
  const detail: ConfigDetail<{ id: string }> = {
    id: "pm",
    path: "/x/pm.json",
    config: { id: "pm" },
    validation: { valid: false, errors: ["missing name"] }
  };
  const text = renderConfigDetail(detail, DIMS).join("\n");
  assert.match(text, /valid: no/);
  assert.match(text, /! missing name/);
  assert.match(text, /"id": "pm"/);
});

test("withTransientError inserts screen handler errors above a pinned footer", () => {
  const lines = ["body", "", "", "footer"];
  const withError = withTransientError(lines, "handler failed with a long message", { rows: 4, cols: 32 });
  assert.equal(withError[0], "body");
  assert.match(withError[2], /^error: handler failed/);
  assert.equal(withError[3], "footer");
});

// ---------------------------------------------------------------------------
// Monitor feeds
// ---------------------------------------------------------------------------

function makeEvent(seq: number, runId: string): RunEvent {
  return {
    schema_version: "forgekit.run-event.v1",
    event_id: String(seq).padStart(6, "0"),
    run_id: runId,
    timestamp: "2026-06-23T00:00:00.000Z",
    type: "step_started",
    message: `event ${seq}`,
    data: {}
  };
}

test("LiveMonitorFeed buffers observer events and learns the run id", async () => {
  await withTempProject(async (dir) => {
    const feed = new LiveMonitorFeed({ projectRoot: dir });
    feed.observer(makeEvent(1, "run-xyz"));
    feed.observer(makeEvent(2, "run-xyz"));
    const run = makeAgenticRun({ run_id: "run-xyz" });
    feed.setRun(run);
    const { run: polled, newEvents } = await feed.poll();
    assert.equal(polled.run_id, "run-xyz");
    assert.deepEqual(newEvents.map((e) => e.event_id), ["000001", "000002"]);
    // Drained on the next poll.
    const second = await feed.poll();
    assert.deepEqual(second.newEvents, []);
  });
});

test("FileMonitorFeed loads an agentic run and tails appended events", async () => {
  await withTempProject(async (dir) => {
    const runId = "20260623T000000Z-agentic";
    const runDir = join(dir, ".forgekit/runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(makeAgenticRun({ run_id: runId }))}\n`, "utf8");

    const feed = new FileMonitorFeed({ runId, projectRoot: dir });
    const loaded = await feed.load();
    assert.equal(loaded.run_id, runId);
    assert.equal((loaded as AgenticRun).run_mode, "agentic");

    const eventsPath = join(runDir, "events.jsonl");
    await writeFile(eventsPath, `${JSON.stringify(makeEvent(1, runId))}\n`, "utf8");
    let poll = await feed.poll();
    assert.equal(poll.newEvents.length, 1);
    await appendFile(eventsPath, `${JSON.stringify(makeEvent(2, runId))}\n`, "utf8");
    poll = await feed.poll();
    assert.deepEqual(poll.newEvents.map((e) => e.event_id), ["000002"]);
  });
});
