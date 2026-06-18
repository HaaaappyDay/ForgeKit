import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadSchema } from "./schema-registry.js";
import { validateJson } from "./schema-validator.js";

function isoNow() {
  return new Date().toISOString();
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function createRunId(workflowId, date = new Date()) {
  return `${compactTimestamp(date)}-${slug(workflowId)}`;
}

export function stepDirName(index, stepId) {
  return `${String(index + 1).padStart(2, "0")}-${stepId}`;
}

export function attemptDirName(attemptIndex) {
  return `attempt-${String(attemptIndex + 1).padStart(2, "0")}`;
}

export function createInitialRun({ runId, workflow, taskInput }) {
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

export function runRoot(projectRoot, runId) {
  return join(projectRoot, ".forgekit/runs", runId);
}

export function runJsonPath(projectRoot, runId) {
  return join(runRoot(projectRoot, runId), "run.json");
}

export function attemptRoot(projectRoot, runId, stepIndex, stepId, attemptIndex) {
  return join(runRoot(projectRoot, runId), "steps", stepDirName(stepIndex, stepId), attemptDirName(attemptIndex));
}

export async function ensureRunDirectories(projectRoot, run) {
  await mkdir(join(runRoot(projectRoot, run.run_id), "steps"), { recursive: true });
  await mkdir(join(runRoot(projectRoot, run.run_id), "context"), { recursive: true });
}

export async function writeRun(projectRoot, run) {
  run.updated_at = isoNow();
  const schema = await loadSchema("forgekit.run.v1");
  const result = validateJson(schema, run);
  if (!result.valid) {
    throw new Error(`Invalid run.json:\n${result.errors.join("\n")}`);
  }
  await mkdir(runRoot(projectRoot, run.run_id), { recursive: true });
  await writeFile(runJsonPath(projectRoot, run.run_id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

export async function readRun(projectRoot, runId) {
  return JSON.parse(await readFile(runJsonPath(projectRoot, runId), "utf8"));
}

export async function writeTextArtifact(projectRoot, runId, relativePath, content) {
  const path = join(runRoot(projectRoot, runId), relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export function relativeAttemptPath(stepIndex, stepId, attemptIndex, file) {
  return join("steps", stepDirName(stepIndex, stepId), attemptDirName(attemptIndex), file);
}

export function upsertRoleSession(run, { roleId, adapterId, externalSessionId, resumeStrategy }) {
  run.role_sessions[roleId] = {
    role_id: roleId,
    adapter_id: adapterId,
    external_session_id: externalSessionId,
    resume_strategy: resumeStrategy,
    created_at: run.role_sessions[roleId]?.created_at ?? isoNow(),
    status: "active"
  };
}
