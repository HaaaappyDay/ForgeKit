import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ForgeKitError } from "./errors.js";
import { isNodeErrorCode } from "./node-error.js";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import type {
  ActiveCursor,
  AgenticRun,
  AgenticWorkflowConfig,
  AttemptPhase,
  BudgetExceededKey,
  NodeEntryReason,
  ResumeStrategy,
  RoleSession,
  Run,
  RunEdge,
  RunNode,
  WorkflowConfig
} from "./types.js";

function isoNow(): string {
  return new Date().toISOString();
}

function compactTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function createRunId(workflowId: string, date = new Date()): string {
  return `${compactTimestamp(date)}-${slug(workflowId)}`;
}

export function stepDirName(index: number, stepId: string): string {
  return `${String(index + 1).padStart(2, "0")}-${stepId}`;
}

export function attemptDirName(attemptIndex: number): string {
  return `attempt-${String(attemptIndex + 1).padStart(2, "0")}`;
}

export function createInitialRun({
  runId,
  workflow,
  taskInput,
  budgets
}: {
  runId: string;
  workflow: WorkflowConfig;
  taskInput: string;
  budgets: {
    max_invocations: number;
    max_retries_per_step: number;
    max_duration_minutes: number;
    max_output_bytes: number;
  };
}): Run {
  const now = isoNow();
  return {
    schema_version: "forgekit.run.v1",
    run_id: runId,
    workflow_id: workflow.id,
    status: "pending",
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: "",
    duration_ms: 0,
    task: {
      input: taskInput
    },
    role_sessions: {},
    budget: {
      max_invocations: budgets.max_invocations,
      max_retries_per_step: budgets.max_retries_per_step,
      max_duration_minutes: budgets.max_duration_minutes,
      max_output_bytes: budgets.max_output_bytes,
      invocations: 0,
      retries: 0,
      input_chars: 0,
      output_bytes: 0,
      exceeded: []
    },
    steps: workflow.steps.map((step, index) => ({
      index: index + 1,
      step_id: step.id,
      role_id: step.role,
      adapter_id: "",
      status: "pending",
      active_attempt: "",
      attempts: []
    }))
  };
}

export function recordAdapterCall(
  run: Run,
  {
    prompt,
    stdout,
    stderr,
    isRetry
  }: {
    prompt: string;
    stdout: string | null | undefined;
    stderr: string | null | undefined;
    isRetry: boolean;
  }
): void {
  run.budget.invocations += 1;
  run.budget.input_chars += prompt.length;
  run.budget.output_bytes += Buffer.byteLength(stdout ?? "", "utf8") + Buffer.byteLength(stderr ?? "", "utf8");
  if (isRetry) {
    run.budget.retries += 1;
  }

  const exceeded = new Set(run.budget.exceeded);
  if (run.budget.invocations > run.budget.max_invocations) exceeded.add("max_invocations");
  if (run.budget.output_bytes > run.budget.max_output_bytes) exceeded.add("max_output_bytes");
  run.budget.exceeded = [...exceeded].sort();
}

export function markBudgetExceeded(run: Run, key: BudgetExceededKey): void {
  const exceeded = new Set(run.budget.exceeded);
  exceeded.add(key);
  run.budget.exceeded = [...exceeded].sort();
}

export function runRoot(projectRoot: string, runId: string): string {
  return join(projectRoot, ".forgekit/runs", runId);
}

export function runJsonPath(projectRoot: string, runId: string): string {
  return join(runRoot(projectRoot, runId), "run.json");
}

export function attemptRoot(
  projectRoot: string,
  runId: string,
  stepIndex: number,
  stepId: string,
  attemptIndex: number
): string {
  return join(runRoot(projectRoot, runId), "steps", stepDirName(stepIndex, stepId), attemptDirName(attemptIndex));
}

export async function ensureRunDirectories(projectRoot: string, run: Run): Promise<void> {
  await mkdir(join(runRoot(projectRoot, run.run_id), "steps"), { recursive: true });
  await mkdir(join(runRoot(projectRoot, run.run_id), "context"), { recursive: true });
}

