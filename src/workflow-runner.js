import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeAdapterStep, resumeStrategyFor } from "./adapters/execute.js";
import { buildCorrectionPrompt } from "./correction-prompt.js";
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
import { schemaPath, schemaText } from "./schema-registry.js";
import {
  createWorkflowSummary,
  readWorkflowSummary,
  updateWorkflowSummary,
  writeWorkflowSummary
} from "./workflow-summary.js";

function isoNow() {
  return new Date().toISOString();
}

function completedStatusFromExit(exitCode, externalSessionId) {
  if (exitCode !== 0) return "failed";
  if (!externalSessionId) return "failed";
  return "completed";
}

function combineLogs(initial, correction) {
  if (!correction) return initial;
  return `=== initial ===\n${initial}\n\n=== correction ===\n${correction}`;
}

function failureMessage(status, result) {
  if (status !== "failed") return "";
  if (result.error) return result.error;
  if (!result.externalSessionId) return "missing external session id";
  return "handoff validation failed";
}

async function buildValidation({ raw, run, step, role, markdownRef }) {
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
    handoff: normalized,
    parse_errors: [],
    schema_errors: validation.schema_errors,
    content_errors: validation.content_errors
  };
}

async function writeValidationFiles(projectRoot, run, stepIndex, stepId, attemptIndex, validationRecord) {
  const root = attemptRoot(projectRoot, run.run_id, stepIndex, stepId, attemptIndex);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "validation.json"), `${JSON.stringify(validationRecord, null, 2)}\n`, "utf8");
}

async function writeHandoffFiles(projectRoot, run, stepIndex, stepId, attemptIndex, handoff) {
  const root = attemptRoot(projectRoot, run.run_id, stepIndex, stepId, attemptIndex);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  await writeFile(join(root, "output.md"), `${handoff.markdown_body.trim()}\n`, "utf8");
}

async function writeAttemptFiles(projectRoot, run, stepIndex, stepId, attemptIndex, files) {
  const root = attemptRoot(projectRoot, run.run_id, stepIndex, stepId, attemptIndex);
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(root, file), content, "utf8");
  }
}

