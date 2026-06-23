import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInitCommand } from "../src/init-command.js";
import { writeJsonFile, readJsonFile } from "../src/json-file.js";
import { getRunArtifacts, getRunSnapshot, listRuns, retryRun, startWorkflowRun } from "../src/core.js";
import type { AdapterConfig, AgenticRun, Run, RunEvent } from "../src/types.js";

const NODE_BIN_DIR = dirname(process.execPath);

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-agentic-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function patchAdapterCommand(projectRoot: string, adapterFile: string, command: string): Promise<void> {
  const path = join(projectRoot, ".forgekit/adapters", adapterFile);
  const adapter = await readJsonFile<AdapterConfig>(path);
  adapter.command = command;
  adapter.env_allowlist = [
    ...(adapter.env_allowlist ?? []),
    "FAKE_STATE",
    "FAKE_REJECT_TIMES",
    "FAKE_FAIL_WORK",
    "FAKE_BAD_ROUTE",
    "FAKE_PREMATURE_FINAL"
  ];
  await writeJsonFile(path, adapter);
}

const AGENTIC_WORKFLOW = {
  schema_version: "forgekit.workflow.v2",
  id: "agentic-demo",
  name: "Agentic Demo",
  version: "1.0.0",
  mode: "agentic_run",
  entrypoint: "pm",
  repo_context: "standard",
  roles: {
    pm: { objective: "Clarify the task and hand off a plan.", handoff_targets: ["qa"] },
    qa: { objective: "Verify the deliverable and finalize.", handoff_targets: [] }
  },
  terminal_roles: ["qa"]
};

/**
 * A deterministic fake adapter (codex shape: prompt on stdin, JSONL on stdout).
 * It recognizes the acceptance-gate prompt vs the agentic work prompt and emits the
 * matching handoff.v2 / acceptance-verdict.v1 object. FAKE_REJECT_TIMES controls how
 * many initial gate visits are rejected so we can exercise rework and escalation.
 */
function fakeAgentScript(): string {
  return `#!/usr/bin/env node
const fs = require("fs");
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}
function first(re, text) { const m = text.match(re); return m ? m[1].trim() : ""; }
(async () => {
  const prompt = await readStdin();
  const runId = first(/- run_id: (.+)/, prompt);
  if (prompt.includes("failed validation")) {
    // Self-correction round: re-emit the original (still-invalid) object verbatim so the
    // engine sees the same semantic violation again and gives up.
    for (const line of prompt.split("\\n")) {
      const t = line.trim();
      if (t.startsWith("{") && (t.includes("handoff.v2") || t.includes("acceptance-verdict.v1"))) {
        const obj = JSON.parse(t);
        console.log(JSON.stringify({ type: "thread.started", thread_id: "sess-" + obj.role_id }));
        console.log(JSON.stringify(obj));
        process.exit(0);
      }
    }
    console.error("fake-agent: correction prompt without recoverable object");
    process.exit(4);
  }
  if (prompt.includes("ForgeKit Acceptance Gate")) {
    const nodeId = first(/- node_id: (.+)/, prompt);
    const roleId = first(/receiving role:\\s*\\n- id: (.+)/, prompt);
    const ref = first(/Upstream handoff ref: (.+)/, prompt);
    const crits = [...prompt.matchAll(/^\\d+\\. (.+)$/gm)].map((m) => m[1].trim());
    const statePath = process.env.FAKE_STATE;
    let state = { gate: 0 };
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (e) {}
    state.gate = (state.gate || 0) + 1;
    fs.writeFileSync(statePath, JSON.stringify(state));
    const rejectTimes = Number(process.env.FAKE_REJECT_TIMES || "0");
    const reject = state.gate <= rejectTimes;
    const results = crits.map((c) => ({ criterion: c, met: reject ? false : true, reason: reject ? "not yet satisfied" : "looks good" }));
    const verdict = {
      schema_version: "acceptance-verdict.v1",
      run_id: runId,
      node_id: nodeId,
      role_id: roleId,
      incoming_handoff_ref: ref,
      verdict: reject ? "reject" : "accept",
      criteria_results: results,
      notes: reject ? "Please address the unmet criteria." : ""
    };
    console.log(JSON.stringify({ type: "thread.started", thread_id: "sess-" + roleId }));
    console.log(JSON.stringify(verdict));
    process.exit(0);
  }
  if (prompt.includes("ForgeKit Agentic Node")) {
    const nodeId = first(/- node_id: (.+)/, prompt);
    const roleId = first(/^- role_id: (.+)$/m, prompt);
    const mustNotFinal = prompt.includes("You MUST NOT finish here");
    const candLine = first(/EXACTLY ONE of: ([^\\n.]+)/, prompt);
    const candidates = candLine.split(",").map((s) => s.trim()).filter(Boolean);
    const failWork = Number(process.env.FAKE_FAIL_WORK || "0");
    const statePath = process.env.FAKE_STATE;
    let state = { work: 0 };
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (e) {}
    state.work = (state.work || 0) + 1;
    fs.writeFileSync(statePath, JSON.stringify(state));
    const failNow = roleId === "pm" && state.work <= failWork;
    const badRoute = process.env.FAKE_BAD_ROUTE === "1" && roleId === "pm";
    const premature = process.env.FAKE_PREMATURE_FINAL === "1" && roleId === "pm";
    let next;
    if (premature) {
      next = { kind: "final" };
    } else if (mustNotFinal) {
      next = { kind: "handoff", recommended_role: badRoute ? "ghost-role" : candidates[0], instructions: "Verify the deliverable matches the task.", acceptance_criteria: ["Deliverable addresses the task"] };
    } else {
      next = { kind: "final" };
    }
    const handoff = {
      schema_version: "handoff.v2",
      run_id: runId,
      step_id: nodeId,
      role_id: roleId,
      status: "completed",
      summary: failNow ? "" : "Work output for " + roleId,
      decisions: [],
      assumptions: [],
      risks: [],
      open_questions: [],
      out_of_scope: [],
      markdown_body: "# Output for " + roleId + "\\nDone.",
      next_handoff: next,
      artifacts: []
    };
    console.log(JSON.stringify({ type: "thread.started", thread_id: "sess-" + roleId }));
    console.log(JSON.stringify(handoff));
    process.exit(0);
  }
  console.error("fake-agent: unrecognized prompt");
  process.exit(3);
})();
`;
}

