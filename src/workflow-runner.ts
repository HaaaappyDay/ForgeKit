import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeAdapterStep, resumeStrategyFor } from "./adapters/execute.js";
import { buildCorrectionPrompt } from "./correction-prompt.js";
import { ForgeKitError } from "./errors.js";
import { writeFinalSummary } from "./final-summary.js";
import { parseHandoffFromRaw } from "./handoff-parser.js";
import { normalizeHandoffArtifacts, validateHandoffContent } from "./handoff-validator.js";
import { buildStepPrompt } from "./prompt-builder.js";
import { loadAdapterConfig, loadProjectConfig, loadRoleConfig, loadWorkflowConfig } from "./project-config.js";
import { collectRepoContext } from "./repo-context.js";
import { validateLinearWorkflow } from "./run-plan.js";
import {
  attemptDirName,
  attemptRoot,
  createInitialRun,
  createRunId,
  ensureRunDirectories,
  markBudgetExceeded,
  readRun,
  recordAdapterCall,
  relativeAttemptPath,
  upsertRoleSession,
  writeRun
} from "./run-store.js";
import { readJsonFile } from "./json-file.js";
import { isNodeErrorCode } from "./node-error.js";
import {
  createRunEventEmitter,
  type RunEventEmitter,
  type RunEventObserver,
  type RunEventSink
} from "./run-events.js";
import { schemaPath, schemaText } from "./schema-registry.js";
import {
  createWorkflowSummary,
  readWorkflowSummary,
  updateWorkflowSummary,
  writeWorkflowSummary
} from "./workflow-summary.js";
import type {
  AdapterExecutionResult,
  Handoff,
  JsonObject,
  RepoSummary,
  RoleConfig,
  Run,
  RunAttempt,
  RunStep,
  WorkflowConfig,
  WorkflowStep,
  WorkflowSummary
} from "./types.js";

interface ValidationSummary {
  valid: boolean;
  parse_errors: string[];
  schema_errors: string[];
  content_errors: string[];
}

interface BuildValidationResult extends ValidationSummary {
  handoff: Handoff | null;
}

interface ValidationRecord {
  valid: boolean;
  correction_attempted: boolean;
  correction_succeeded: boolean;
  initial: ValidationSummary | null;
  correction: ValidationSummary | null;
}

interface StepExecutionContext {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  events: RunEventEmitter;
  run: Run;
  workflow: WorkflowConfig;
  workflowSummary: WorkflowSummary;
  repoSummary: RepoSummary;
  handoffSchemaPath: string;
  handoffSchemaJson: string;
  step: WorkflowStep;
  stepIndex: number;
  previousStep: RunStep | null;
  isRunRetry: boolean;
}

interface StepExecutionResult {
  status: "completed" | "failed";
  completedHandoff: Handoff | null;
  handoffRef: string;
}

interface WorkflowExecutionContext {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  events: RunEventEmitter;
  run: Run;
  workflow: WorkflowConfig;
  startIndex: number;
  isRunRetry: boolean;
}

interface RunWorkflowOptions {
  workflowId: string;
  taskInput: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  eventObservers?: RunEventObserver[];
  eventSinks?: RunEventSink[];
  writeEventsJsonl?: boolean;
}

interface RetryWorkflowOptions {
  runId: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  eventObservers?: RunEventObserver[];
  eventSinks?: RunEventSink[];
  writeEventsJsonl?: boolean;
}

function isoNow(): string {
  return new Date().toISOString();
}

function artifactEventData(ref: string, type: string, content?: string): JsonObject {
  return {
    ref,
    type,
    exists: true,
    ...(content === undefined ? {} : { bytes: Buffer.byteLength(content, "utf8") })
  };
}

async function emitArtifactWritten(
  events: RunEventEmitter,
  ref: string,
  type: string,
  content?: string,
  context: {
    step_id?: string;
    role_id?: string;
    adapter_id?: string;
    attempt_id?: string;
  } = {}
): Promise<void> {
  await events.emit({
    type: "artifact_written",
    message: "Artifact written",
    ...context,
    data: artifactEventData(ref, type, content)
  });
}