export async function writeRun(projectRoot: string, run: Run): Promise<void> {
  run.updated_at = isoNow();
  const schema = await loadSchema("forgekit.run.v1");
  const result = validateJson(schema, run);
  if (!result.valid) {
    throw new Error(`Invalid run.json:\n${result.errors.join("\n")}`);
  }
  await mkdir(runRoot(projectRoot, run.run_id), { recursive: true });
  await writeFile(runJsonPath(projectRoot, run.run_id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

export async function readRun(projectRoot: string, runId: string): Promise<Run> {
  const path = runJsonPath(projectRoot, runId);
  try {
    return JSON.parse(await readFile(path, "utf8")) as Run;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ForgeKitError({
        code: "run_not_found",
        message: `Run not found: ${runId}`,
        category: "run",
        retryable: false,
        details: { run_id: runId, path }
      });
    }
    throw error;
  }
}

export async function writeTextArtifact(
  projectRoot: string,
  runId: string,
  relativePath: string,
  content: string
): Promise<void> {
  const path = join(runRoot(projectRoot, runId), relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export function relativeAttemptPath(stepIndex: number, stepId: string, attemptIndex: number, file: string): string {
  return join("steps", stepDirName(stepIndex, stepId), attemptDirName(attemptIndex), file);
}

export function upsertRoleSession(
  run: { role_sessions: Record<string, RoleSession> },
  {
    roleId,
    adapterId,
    externalSessionId,
    resumeStrategy
  }: {
    roleId: string;
    adapterId: string;
    externalSessionId: string;
    resumeStrategy: ResumeStrategy;
  }
): void {
  run.role_sessions[roleId] = {
    role_id: roleId,
    adapter_id: adapterId,
    external_session_id: externalSessionId,
    resume_strategy: resumeStrategy,
    created_at: run.role_sessions[roleId]?.created_at ?? isoNow(),
    status: "active"
  };
}

// ---------------------------------------------------------------------------
// Agentic run storage (forgekit.run.v2). Coexists with the linear run.v1 API
// above; consumers discriminate on `run_mode` / `schema_version`.
// ---------------------------------------------------------------------------

export function agenticNodeId(nodeSeq: number, roleId: string): string {
  return `n${nodeSeq}-${roleId}`;
}

export function agenticNodeDirName(nodeSeq: number, roleId: string): string {
  return `${String(nodeSeq).padStart(2, "0")}-${roleId}`;
}

export function agenticAttemptRoot(
  projectRoot: string,
  runId: string,
  nodeSeq: number,
  roleId: string,
  phase: AttemptPhase,
  attemptIndex: number
): string {
  return join(
    runRoot(projectRoot, runId),
    "nodes",
    agenticNodeDirName(nodeSeq, roleId),
    phase,
    attemptDirName(attemptIndex)
  );
}

export function relativeAgenticAttemptPath(
  nodeSeq: number,
  roleId: string,
  phase: AttemptPhase,
  attemptIndex: number,
  file: string
): string {
  return join("nodes", agenticNodeDirName(nodeSeq, roleId), phase, attemptDirName(attemptIndex), file);
}

export function createInitialAgenticRun({
  runId,
  workflow,
  taskInput,
  budgets
}: {
  runId: string;
  workflow: AgenticWorkflowConfig;
  taskInput: string;
  budgets: {
    max_invocations: number;
    max_retries_per_step: number;
    max_duration_minutes: number;
    max_output_bytes: number;
    max_steps: number;
    max_role_visits: number;
  };
}): AgenticRun {
  const now = isoNow();
  return {
    schema_version: "forgekit.run.v2",
    run_id: runId,
    workflow_id: workflow.id,
    run_mode: "agentic",
    status: "pending",
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: "",
    duration_ms: 0,
    task: {
      input: taskInput
    },
    active_cursor: null,
    nodes: [],
    edges: [],
    role_sessions: {},
    budget: {
      max_invocations: budgets.max_invocations,
      max_retries_per_step: budgets.max_retries_per_step,
      max_duration_minutes: budgets.max_duration_minutes,
      max_output_bytes: budgets.max_output_bytes,
      max_steps: budgets.max_steps,
      max_role_visits: budgets.max_role_visits,
      invocations: 0,
      retries: 0,
      steps: 0,
      role_visits: {},
      input_chars: 0,
      output_bytes: 0,
      exceeded: []
    },
    escalation: null
  };
}

export function addEdge(
  run: AgenticRun,
  edge: { from: string; to: string; type: RunEdge["type"]; reason?: string[] }
): RunEdge {
  const created: RunEdge = { from: edge.from, to: edge.to, type: edge.type };
  if (edge.reason && edge.reason.length > 0) {
    created.reason = [...edge.reason];
  }
  run.edges.push(created);
  return created;
}

/**
 * Appends a new node to an agentic run, advances step/role-visit accounting, and
 * derives the corresponding edge from `enteredFrom`/`entryReason` so nodes and
 * edges stay consistent (spec §8). Returns the created node.
 */
export function appendNode(
  run: AgenticRun,
  params: {
    roleId: string;
    adapterId?: string;
    entryReason: NodeEntryReason;
    enteredFrom?: string | null;
    objective?: string;
    edgeReason?: string[];
  }
): RunNode {
  const nodeSeq = run.nodes.length + 1;
  const node: RunNode = {
    node_seq: nodeSeq,
    node_id: agenticNodeId(nodeSeq, params.roleId),
    role_id: params.roleId,
    adapter_id: params.adapterId ?? "",
    entry_reason: params.entryReason,
    entered_from: params.enteredFrom ?? null,
    objective: params.objective ?? "",
    status: "pending",
    acceptance: null,
    attempts: [],
    handoff_ref: "",
    chosen_next_role: null
  };
  run.nodes.push(node);

  run.budget.steps += 1;
  run.budget.role_visits[params.roleId] = (run.budget.role_visits[params.roleId] ?? 0) + 1;

  if (node.entered_from) {
    addEdge(run, {
      from: node.entered_from,
      to: node.node_id,
      type: params.entryReason === "rework" ? "rework" : "handoff",
      reason: params.edgeReason
    });
  }

  return node;
}

export function roleVisits(run: AgenticRun, roleId: string): number {
  return run.budget.role_visits[roleId] ?? 0;
}

export function markAgenticBudgetExceeded(run: AgenticRun, key: BudgetExceededKey): void {
  const exceeded = new Set<BudgetExceededKey>(run.budget.exceeded);
  exceeded.add(key);
  run.budget.exceeded = [...exceeded].sort();
}

export function recordAgenticAdapterCall(
  run: AgenticRun,
  {
    prompt,
    stdout,
    stderr,
    isRetry
  }: {
    prompt: string;
    stdout: string | null | undefined;
    stderr: string | null | undefined;
    isRetry: boolean;
  }
): void {
  run.budget.invocations += 1;
  run.budget.input_chars += prompt.length;
  run.budget.output_bytes += Buffer.byteLength(stdout ?? "", "utf8") + Buffer.byteLength(stderr ?? "", "utf8");
  if (isRetry) {
    run.budget.retries += 1;
  }

  if (run.budget.invocations > run.budget.max_invocations) markAgenticBudgetExceeded(run, "max_invocations");
  if (run.budget.output_bytes > run.budget.max_output_bytes) markAgenticBudgetExceeded(run, "max_output_bytes");
}

export function setActiveCursor(run: AgenticRun, cursor: ActiveCursor | null): void {
  run.active_cursor = cursor;
}

export async function ensureAgenticRunDirectories(projectRoot: string, run: AgenticRun): Promise<void> {
  await mkdir(join(runRoot(projectRoot, run.run_id), "nodes"), { recursive: true });
  await mkdir(join(runRoot(projectRoot, run.run_id), "context"), { recursive: true });
}

export async function writeAgenticRun(projectRoot: string, run: AgenticRun): Promise<void> {
  run.updated_at = isoNow();
  const schema = await loadSchema("forgekit.run.v2");
  const result = validateJson(schema, run);
  if (!result.valid) {
    throw new Error(`Invalid run.json (agentic):\n${result.errors.join("\n")}`);
  }
  await mkdir(runRoot(projectRoot, run.run_id), { recursive: true });
  await writeFile(runJsonPath(projectRoot, run.run_id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

export async function readAgenticRun(projectRoot: string, runId: string): Promise<AgenticRun> {
  const path = runJsonPath(projectRoot, runId);
  try {
    return JSON.parse(await readFile(path, "utf8")) as AgenticRun;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ForgeKitError({
        code: "run_not_found",
        message: `Run not found: ${runId}`,
        category: "run",
        retryable: false,
        details: { run_id: runId, path }
      });
    }
    throw error;
  }
}

/**
 * Reads a run discriminating on `run_mode`/`schema_version` so callers can branch
 * between the linear (`run.v1`) and agentic (`run.v2`) shapes (spec §15).
 */
export async function readAnyRun(projectRoot: string, runId: string): Promise<Run | AgenticRun> {
  const path = runJsonPath(projectRoot, runId);
  let parsed: Run | AgenticRun;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as Run | AgenticRun;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ForgeKitError({
        code: "run_not_found",
        message: `Run not found: ${runId}`,
        category: "run",
        retryable: false,
        details: { run_id: runId, path }
      });
    }
    throw error;
  }
  return parsed;
}

export function isAgenticRun(run: Run | AgenticRun): run is AgenticRun {
  return (run as AgenticRun).run_mode === "agentic" || run.schema_version === "forgekit.run.v2";
}