async function scaffold(
  dir: string,
  rejectTimes: number,
  failWork = 0,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<NodeJS.ProcessEnv> {
  await runInitCommand(["--template", "feature-planning", "--yes"], dir);
  await writeJsonFile(join(dir, ".forgekit/workflows/agentic-demo.json"), AGENTIC_WORKFLOW);
  const fakeAgent = join(dir, "fake-agent.cjs");
  await writeExecutable(fakeAgent, fakeAgentScript());
  await patchAdapterCommand(dir, "codex.json", fakeAgent);
  await patchAdapterCommand(dir, "claude-code.json", fakeAgent);
  return {
    PATH: `${dir}:${NODE_BIN_DIR}:/usr/bin:/bin`,
    HOME: dir,
    FAKE_STATE: join(dir, "fake-state.json"),
    FAKE_REJECT_TIMES: String(rejectTimes),
    FAKE_FAIL_WORK: String(failWork),
    ...extraEnv
  };
}

function asAgentic(run: Run | AgenticRun): AgenticRun {
  assert.equal((run as AgenticRun).run_mode, "agentic");
  return run as AgenticRun;
}

test("runAgenticWorkflow completes a two-role run through the acceptance gate", async () => {
  await withTempProject(async (dir) => {
    const env = await scaffold(dir, 0);
    const observed: RunEvent[] = [];
    const run = asAgentic(
      await startWorkflowRun({
        workflowId: "agentic-demo",
        taskInput: "Plan a passwordless login",
        projectRoot: dir,
        env,
        eventObservers: [(event) => {
          observed.push(event);
        }],
        writeEventsJsonl: true
      })
    );

    assert.equal(run.status, "completed");
    assert.equal(run.nodes.length, 2);
    assert.deepEqual(run.nodes.map((node) => node.role_id), ["pm", "qa"]);
    assert.equal(run.nodes[0].entry_reason, "entrypoint");
    assert.equal(run.nodes[0].chosen_next_role, "qa");
    assert.equal(run.nodes[1].entry_reason, "handoff");
    assert.equal(run.nodes[1].acceptance?.verdict, "accept");
    assert.equal(run.nodes[1].status, "completed");

    assert.equal(run.edges.length, 1);
    assert.deepEqual(run.edges[0], { from: run.nodes[0].node_id, to: run.nodes[1].node_id, type: "handoff" });

    assert.equal(run.role_sessions.pm.external_session_id, "sess-pm");
    assert.equal(run.role_sessions.qa.external_session_id, "sess-qa");
    assert.equal(run.budget.role_visits.pm, 1);
    assert.equal(run.budget.role_visits.qa, 1);
    assert.equal(run.budget.steps, 2);
    assert.equal(run.active_cursor, null);

    const types = observed.map((event) => event.type);
    assert.equal(types[0], "run_created");
    assert.ok(types.includes("node_entered"));
    assert.ok(types.includes("route_candidates_resolved"));
    assert.ok(types.includes("acceptance_verification_started"));
    assert.ok(types.includes("acceptance_verification_completed"));
    assert.ok(types.includes("route_selected"));
    assert.equal(observed.at(-1)?.type, "run_completed");

    const persisted = await readJsonFile<AgenticRun>(join(dir, ".forgekit/runs", run.run_id, "run.json"));
    assert.equal(persisted.status, "completed");
    await stat(join(dir, ".forgekit/runs", run.run_id, "summary.md"));
    await stat(join(dir, ".forgekit/runs", run.run_id, "nodes/02-qa/verification/attempt-01/verdict.json"));
    await stat(join(dir, ".forgekit/runs", run.run_id, "nodes/02-qa/work/attempt-01/handoff.json"));

    const summary = await readFile(join(dir, ".forgekit/runs", run.run_id, "summary.md"), "utf8");
    assert.match(summary, /Agentic Run Summary/);
    assert.match(summary, /Plan a passwordless login/);
  });
});

test("runAgenticWorkflow routes rework to the sender on rejection, then completes", async () => {
  await withTempProject(async (dir) => {
    const env = await scaffold(dir, 1);
    const run = asAgentic(
      await startWorkflowRun({
        workflowId: "agentic-demo",
        taskInput: "Plan a feature",
        projectRoot: dir,
        env
      })
    );

    assert.equal(run.status, "completed");
    // pm(1) -> qa(reject) -> pm(rework) -> qa(accept+final)
    assert.deepEqual(run.nodes.map((node) => node.role_id), ["pm", "qa", "pm", "qa"]);
    assert.equal(run.nodes[1].acceptance?.verdict, "reject");
    assert.equal(run.nodes[1].status, "rejected_upstream");
    assert.equal(run.nodes[2].entry_reason, "rework");
    assert.equal(run.nodes[3].acceptance?.verdict, "accept");
    assert.equal(run.nodes[3].status, "completed");

    const reworkEdge = run.edges.find((edge) => edge.type === "rework");
    assert.ok(reworkEdge, "expected a rework edge");
    assert.equal(reworkEdge?.from, run.nodes[1].node_id);
    assert.equal(reworkEdge?.to, run.nodes[2].node_id);
    assert.deepEqual(reworkEdge?.reason, ["Deliverable addresses the task"]);

    assert.equal(run.budget.role_visits.pm, 2);
    assert.equal(run.budget.role_visits.qa, 2);
  });
});

test("runAgenticWorkflow escalates when a role exceeds its visit budget", async () => {
  await withTempProject(async (dir) => {
    const env = await scaffold(dir, 99);
    const observed: RunEvent[] = [];
    const run = asAgentic(
      await startWorkflowRun({
        workflowId: "agentic-demo",
        taskInput: "Loop forever",
        projectRoot: dir,
        env,
        eventObservers: [(event) => {
          observed.push(event);
        }]
      })
    );

    assert.equal(run.status, "escalated");
    assert.equal(run.escalation?.reason, "max_role_visits");
    assert.ok(run.budget.exceeded.includes("max_role_visits"));
    assert.equal(run.budget.role_visits.pm, run.budget.max_role_visits);
    assert.equal(observed.at(-1)?.type, "run_escalated");

    // escalated runs are not retryable
    await assert.rejects(() => retryRun({ runId: run.run_id, projectRoot: dir, env }), /Only failed runs can be retried/);
  });
});

test("retryRun resumes a failed agentic run from the failed node, preserving prior attempts", async () => {
  await withTempProject(async (dir) => {
    const env = await scaffold(dir, 0, 1);
    const failedRun = asAgentic(
      await startWorkflowRun({ workflowId: "agentic-demo", taskInput: "Plan it", projectRoot: dir, env })
    );

    assert.equal(failedRun.status, "failed");
    assert.equal(failedRun.nodes.length, 1);
    assert.equal(failedRun.nodes[0].role_id, "pm");
    assert.equal(failedRun.nodes[0].status, "failed");
    const failedAttempts = failedRun.nodes[0].attempts.length;
    assert.ok(failedAttempts >= 1);

    const retried = asAgentic(await retryRun({ runId: failedRun.run_id, projectRoot: dir, env, writeEventsJsonl: true }));

    assert.equal(retried.status, "completed");
    assert.deepEqual(retried.nodes.map((node) => node.role_id), ["pm", "qa"]);
    assert.equal(retried.nodes[0].status, "completed");
    // the failed node kept its prior attempt(s) and gained a new successful one
    assert.equal(retried.nodes[0].attempts.length, failedAttempts + 1);
    assert.equal(retried.nodes[0].attempts.at(-1)?.status, "completed");
    assert.equal(retried.nodes[1].role_id, "qa");
    assert.equal(retried.nodes[1].acceptance?.verdict, "accept");
  });
});

test("runAgenticWorkflow fails when a role routes to a target outside its candidate set", async () => {
  await withTempProject(async (dir) => {
    const env = await scaffold(dir, 0, 0, { FAKE_BAD_ROUTE: "1" });
    const run = asAgentic(
      await startWorkflowRun({ workflowId: "agentic-demo", taskInput: "Route somewhere illegal", projectRoot: dir, env })
    );

    assert.equal(run.status, "failed");
    // The offending node is pm; it self-corrects once then fails on the illegal route.
    const pmNode = run.nodes.find((node) => node.role_id === "pm");
    assert.ok(pmNode);
    assert.equal(pmNode?.status, "failed");
    const lastAttempt = pmNode?.attempts.at(-1);
    assert.equal(lastAttempt?.correction_count, 1, "expected one in-attempt self-correction");
    assert.equal(lastAttempt?.error_code, "route_target_not_allowed");
    // qa never runs because routing never succeeded
    assert.equal(run.nodes.some((node) => node.role_id === "qa"), false);
  });
});

test("runAgenticWorkflow fails with premature_final when a non-terminal role finalizes", async () => {
  await withTempProject(async (dir) => {
    const env = await scaffold(dir, 0, 0, { FAKE_PREMATURE_FINAL: "1" });
    const run = asAgentic(
      await startWorkflowRun({ workflowId: "agentic-demo", taskInput: "Finish too early", projectRoot: dir, env })
    );

    assert.equal(run.status, "failed");
    const pmNode = run.nodes.find((node) => node.role_id === "pm");
    assert.ok(pmNode);
    assert.equal(pmNode?.status, "failed");
    const lastAttempt = pmNode?.attempts.at(-1);
    assert.equal(lastAttempt?.correction_count, 1, "expected one in-attempt self-correction");
    assert.equal(lastAttempt?.error_code, "premature_final");
    assert.equal(run.nodes.some((node) => node.role_id === "qa"), false);
  });
});

test("agentic runs are exposed through snapshot, history, and node artifacts", async () => {
  await withTempProject(async (dir) => {
    const env = await scaffold(dir, 0);
    const run = asAgentic(
      await startWorkflowRun({ workflowId: "agentic-demo", taskInput: "Expose me", projectRoot: dir, env })
    );
    assert.equal(run.status, "completed");

    const snapshot = await getRunSnapshot(run.run_id, dir);
    assert.equal((snapshot as AgenticRun).run_mode, "agentic");

    const history = await listRuns(dir);
    const entry = history.find((item) => item.run_id === run.run_id);
    assert.ok(entry);
    assert.equal((entry as AgenticRun).run_mode, "agentic");

    const artifacts = await getRunArtifacts(run.run_id, dir);
    const handoffArtifact = artifacts.find((a) => a.type === "handoff" && a.exists);
    assert.ok(handoffArtifact, "expected an existing handoff artifact");
    assert.ok(handoffArtifact?.node_id, "handoff artifact should carry node_id");
    const verdictArtifact = artifacts.find((a) => a.type === "acceptance_verdict" && a.exists);
    assert.ok(verdictArtifact, "expected an existing acceptance verdict artifact");
    assert.ok(artifacts.some((a) => a.ref === "summary.md" && a.exists));
  });
});