async function emitNewBudgetEvents(
  events: RunEventEmitter,
  run: Run,
  previousExceeded: Set<string>
): Promise<void> {
  for (const key of run.budget.exceeded) {
    if (previousExceeded.has(key)) continue;
    await events.emit({
      type: "budget_exceeded",
      message: `Budget exceeded: ${key}`,
      data: {
        key,
        invocations: run.budget.invocations,
        max_invocations: run.budget.max_invocations,
        retries: run.budget.retries,
        max_retries_per_step: run.budget.max_retries_per_step,
        output_bytes: run.budget.output_bytes,
        max_output_bytes: run.budget.max_output_bytes,
        duration_ms: run.duration_ms,
        max_duration_minutes: run.budget.max_duration_minutes
      }
    });
  }
}

function completedStatusFromExit(exitCode: number | null, externalSessionId: string | null): "completed" | "failed" {
  if (exitCode !== 0) return "failed";
  if (!externalSessionId) return "failed";
  return "completed";
}

function combineLogs(initial: string, correction: string): string {
  if (!correction) return initial;
  return `=== initial ===\n${initial}\n\n=== correction ===\n${correction}`;
}

function failureMessage(status: "completed" | "failed", result: AdapterExecutionResult): string {
  if (status !== "failed") return "";
  if (result.error) return result.error;
  if (!result.externalSessionId) return "missing external session id";
  return "handoff validation failed";
}

function adapterErrorCode(result: AdapterExecutionResult): string {
  if (!result.error && result.exitCode === 0) return "";
  if (result.error?.startsWith("Command not found or not executable")) return "adapter_command_not_found";
  if (result.timedOut) return "adapter_timeout";
  return "adapter_process_failed";
}

function validationErrorCode(validation: ValidationSummary): string {
  if (validation.valid) return "";
  if (validation.parse_errors.length > 0) return "handoff_parse_failed";
  if (validation.schema_errors.length > 0) return "handoff_schema_invalid";
  if (validation.content_errors.length > 0) return "handoff_content_invalid";
  return "handoff_content_invalid";
}

function attemptErrorCode(
  status: "completed" | "failed",
  result: AdapterExecutionResult,
  validationRecord: ValidationRecord
): string {
  if (status === "completed") return "";
  const adapterCode = adapterErrorCode(result);
  if (adapterCode) return adapterCode;
  if (validationRecord.correction && !validationRecord.correction.valid) {
    return validationErrorCode(validationRecord.correction);
  }
  if (validationRecord.initial && !validationRecord.initial.valid) {
    return validationErrorCode(validationRecord.initial);
  }
  return "adapter_process_failed";
}

async function buildValidation({
  raw,
  run,
  step,
  role,
  markdownRef
}: {
  raw: string;
  run: Run;
  step: WorkflowStep;
  role: RoleConfig;
  markdownRef: string;
}): Promise<BuildValidationResult> {
  const parsed = parseHandoffFromRaw(raw);
  if (!parsed.handoff) {
    return {
      valid: false,
      handoff: null,
      parse_errors: parsed.errors,
      schema_errors: [],
      content_errors: []
    };
  }

  const normalized = normalizeHandoffArtifacts(parsed.handoff, markdownRef);
  const validation = await validateHandoffContent(normalized, {
    runId: run.run_id,
    stepId: step.id,
    roleId: role.id
  });

  return {
    valid: validation.valid,
    handoff: validation.valid ? normalized as Handoff : null,
    parse_errors: [],
    schema_errors: validation.schema_errors,
    content_errors: validation.content_errors
  };
}

async function writeValidationFiles(
  projectRoot: string,
  run: Run,
  stepIndex: number,
  stepId: string,
  attemptIndex: number,
  validationRecord: ValidationRecord
): Promise<void> {
  const root = attemptRoot(projectRoot, run.run_id, stepIndex, stepId, attemptIndex);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "validation.json"), `${JSON.stringify(validationRecord, null, 2)}\n`, "utf8");
}

async function writeHandoffFiles(
  projectRoot: string,
  run: Run,
  stepIndex: number,
  stepId: string,
  attemptIndex: number,
  handoff: Handoff
): Promise<void> {
  const root = attemptRoot(projectRoot, run.run_id, stepIndex, stepId, attemptIndex);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  await writeFile(join(root, "output.md"), `${handoff.markdown_body.trim()}\n`, "utf8");
}