async function loadOrCollectRepoSummary(projectRoot, run) {
  const path = join(projectRoot, ".forgekit/runs", run.run_id, "context/repo-summary.json");
  try {
    return await readJsonFile(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const repoSummary = await collectRepoContext(projectRoot);
    await writeFile(path, `${JSON.stringify(repoSummary, null, 2)}\n`, "utf8");
    return repoSummary;
  }
}

async function loadOrCreateWorkflowSummary(projectRoot, run, workflow) {
  try {
    return await readWorkflowSummary(projectRoot, run.run_id);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const workflowSummary = createWorkflowSummary(run, workflow);
    await writeWorkflowSummary(projectRoot, workflowSummary);
    return workflowSummary;
  }
}

async function executeStep({
  projectRoot,
  env,
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
}) {
  const stepTrace = run.steps[stepIndex];
  const { role, adapterId } = await loadRoleConfig(step.role, projectRoot);
  const { adapter } = await loadAdapterConfig(adapterId, projectRoot);
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

  if (attemptIndex > run.budget.max_retries_per_step) {
    markBudgetExceeded(run, "max_retries_per_step");
  }

  const attempt = {
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
  await writeRun(projectRoot, run);

  const result = await executeAdapterStep(adapter, prompt, {
    cwd: projectRoot,
    env,
    externalSessionId: existingSession,
    outputSchemaPath: handoffSchemaPath,
    outputSchemaJson: handoffSchemaJson
  });
  recordAdapterCall(run, {
    prompt,
    stdout: result.stdout,
    stderr: result.stderr,
    isRetry: isRunRetry || attemptIndex > 0
  });

  await writeAttemptFiles(projectRoot, run, stepIndex, step.id, attemptIndex, {
    "raw.log": result.stdout,
    "error.log": result.stderr
  });

  let status = completedStatusFromExit(result.exitCode, result.externalSessionId);
  let finalResult = result;
  let completedHandoff = null;
  let validationRecord = {
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

    if (initialValidation.valid) {
      completedHandoff = initialValidation.handoff;
      await writeHandoffFiles(projectRoot, run, stepIndex, step.id, attemptIndex, initialValidation.handoff);
    } else {
      stepTrace.status = "self_correcting";
      attempt.status = "self_correcting";
      validationRecord.correction_attempted = true;
      await writeValidationFiles(projectRoot, run, stepIndex, step.id, attemptIndex, validationRecord);
      await writeRun(projectRoot, run);

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

      const correctionResult = await executeAdapterStep(adapter, correctionPrompt, {
        cwd: projectRoot,
        env,
        externalSessionId: result.externalSessionId,
        outputSchemaPath: handoffSchemaPath,
        outputSchemaJson: handoffSchemaJson
      });
      recordAdapterCall(run, {
        prompt: correctionPrompt,
        stdout: correctionResult.stdout,
        stderr: correctionResult.stderr,
        isRetry: true
      });
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
      attempt.correction_count = 1;
      if (attempt.correction_count > run.budget.max_retries_per_step) {
        markBudgetExceeded(run, "max_retries_per_step");
      }

      if (correctionResult.exitCode === 0 && finalResult.externalSessionId) {
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
        if (correctionValidation.valid) {
          completedHandoff = correctionValidation.handoff;
          await writeHandoffFiles(projectRoot, run, stepIndex, step.id, attemptIndex, correctionValidation.handoff);
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
  }

  attempt.status = status;
  attempt.completed_at = isoNow();
  attempt.duration_ms = finalResult.durationMs;
  attempt.exit_code = finalResult.exitCode ?? -1;
  attempt.external_session_id = finalResult.externalSessionId ?? "";
  attempt.handoff_ref = status === "completed" ? handoffRef : "";
  attempt.markdown_ref = status === "completed" ? markdownRef : "";
  attempt.error = failureMessage(status, finalResult);
  stepTrace.status = status;

  if (finalResult.externalSessionId) {
    upsertRoleSession(run, {
      roleId: role.id,
      adapterId,
      externalSessionId: finalResult.externalSessionId,
      resumeStrategy: resumeStrategyFor(adapter.type)
    });
  }

  return { status, completedHandoff, handoffRef };
}

async function executeWorkflowFrom({
  projectRoot,
  env,
  run,
  workflow,
  startIndex,
  isRunRetry
}) {
  const handoffSchemaPath = schemaPath("handoff.v1");
  const handoffSchemaJson = (await schemaText("handoff.v1")).replace(/\s+/g, " ");
  const repoSummary = await loadOrCollectRepoSummary(projectRoot, run);
  let workflowSummary = await loadOrCreateWorkflowSummary(projectRoot, run, workflow);
  let failed = false;
  let previousStep = startIndex > 0 ? run.steps[startIndex - 1] : null;

  run.status = "running";
  run.completed_at = "";
  await writeRun(projectRoot, run);

  for (let index = startIndex; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    const stepTrace = run.steps[index];

    if (failed) {
      stepTrace.status = "skipped";
      await writeRun(projectRoot, run);
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
      isRunRetry
    });

    if (result.status === "completed" && result.completedHandoff) {
      workflowSummary = await updateWorkflowSummary(projectRoot, {
        run,
        workflow,
        stepIndex: index,
        handoff: result.completedHandoff,
        handoffRef: result.handoffRef
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
  if (run.duration_ms > run.budget.max_duration_minutes * 60_000) {
    markBudgetExceeded(run, "max_duration_minutes");
  }
  await writeRun(projectRoot, run);
  await writeFinalSummary(projectRoot, run);

  return run;
}

export async function runWorkflow({ workflowId, taskInput, projectRoot = process.cwd(), env = process.env }) {
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
  const repoSummary = await collectRepoContext(projectRoot);
  await writeFile(join(projectRoot, ".forgekit/runs", run.run_id, "context/repo-summary.json"), `${JSON.stringify(repoSummary, null, 2)}\n`, "utf8");
  const workflowSummary = createWorkflowSummary(run, workflow);
  await writeWorkflowSummary(projectRoot, workflowSummary);
  await writeRun(projectRoot, run);

  return executeWorkflowFrom({
    projectRoot,
    env,
    run,
    workflow,
    startIndex: 0,
    isRunRetry: false
  });
}

export async function retryWorkflow({ runId, projectRoot = process.cwd(), env = process.env }) {
  const run = await readRun(projectRoot, runId);
  if (run.status !== "failed") {
    throw new Error(`Only failed runs can be retried. Current status: ${run.status}`);
  }

  const { workflow } = await loadWorkflowConfig(run.workflow_id, projectRoot);
  validateLinearWorkflow(workflow);
  const failedIndex = run.steps.findIndex((step) => step.status === "failed");
  if (failedIndex === -1) {
    throw new Error(`Run ${runId} is failed but has no failed step.`);
  }

  for (let index = failedIndex; index < run.steps.length; index += 1) {
    if (run.steps[index].status === "skipped") {
      run.steps[index].status = "pending";
      run.steps[index].active_attempt = "";
    }
  }

  return executeWorkflowFrom({
    projectRoot,
    env,
    run,
    workflow,
    startIndex: failedIndex,
    isRunRetry: true
  });
}
