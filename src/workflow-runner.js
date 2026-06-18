import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeAdapterStep, resumeStrategyFor } from "./adapters/execute.js";
import { buildCorrectionPrompt } from "./correction-prompt.js";
import { parseHandoffFromRaw } from "./handoff-parser.js";
import { normalizeHandoffArtifacts, validateHandoffContent } from "./handoff-validator.js";
import { buildStepPrompt } from "./prompt-builder.js";
import { loadAdapterConfig, loadRoleConfig, loadWorkflowConfig } from "./project-config.js";
import {
  attemptRoot,
  createInitialRun,
  createRunId,
  ensureRunDirectories,
  relativeAttemptPath,
  upsertRoleSession,
  writeRun
} from "./run-store.js";
import { schemaPath, schemaText } from "./schema-registry.js";

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

export async function runWorkflow({ workflowId, taskInput, projectRoot = process.cwd(), env = process.env }) {
  const { workflow } = await loadWorkflowConfig(workflowId, projectRoot);
  const handoffSchemaPath = schemaPath("handoff.v1");
  const handoffSchemaJson = (await schemaText("handoff.v1")).replace(/\s+/g, " ");
  const run = createInitialRun({
    runId: createRunId(workflow.id),
    workflow,
    taskInput
  });
  const startedAtMs = Date.now();

  await ensureRunDirectories(projectRoot, run);
  run.status = "running";
  await writeRun(projectRoot, run);

  let previousStep = null;
  let failed = false;

  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    const stepTrace = run.steps[index];

    if (failed) {
      stepTrace.status = "skipped";
      await writeRun(projectRoot, run);
      continue;
    }

    const { role, adapterId } = await loadRoleConfig(step.role, projectRoot);
    const { adapter } = await loadAdapterConfig(adapterId, projectRoot);
    const existingSession = run.role_sessions[role.id]?.external_session_id ?? null;
    const attemptIndex = 0;
    const startedAt = isoNow();
    const prompt = buildStepPrompt({ run, workflow, step, role, previousStep });
    const promptRef = relativeAttemptPath(index, step.id, attemptIndex, "prompt.md");
    const rawRef = relativeAttemptPath(index, step.id, attemptIndex, "raw.log");
    const errorRef = relativeAttemptPath(index, step.id, attemptIndex, "error.log");
    const handoffRef = relativeAttemptPath(index, step.id, attemptIndex, "handoff.json");
    const markdownRef = relativeAttemptPath(index, step.id, attemptIndex, "output.md");
    const validationRef = relativeAttemptPath(index, step.id, attemptIndex, "validation.json");

    stepTrace.adapter_id = adapterId;
    stepTrace.status = "running";
    stepTrace.active_attempt = "attempt-01";
    stepTrace.attempts = [
      {
        attempt_id: "attempt-01",
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
      }
    ];
    await writeAttemptFiles(projectRoot, run, index, step.id, attemptIndex, {
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
    const attempt = stepTrace.attempts[0];

    await writeAttemptFiles(projectRoot, run, index, step.id, attemptIndex, {
      "raw.log": result.stdout,
      "error.log": result.stderr
    });

    let status = completedStatusFromExit(result.exitCode, result.externalSessionId);
    let finalResult = result;
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
        await writeHandoffFiles(projectRoot, run, index, step.id, attemptIndex, initialValidation.handoff);
      } else {
        stepTrace.status = "self_correcting";
        attempt.status = "self_correcting";
        validationRecord.correction_attempted = true;
        await writeValidationFiles(projectRoot, run, index, step.id, attemptIndex, validationRecord);
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
        await writeAttemptFiles(projectRoot, run, index, step.id, attemptIndex, {
          "correction-prompt.md": correctionPrompt
        });

        const correctionResult = await executeAdapterStep(adapter, correctionPrompt, {
          cwd: projectRoot,
          env,
          externalSessionId: result.externalSessionId,
          outputSchemaPath: handoffSchemaPath,
          outputSchemaJson: handoffSchemaJson
        });
        finalResult = {
          ...correctionResult,
          stdout: combineLogs(result.stdout, correctionResult.stdout),
          stderr: combineLogs(result.stderr, correctionResult.stderr),
          durationMs: result.durationMs + correctionResult.durationMs,
          externalSessionId: correctionResult.externalSessionId ?? result.externalSessionId
        };
        await writeAttemptFiles(projectRoot, run, index, step.id, attemptIndex, {
          "raw.log": finalResult.stdout,
          "error.log": finalResult.stderr,
          "correction-raw.log": correctionResult.stdout,
          "correction-error.log": correctionResult.stderr
        });
        attempt.correction_count = 1;

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
            await writeHandoffFiles(projectRoot, run, index, step.id, attemptIndex, correctionValidation.handoff);
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
      await writeValidationFiles(projectRoot, run, index, step.id, attemptIndex, validationRecord);
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
      await writeValidationFiles(projectRoot, run, index, step.id, attemptIndex, validationRecord);
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

    previousStep = stepTrace;
    if (status === "failed") {
      failed = true;
      run.status = "failed";
    }
    await writeRun(projectRoot, run);
  }

  run.completed_at = isoNow();
  run.duration_ms = Date.now() - startedAtMs;
  if (!failed) {
    run.status = "completed";
  }
  await writeRun(projectRoot, run);

  return run;
}