async function writeAttemptFiles(
  projectRoot: string,
  run: Run,
  stepIndex: number,
  stepId: string,
  attemptIndex: number,
  files: Record<string, string>
): Promise<void> {
  const root = attemptRoot(projectRoot, run.run_id, stepIndex, stepId, attemptIndex);
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(root, file), content, "utf8");
  }
}

async function loadOrCollectRepoSummary(projectRoot: string, run: Run): Promise<RepoSummary> {
  const path = join(projectRoot, ".forgekit/runs", run.run_id, "context/repo-summary.json");
  try {
    return await readJsonFile<RepoSummary>(path);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
    const repoSummary = await collectRepoContext(projectRoot);
    await writeFile(path, `${JSON.stringify(repoSummary, null, 2)}\n`, "utf8");
    return repoSummary;
  }
}

async function loadOrCreateWorkflowSummary(
  projectRoot: string,
  run: Run,
  workflow: WorkflowConfig
): Promise<WorkflowSummary> {
  try {
    return await readWorkflowSummary(projectRoot, run.run_id);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
    const workflowSummary = createWorkflowSummary(run, workflow);
    await writeWorkflowSummary(projectRoot, workflowSummary);
    return workflowSummary;
  }
}

async function executeStep({
  projectRoot,
  env,
  events,
  run,
  workflow,
  workflowSummary,
  repoSummary,
  handoffSchemaPath,
  handoffSchemaJson,
  step,
  stepIndex,
  previousStep,
  isRunRetry
}: StepExecutionContext): Promise<StepExecutionResult> {
  const stepTrace = run.steps[stepIndex];
  const { role, adapterId } = await loadRoleConfig(step.role, projectRoot);
  const { adapter } = await loadAdapterConfig(adapterId, projectRoot);
  await events.emit({
    type: "step_started",
    message: "Step started",
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    data: {
      index: stepIndex + 1,
      objective: step.objective
    }
  });
  const existingSession = run.role_sessions[role.id]?.external_session_id ?? null;
  const attemptIndex = stepTrace.attempts.length;
  const attemptId = attemptDirName(attemptIndex);
  const startedAt = isoNow();
  const prompt = buildStepPrompt({ run, workflow, step, role, previousStep, repoSummary, workflowSummary });
  const promptRef = relativeAttemptPath(stepIndex, step.id, attemptIndex, "prompt.md");
  const rawRef = relativeAttemptPath(stepIndex, step.id, attemptIndex, "raw.log");
  const errorRef = relativeAttemptPath(stepIndex, step.id, attemptIndex, "error.log");
  const handoffRef = relativeAttemptPath(stepIndex, step.id, attemptIndex, "handoff.json");
  const markdownRef = relativeAttemptPath(stepIndex, step.id, attemptIndex, "output.md");
  const validationRef = relativeAttemptPath(stepIndex, step.id, attemptIndex, "validation.json");

  let exceededBefore = new Set(run.budget.exceeded);
  if (attemptIndex > run.budget.max_retries_per_step) {
    markBudgetExceeded(run, "max_retries_per_step");
  }
  await emitNewBudgetEvents(events, run, exceededBefore);

  const attempt: RunAttempt = {
    attempt_id: attemptId,
    status: "running",
    started_at: startedAt,
    completed_at: "",
    duration_ms: 0,
    prompt_ref: promptRef,
    stdout_ref: rawRef,
    stderr_ref: errorRef,
    handoff_ref: "",
    markdown_ref: "",
    validation_ref: validationRef,
    exit_code: -1,
    external_session_id: existingSession ?? "",
    correction_count: 0,
    error: ""
  };

  stepTrace.adapter_id = adapterId;
  stepTrace.status = "running";
  stepTrace.active_attempt = attemptId;
  stepTrace.attempts.push(attempt);
  await writeAttemptFiles(projectRoot, run, stepIndex, step.id, attemptIndex, {
    "prompt.md": prompt,
    "raw.log": "",
    "error.log": ""
  });
  await events.emit({
    type: "attempt_started",
    message: "Attempt started",
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    attempt_id: attemptId,
    data: {
      attempt_index: attemptIndex + 1,
      prompt_ref: promptRef,
      stdout_ref: rawRef,
      stderr_ref: errorRef,
      resumed_external_session: Boolean(existingSession)
    }
  });
  await emitArtifactWritten(events, promptRef, "prompt", prompt, {
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    attempt_id: attemptId
  });
  await emitArtifactWritten(events, rawRef, "stdout", "", {
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    attempt_id: attemptId
  });
  await emitArtifactWritten(events, errorRef, "stderr", "", {
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    attempt_id: attemptId
  });
  await writeRun(projectRoot, run);

  await events.emit({
    type: "adapter_invocation_started",
    message: "Adapter invocation started",
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    attempt_id: attemptId,
    data: {
      adapter_type: adapter.type,
      command: adapter.command,
      resumed_external_session: Boolean(existingSession)
    }
  });
  const result = await executeAdapterStep(adapter, prompt, {
    cwd: projectRoot,
    env,
    externalSessionId: existingSession,
    outputSchemaPath: handoffSchemaPath,
    outputSchemaJson: handoffSchemaJson
  });
  exceededBefore = new Set(run.budget.exceeded);
  recordAdapterCall(run, {
    prompt,
    stdout: result.stdout,
    stderr: result.stderr,
    isRetry: isRunRetry || attemptIndex > 0
  });
  await emitNewBudgetEvents(events, run, exceededBefore);

  await writeAttemptFiles(projectRoot, run, stepIndex, step.id, attemptIndex, {
    "raw.log": result.stdout,
    "error.log": result.stderr
  });
  await events.emit({
    type: "adapter_invocation_completed",
    message: "Adapter invocation completed",
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    attempt_id: attemptId,
    data: {
      exit_code: result.exitCode ?? -1,
      duration_ms: result.durationMs,
      stdout_ref: rawRef,
      stderr_ref: errorRef,
      stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
      stderr_bytes: Buffer.byteLength(result.stderr, "utf8"),
      external_session_id: result.externalSessionId ?? "",
      error: result.error ?? "",
      error_code: adapterErrorCode(result)
    }
  });
  await emitArtifactWritten(events, rawRef, "stdout", result.stdout, {
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    attempt_id: attemptId
  });
  await emitArtifactWritten(events, errorRef, "stderr", result.stderr, {
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    attempt_id: attemptId
  });

  let status = completedStatusFromExit(result.exitCode, result.externalSessionId);
  let finalResult: AdapterExecutionResult = result;
  let completedHandoff: Handoff | null = null;
  let validationRecord: ValidationRecord = {
    valid: false,
    correction_attempted: false,
    correction_succeeded: false,
    initial: null,
    correction: null
  };

  if (status === "completed") {
    stepTrace.status = "validating";
    attempt.status = "validating";
    await writeRun(projectRoot, run);

    await events.emit({
      type: "validation_started",
      message: "Validation started",
      step_id: step.id,
      role_id: role.id,
      adapter_id: adapterId,
      attempt_id: attemptId,
      data: {
        phase: "initial",
        stdout_ref: rawRef,
        validation_ref: validationRef
      }
    });
    const initialValidation = await buildValidation({
      raw: result.stdout,
      run,
      step,
      role,
      markdownRef
    });
    validationRecord.initial = {
      valid: initialValidation.valid,
      parse_errors: initialValidation.parse_errors,
      schema_errors: initialValidation.schema_errors,
      content_errors: initialValidation.content_errors
    };
    await events.emit({
      type: "validation_completed",
      message: initialValidation.valid ? "Validation completed" : "Validation failed",
      step_id: step.id,
      role_id: role.id,
      adapter_id: adapterId,
      attempt_id: attemptId,
      data: {
        phase: "initial",
        valid: initialValidation.valid,
        parse_errors: initialValidation.parse_errors,
        schema_errors: initialValidation.schema_errors,
        content_errors: initialValidation.content_errors,
        validation_ref: validationRef,
        error_code: validationErrorCode(initialValidation)
      }
    });

    if (initialValidation.valid && initialValidation.handoff) {
      completedHandoff = initialValidation.handoff;
      await writeHandoffFiles(projectRoot, run, stepIndex, step.id, attemptIndex, initialValidation.handoff);
      await emitArtifactWritten(events, handoffRef, "handoff", JSON.stringify(initialValidation.handoff, null, 2), {
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId
      });
      await emitArtifactWritten(events, markdownRef, "markdown", `${initialValidation.handoff.markdown_body.trim()}\n`, {
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId
      });
    } else {
      stepTrace.status = "self_correcting";
      attempt.status = "self_correcting";
      validationRecord.correction_attempted = true;
      await writeValidationFiles(projectRoot, run, stepIndex, step.id, attemptIndex, validationRecord);
      await emitArtifactWritten(events, validationRef, "validation", JSON.stringify(validationRecord, null, 2), {
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId
      });
      await writeRun(projectRoot, run);

      await events.emit({
        type: "self_correction_started",
        message: "Self-correction started",
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId,
        data: {
          validation_ref: validationRef
        }
      });
      const correctionPrompt = buildCorrectionPrompt({
        run,
        step,
        role,
        validation: {
          parse_errors: initialValidation.parse_errors,
          schema_errors: initialValidation.schema_errors,
          content_errors: initialValidation.content_errors
        },
        rawOutput: result.stdout
      });
      await writeAttemptFiles(projectRoot, run, stepIndex, step.id, attemptIndex, {
        "correction-prompt.md": correctionPrompt
      });
      const correctionPromptRef = relativeAttemptPath(stepIndex, step.id, attemptIndex, "correction-prompt.md");
      const correctionRawRef = relativeAttemptPath(stepIndex, step.id, attemptIndex, "correction-raw.log");
      const correctionErrorRef = relativeAttemptPath(stepIndex, step.id, attemptIndex, "correction-error.log");
      await emitArtifactWritten(events, correctionPromptRef, "correction_prompt", correctionPrompt, {
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId
      });

      await events.emit({
        type: "adapter_invocation_started",
        message: "Adapter correction invocation started",
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId,
        data: {
          adapter_type: adapter.type,
          command: adapter.command,
          correction: true,
          resumed_external_session: Boolean(result.externalSessionId)
        }
      });
      const correctionResult = await executeAdapterStep(adapter, correctionPrompt, {
        cwd: projectRoot,
        env,
        externalSessionId: result.externalSessionId,
        outputSchemaPath: handoffSchemaPath,
        outputSchemaJson: handoffSchemaJson
      });
      exceededBefore = new Set(run.budget.exceeded);
      recordAdapterCall(run, {
        prompt: correctionPrompt,
        stdout: correctionResult.stdout,
        stderr: correctionResult.stderr,
        isRetry: true
      });
      await emitNewBudgetEvents(events, run, exceededBefore);
      finalResult = {
        ...correctionResult,
        stdout: combineLogs(result.stdout, correctionResult.stdout),
        stderr: combineLogs(result.stderr, correctionResult.stderr),
        durationMs: result.durationMs + correctionResult.durationMs,
        externalSessionId: correctionResult.externalSessionId ?? result.externalSessionId
      };
      await writeAttemptFiles(projectRoot, run, stepIndex, step.id, attemptIndex, {
        "raw.log": finalResult.stdout,
        "error.log": finalResult.stderr,
        "correction-raw.log": correctionResult.stdout,
        "correction-error.log": correctionResult.stderr
      });
      await events.emit({
        type: "adapter_invocation_completed",
        message: "Adapter correction invocation completed",
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId,
        data: {
          correction: true,
          exit_code: correctionResult.exitCode ?? -1,
          duration_ms: correctionResult.durationMs,
          stdout_ref: correctionRawRef,
          stderr_ref: correctionErrorRef,
          stdout_bytes: Buffer.byteLength(correctionResult.stdout, "utf8"),
          stderr_bytes: Buffer.byteLength(correctionResult.stderr, "utf8"),
          external_session_id: correctionResult.externalSessionId ?? "",
          error: correctionResult.error ?? "",
          error_code: adapterErrorCode(correctionResult)
        }
      });
      await emitArtifactWritten(events, rawRef, "stdout", finalResult.stdout, {
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId
      });
      await emitArtifactWritten(events, errorRef, "stderr", finalResult.stderr, {
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId
      });
      await emitArtifactWritten(events, correctionRawRef, "correction_stdout", correctionResult.stdout, {
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId
      });
      await emitArtifactWritten(events, correctionErrorRef, "correction_stderr", correctionResult.stderr, {
        step_id: step.id,
        role_id: role.id,
        adapter_id: adapterId,
        attempt_id: attemptId
      });
      attempt.correction_count = 1;
      exceededBefore = new Set(run.budget.exceeded);
      if (attempt.correction_count > run.budget.max_retries_per_step) {
        markBudgetExceeded(run, "max_retries_per_step");
      }
      await emitNewBudgetEvents(events, run, exceededBefore);

      if (correctionResult.exitCode === 0 && finalResult.externalSessionId) {
        await events.emit({
          type: "validation_started",
          message: "Correction validation started",
          step_id: step.id,
          role_id: role.id,
          adapter_id: adapterId,
          attempt_id: attemptId,
          data: {
            phase: "correction",
            stdout_ref: correctionRawRef,
            validation_ref: validationRef
          }
        });
        const correctionValidation = await buildValidation({
          raw: correctionResult.stdout,
          run,
          step,
          role,
          markdownRef
        });
        validationRecord.correction = {
          valid: correctionValidation.valid,
          parse_errors: correctionValidation.parse_errors,
          schema_errors: correctionValidation.schema_errors,
          content_errors: correctionValidation.content_errors
        };
        validationRecord.correction_succeeded = correctionValidation.valid;
        await events.emit({
          type: "validation_completed",
          message: correctionValidation.valid ? "Correction validation completed" : "Correction validation failed",
          step_id: step.id,
          role_id: role.id,
          adapter_id: adapterId,
          attempt_id: attemptId,
          data: {
            phase: "correction",
            valid: correctionValidation.valid,
            parse_errors: correctionValidation.parse_errors,
            schema_errors: correctionValidation.schema_errors,
            content_errors: correctionValidation.content_errors,
            validation_ref: validationRef,
            error_code: validationErrorCode(correctionValidation)
          }
        });
        if (correctionValidation.valid && correctionValidation.handoff) {
          completedHandoff = correctionValidation.handoff;
          await writeHandoffFiles(projectRoot, run, stepIndex, step.id, attemptIndex, correctionValidation.handoff);
          await emitArtifactWritten(events, handoffRef, "handoff", JSON.stringify(correctionValidation.handoff, null, 2), {
            step_id: step.id,
            role_id: role.id,
            adapter_id: adapterId,
            attempt_id: attemptId
          });
          await emitArtifactWritten(events, markdownRef, "markdown", `${correctionValidation.handoff.markdown_body.trim()}\n`, {
            step_id: step.id,
            role_id: role.id,
            adapter_id: adapterId,
            attempt_id: attemptId
          });
        }
      } else {
        validationRecord.correction = {
          valid: false,
          parse_errors: [],
          schema_errors: [],
          content_errors: [correctionResult.error ?? "correction process failed"]
        };
      }
    }

    validationRecord.valid = Boolean(validationRecord.initial?.valid || validationRecord.correction?.valid);
    await writeValidationFiles(projectRoot, run, stepIndex, step.id, attemptIndex, validationRecord);
    await emitArtifactWritten(events, validationRef, "validation", JSON.stringify(validationRecord, null, 2), {
      step_id: step.id,
      role_id: role.id,
      adapter_id: adapterId,
      attempt_id: attemptId
    });
    status = validationRecord.valid ? "completed" : "failed";
  } else {
    validationRecord = {
      valid: false,
      correction_attempted: false,
      correction_succeeded: false,
      initial: {
        valid: false,
        parse_errors: [],
        schema_errors: [],
        content_errors: [result.error ?? "adapter process failed"]
      },
      correction: null
    };
    await writeValidationFiles(projectRoot, run, stepIndex, step.id, attemptIndex, validationRecord);
    await emitArtifactWritten(events, validationRef, "validation", JSON.stringify(validationRecord, null, 2), {
      step_id: step.id,
      role_id: role.id,
      adapter_id: adapterId,
      attempt_id: attemptId
    });
  }

  attempt.status = status;
  attempt.completed_at = isoNow();
  attempt.duration_ms = finalResult.durationMs;
  attempt.exit_code = finalResult.exitCode ?? -1;
  attempt.external_session_id = finalResult.externalSessionId ?? "";
  attempt.handoff_ref = status === "completed" ? handoffRef : "";
  attempt.markdown_ref = status === "completed" ? markdownRef : "";
  attempt.error = failureMessage(status, finalResult);
  attempt.error_code = attemptErrorCode(status, finalResult, validationRecord);
  stepTrace.status = status;

  if (finalResult.externalSessionId) {
    upsertRoleSession(run, {
      roleId: role.id,
      adapterId,
      externalSessionId: finalResult.externalSessionId,
      resumeStrategy: resumeStrategyFor(adapter.type)
    });
  }

  await events.emit({
    type: status === "completed" ? "step_completed" : "step_failed",
    message: status === "completed" ? "Step completed" : "Step failed",
    step_id: step.id,
    role_id: role.id,
    adapter_id: adapterId,
    attempt_id: attemptId,
    data: {
      status,
      handoff_ref: attempt.handoff_ref,
      markdown_ref: attempt.markdown_ref,
      validation_ref: attempt.validation_ref,
      error: attempt.error,
      error_code: attempt.error_code ?? ""
    }
  });

  return { status, completedHandoff, handoffRef };
}

