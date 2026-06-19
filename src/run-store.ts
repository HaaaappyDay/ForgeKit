import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";
import type { BudgetExceededKey, ResumeStrategy, Run, WorkflowConfig } from "./types.js";

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
  return JSON.parse(await readFile(runJsonPath(projectRoot, runId), "utf8")) as Run;
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
  run: Run,
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
