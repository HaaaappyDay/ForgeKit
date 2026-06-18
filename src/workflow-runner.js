import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeAdapterStep, resumeStrategyFor } from "./adapters/execute.js";
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

function isoNow() {
  return new Date().toISOString();
}

function completedStatusFromExit(exitCode, externalSessionId) {
  if (exitCode !== 0) return "failed";
  if (!externalSessionId) return "failed";
  return "completed";
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
        exit_code: -1,
        external_session_id: existingSession ?? "",
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
      externalSessionId: existingSession
    });
    const status = completedStatusFromExit(result.exitCode, result.externalSessionId);
    const completedAt = isoNow();
    const attempt = stepTrace.attempts[0];

    await writeAttemptFiles(projectRoot, run, index, step.id, attemptIndex, {
      "raw.log": result.stdout,
      "error.log": result.stderr
    });

    attempt.status = status;
    attempt.completed_at = completedAt;
    attempt.duration_ms = result.durationMs;
    attempt.exit_code = result.exitCode ?? -1;
    attempt.external_session_id = result.externalSessionId ?? "";
    attempt.error = result.error ?? (status === "failed" && !result.externalSessionId ? "missing external session id" : "");
    stepTrace.status = status;

    if (result.externalSessionId) {
      upsertRoleSession(run, {
        roleId: role.id,
        adapterId,
        externalSessionId: result.externalSessionId,
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