async function executeWorkflowFrom({
  projectRoot,
  env,
  events,
  run,
  workflow,
  startIndex,
  isRunRetry
}: WorkflowExecutionContext): Promise<Run> {
  const handoffSchemaPath = schemaPath("handoff.v1");
  const handoffSchemaJson = (await schemaText("handoff.v1")).replace(/\s+/g, " ");

  run.status = "running";
  run.completed_at = "";
  await writeRun(projectRoot, run);
  await events.emit({
    type: "run_started",
    message: "Run started",
    data: {
      workflow_id: run.workflow_id,
      start_index: startIndex,
      retry: isRunRetry
    }
  });

  const repoSummary = await loadOrCollectRepoSummary(projectRoot, run);
  await events.emit({
    type: "repo_context_collected",
    message: "Repository context collected",
    data: {
      artifact_ref: "context/repo-summary.json",
      tree_entries: repoSummary.tree.length,
      tree_truncated: repoSummary.tree_truncated,
      config_files: repoSummary.config_files.length
    }
  });
  await emitArtifactWritten(events, "context/repo-summary.json", "repo_context", JSON.stringify(repoSummary, null, 2));
  let workflowSummary = await loadOrCreateWorkflowSummary(projectRoot, run, workflow);
  await emitArtifactWritten(events, "context/workflow-summary.json", "workflow_summary", JSON.stringify(workflowSummary, null, 2));
  let failed = false;
  let previousStep: RunStep | null = startIndex > 0 ? run.steps[startIndex - 1] : null;

  for (let index = startIndex; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    const stepTrace = run.steps[index];

    if (failed) {
      stepTrace.status = "skipped";
      await writeRun(projectRoot, run);
      await events.emit({
        type: "step_skipped",
        message: "Step skipped",
        step_id: step.id,
        role_id: step.role,
        data: {
          index: index + 1,
          reason: "previous step failed"
        }
      });
      continue;
    }

    const result = await executeStep({
      projectRoot,
      env,
      run,
      workflow,
      workflowSummary,
      repoSummary,
      handoffSchemaPath,
      handoffSchemaJson,
      step,
      stepIndex: index,
      previousStep,
      isRunRetry,
      events
    });

    if (result.status === "completed" && result.completedHandoff) {
      workflowSummary = await updateWorkflowSummary(projectRoot, {
        run,
        workflow,
        stepIndex: index,
        handoff: result.completedHandoff,
        handoffRef: result.handoffRef
      });
      await events.emit({
        type: "workflow_summary_updated",
        message: "Workflow summary updated",
        step_id: step.id,
        role_id: step.role,
        data: {
          revision: workflowSummary.revision,
          artifact_ref: "context/workflow-summary.json",
          handoff_ref: result.handoffRef
        }
      });
      await emitArtifactWritten(events, "context/workflow-summary.json", "workflow_summary", JSON.stringify(workflowSummary, null, 2), {
        step_id: step.id,
        role_id: step.role
      });
    }

    previousStep = stepTrace;
    if (result.status === "failed") {
      failed = true;
      run.status = "failed";
    }
    await writeRun(projectRoot, run);
  }

  run.completed_at = isoNow();
  run.duration_ms = Date.now() - Date.parse(run.started_at);
  if (!failed) {
    run.status = "completed";
  }
  const exceededBefore = new Set(run.budget.exceeded);
  if (run.duration_ms > run.budget.max_duration_minutes * 60_000) {
    markBudgetExceeded(run, "max_duration_minutes");
  }
  await emitNewBudgetEvents(events, run, exceededBefore);
  await writeRun(projectRoot, run);
  await writeFinalSummary(projectRoot, run);
  await emitArtifactWritten(events, "summary.md", "summary");
  await events.emit({
    type: run.status === "completed" ? "run_completed" : "run_failed",
    message: run.status === "completed" ? "Run completed" : "Run failed",
    data: {
      status: run.status,
      duration_ms: run.duration_ms,
      summary_ref: "summary.md"
    }
  });

  return run;
}

