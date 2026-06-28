import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInitCommand } from "../src/init-command.js";
import { writeJsonFile, readJsonFile } from "../src/json-file.js";
import { startWorkflowRun } from "../src/core.js";
import type { AdapterConfig, AgenticRun, Run } from "../src/types.js";

const NODE_BIN_DIR = dirname(process.execPath);
const WORKFLOW_ID = "feature-planning-agentic";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forgekit-tmpl-"));
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
  adapter.env_allowlist = [...(adapter.env_allowlist ?? []), "FAKE_STATE", "FAKE_REJECT_TIMES"];
  await writeJsonFile(path, adapter);
}

/**
 * Deterministic fake adapter (codex shape) reused for the shipped template: it answers
 * acceptance gates and emits a handoff.v2 that always routes to the single declared
 * candidate, finishing only at the terminal role. FAKE_REJECT_TIMES rejects the first N
 * gate visits so we can exercise reject -> rework -> accept against the real template.
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
// Emit session markers for both adapter shapes (codex: thread.started, claude: system/init).
function emitSession(roleId) {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "sess-" + roleId }));
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-" + roleId }));
}
(async () => {
  // codex sends the prompt on stdin; claude-code passes it as the last CLI argument.
  let prompt = await readStdin();
  if (!prompt.trim()) { prompt = process.argv[process.argv.length - 1] || ""; }
  const runId = first(/- run_id: (.+)/, prompt);
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
    emitSession(roleId);
    console.log(JSON.stringify(verdict));
    process.exit(0);
  }
  if (prompt.includes("ForgeKit Agentic Node")) {
    const nodeId = first(/- node_id: (.+)/, prompt);
    const roleId = first(/^- role_id: (.+)$/m, prompt);
    const mustNotFinal = prompt.includes("You MUST NOT finish here");
    const candLine = first(/EXACTLY ONE of: ([^\\n.]+)/, prompt);
    const candidates = candLine.split(",").map((s) => s.trim()).filter(Boolean);
    const next = mustNotFinal
      ? { kind: "handoff", recommended_role: candidates[0], instructions: "Continue the plan and verify it matches the task.", acceptance_criteria: ["Deliverable addresses the task"] }
      : { kind: "final", recommended_role: "", instructions: "", acceptance_criteria: [] };
    const handoff = {
      schema_version: "handoff.v2",
      run_id: runId,
      step_id: nodeId,
      role_id: roleId,
      status: "completed",
      summary: "Work output for " + roleId,
      decisions: [],
      assumptions: [],
      risks: [],
      open_questions: [],
      out_of_scope: [],
      markdown_body: "# Output for " + roleId + "\\nDone.",
      next_handoff: next,
      artifacts: []
    };
    emitSession(roleId);
    console.log(JSON.stringify(handoff));
    process.exit(0);
  }
  console.error("fake-agent: unrecognized prompt");
  process.exit(3);
})();
`;
}

async function scaffold(dir: string, rejectTimes: number): Promise<NodeJS.ProcessEnv> {
  await runInitCommand(["--template", WORKFLOW_ID, "--yes"], dir);
  const fakeAgent = join(dir, "fake-agent.cjs");
  await writeExecutable(fakeAgent, fakeAgentScript());
  await patchAdapterCommand(dir, "codex.json", fakeAgent);
  await patchAdapterCommand(dir, "claude-code.json", fakeAgent);
  return {
    PATH: `${dir}:${NODE_BIN_DIR}:/usr/bin:/bin`,
    HOME: dir,
    FAKE_STATE: join(dir, "fake-state.json"),
    FAKE_REJECT_TIMES: String(rejectTimes)
  };
}

function asAgentic(run: Run | AgenticRun): AgenticRun {
  assert.equal((run as AgenticRun).run_mode, "agentic");
  return run as AgenticRun;
}

test("feature-planning-agentic template runs end-to-end (happy path)", async () => {
  await withTempProject(async (dir) => {
    const env = await scaffold(dir, 0);
    const run = asAgentic(
      await startWorkflowRun({
        workflowId: WORKFLOW_ID,
        taskInput: "Plan a CSV export feature",
        projectRoot: dir,
        env,
        writeEventsJsonl: true
      })
    );

    assert.equal(run.status, "completed");
    assert.deepEqual(run.nodes.map((node) => node.role_id), ["pm", "architect", "engineer", "qa"]);
    assert.equal(run.nodes[0].entry_reason, "entrypoint");
    assert.equal(run.nodes.at(-1)?.role_id, "qa");
    assert.equal(run.nodes.at(-1)?.status, "completed");
    // qa is the terminal role that finalized the run
    for (const node of run.nodes.slice(1)) {
      assert.equal(node.acceptance?.verdict, "accept");
    }
    assert.equal(run.active_cursor, null);

    await stat(join(dir, ".forgekit/runs", run.run_id, "summary.md"));
    await stat(join(dir, ".forgekit/runs", run.run_id, "run.json"));
  });
});

test("feature-planning-agentic template handles reject -> rework -> accept", async () => {
  await withTempProject(async (dir) => {
    const env = await scaffold(dir, 1);
    const run = asAgentic(
      await startWorkflowRun({
        workflowId: WORKFLOW_ID,
        taskInput: "Plan a feature with a rework cycle",
        projectRoot: dir,
        env
      })
    );

    assert.equal(run.status, "completed");
    // pm -> architect(reject) -> pm(rework) -> architect -> engineer -> qa
    assert.deepEqual(
      run.nodes.map((node) => node.role_id),
      ["pm", "architect", "pm", "architect", "engineer", "qa"]
    );
    assert.equal(run.nodes[1].acceptance?.verdict, "reject");
    assert.equal(run.nodes[1].status, "rejected_upstream");
    assert.equal(run.nodes[2].entry_reason, "rework");

    const reworkEdge = run.edges.find((edge) => edge.type === "rework");
    assert.ok(reworkEdge, "expected a rework edge");
    assert.equal(run.budget.role_visits.pm, 2);
    assert.equal(run.budget.role_visits.architect, 2);
  });
});