export async function runWorkflow({
  workflowId,
  taskInput,
  projectRoot = process.cwd(),
  env = process.env,
  eventObservers = [],
  eventSinks = [],
  writeEventsJsonl = false
}: RunWorkflowOptions): Promise<Run> {
  const [{ workflow }, { config }] = await Promise.all([
    loadWorkflowConfig(workflowId, projectRoot),
    loadProjectConfig(projectRoot)
  ]);
  validateLinearWorkflow(workflow);
  const run = createInitialRun({
    runId: createRunId(workflow.id),
    workflow,
    taskInput,
    budgets: config.budgets
  });

  await ensureRunDirectories(projectRoot, run);
  const events = await createRunEventEmitter({
    runId: run.run_id,
    projectRoot,
    observers: eventObservers,
    sinks: eventSinks,
    writeJsonl: writeEventsJsonl
  });
  const repoSummary = await collectRepoContext(projectRoot);
  await writeFile(join(projectRoot, ".forgekit/runs", run.run_id, "context/repo-summary.json"), `${JSON.stringify(repoSummary, null, 2)}\n`, "utf8");
  const workflowSummary = createWorkflowSummary(run, workflow);
  await writeWorkflowSummary(projectRoot, workflowSummary);
  await writeRun(projectRoot, run);
  await events.emit({
    type: "run_created",
    message: "Run created",
    data: {
      workflow_id: run.workflow_id,
      step_count: run.steps.length,
      task_input_chars: taskInput.length,
      run_ref: "run.json"
    }
  });

  return executeWorkflowFrom({
    projectRoot,
    env,
    events,
    run,
    workflow,
    startIndex: 0,
    isRunRetry: false
  });
}

export async function retryWorkflow({
  runId,
  projectRoot = process.cwd(),
  env = process.env,
  eventObservers = [],
  eventSinks = [],
  writeEventsJsonl = false
}: RetryWorkflowOptions): Promise<Run> {
  const run = await readRun(projectRoot, runId);
  if (run.status !== "failed") {
    throw new ForgeKitError({
      code: "run_not_retryable",
      message: `Only failed runs can be retried. Current status: ${run.status}`,
      category: "run",
      retryable: false,
      details: { run_id: runId, status: run.status }
    });
  }

  const { workflow } = await loadWorkflowConfig(run.workflow_id, projectRoot);
  validateLinearWorkflow(workflow);
  const failedIndex = run.steps.findIndex((step) => step.status === "failed");
  if (failedIndex === -1) {
    throw new ForgeKitError({
      code: "run_not_retryable",
      message: `Run ${runId} is failed but has no failed step.`,
      category: "run",
      retryable: false,
      details: { run_id: runId, status: run.status }
    });
  }

  for (let index = failedIndex; index < run.steps.length; index += 1) {
    if (run.steps[index].status === "skipped") {
      run.steps[index].status = "pending";
      run.steps[index].active_attempt = "";
    }
  }

  const events = await createRunEventEmitter({
    runId: run.run_id,
    projectRoot,
    observers: eventObservers,
    sinks: eventSinks,
    writeJsonl: writeEventsJsonl
  });

  return executeWorkflowFrom({
    projectRoot,
    env,
    events,
    run,
    workflow,
    startIndex: failedIndex,
    isRunRetry: true
  });
}
