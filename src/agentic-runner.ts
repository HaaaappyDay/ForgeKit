import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeAdapterStep, resumeStrategyFor } from "./adapters/execute.js";
import { parseAcceptanceVerdict, validateAcceptanceVerdict } from "./acceptance-gate.js";
import { buildAcceptanceGatePrompt } from "./acceptance-gate.js";
import { agenticHandoffOutputContract } from "./handoff-contract.js";
import { parseHandoffV2FromRaw } from "./handoff-parser.js";
import { normalizeHandoffArtifacts, validateHandoffV2Content } from "./handoff-validator.js";
import { readJsonFile } from "./json-file.js";
import { isNodeErrorCode } from "./node-error.js";
import { buildAgenticWorkPrompt, type ReworkContext } from "./prompt-builder.js";
import { ForgeKitError } from "./errors.js";
import { loadAdapterConfig, loadAnyWorkflowConfig, loadProjectConfig, loadRoleConfig } from "./project-config.js";
import { collectRepoContext } from "./repo-context.js";
import { resolveAgenticBudgets, validateAgenticWorkflow } from "./run-plan.js";
import { buildCandidateDirectory } from "./role-directory.js";
import {
  agenticAttemptRoot,
  appendNode,
  createInitialAgenticRun,
  createRunId,
  ensureAgenticRunDirectories,
  markAgenticBudgetExceeded,
  readAgenticRun,
  recordAgenticAdapterCall,
  relativeAgenticAttemptPath,
  roleVisits,
  runRoot,
  setActiveCursor,
  upsertRoleSession,
  writeAgenticRun
} from "./run-store.js";
import {
  createRunEventEmitter,
  type RunEventEmitter,
  type RunEventObserver,
  type RunEventSink
} from "./run-events.js";
import { schemaPath, schemaText } from "./schema-registry.js";
import type {
  AdapterConfig,
  AgenticRun,
  AgenticWorkflowConfig,
  AttemptPhase,
  BudgetExceededKey,
  CandidateSource,
  HandoffV2,
  JsonObject,
  RepoSummary,
  RoleConfig,
  RunNode,
  RunNodeAttempt
} from "./types.js";

interface RunAgenticWorkflowOptions {
  workflow: AgenticWorkflowConfig;
  taskInput: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  eventObservers?: RunEventObserver[];
  eventSinks?: RunEventSink[];
  writeEventsJsonl?: boolean;
}

interface PhaseValidation {
  valid: boolean;
  parse_errors: string[];
  schema_errors: string[];
  content_errors: string[];
  error_code: string;
}

interface VerificationValue {
  verdict: "accept" | "reject";
  unmet: string[];
  raw: Record<string, unknown>;
}

interface PhaseCallResult<T> {
  ok: boolean;
  value: T | null;
  attempt: RunNodeAttempt;
  attemptIndex: number;
  externalSessionId: string | null;
  errorCode: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

function emptyValidation(): PhaseValidation {
  return { valid: false, parse_errors: [], schema_errors: [], content_errors: [], error_code: "" };
}

function adapterErrorCode(result: { error?: string | null; exitCode: number | null; timedOut: boolean }): string {
  if (!result.error && result.exitCode === 0) return "";
  if (result.error?.startsWith("Command not found or not executable")) return "adapter_command_not_found";
  if (result.timedOut) return "adapter_timeout";
  return "adapter_process_failed";
}

function validationErrorsToList(validation: PhaseValidation): string[] {
  return [
    ...validation.parse_errors.map((error) => `parse: ${error}`),
    ...validation.schema_errors.map((error) => `schema: ${error}`),
    ...validation.content_errors.map((error) => `content: ${error}`)
  ];
}

function buildCorrectionPrompt(errors: string[], rawOutput: string, contract: string): string {
  const excerpt = rawOutput.length <= 4000 ? rawOutput : `${rawOutput.slice(0, 4000)}\n\n[truncated]`;
  return `Your previous ForgeKit output failed validation.

Return exactly one corrected JSON object. Do not include prose outside the JSON object.

Validation errors:
${errors.map((error) => `- ${error}`).join("\n")}

${contract}

Original output excerpt:
${excerpt}
`;
}

function combineLogs(initial: string, correction: string): string {
  if (!correction) return initial;
  return `=== initial ===\n${initial}\n\n=== correction ===\n${correction}`;
}

async function writePhaseFile(
  projectRoot: string,
  run: AgenticRun,
  node: RunNode,
  phase: AttemptPhase,
  attemptIndex: number,
  file: string,
  content: string
): Promise<void> {
  const root = agenticAttemptRoot(projectRoot, run.run_id, node.node_seq, node.role_id, phase, attemptIndex);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, file), content, "utf8");
}

function artifactEventData(ref: string, type: string, content?: string): JsonObject {
  return {
    ref,
    type,
    exists: true,
    ...(content === undefined ? {} : { bytes: Buffer.byteLength(content, "utf8") })
  };
}

/**
 * Runs a single adapter call for a node phase (verification or work), including one
 * in-session self-correction attempt, artifact writing, budget accounting, session
 * reuse, and event emission. Validation is supplied by the caller so the same
 * machinery serves both the acceptance gate and the work call (spec §4, §7.2).
 */
async function runPhaseCall<T>({
  projectRoot,
  env,
  events,
  run,
  node,
  role,
  adapter,
  phase,
  prompt,
  contract,
  isRetry,
  outputSchemaPath,
  outputSchemaJson,
  validate
}: {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  events: RunEventEmitter;
  run: AgenticRun;
  node: RunNode;
  role: RoleConfig;
  adapter: AdapterConfig;
  phase: AttemptPhase;
  prompt: string;
  contract: string;
  isRetry: boolean;
  outputSchemaPath?: string;
  outputSchemaJson?: string;
  validate: (raw: string) => Promise<{ validation: PhaseValidation; value: T | null }>;
}): Promise<PhaseCallResult<T>> {
  const attemptIndex = node.attempts.filter((entry) => entry.phase === phase).length;
  const attemptId = `attempt-${String(attemptIndex + 1).padStart(2, "0")}`;
  const existingSession = run.role_sessions[role.id]?.external_session_id ?? null;

  const promptRef = relativeAgenticAttemptPath(node.node_seq, role.id, phase, attemptIndex, "prompt.md");
  const rawRef = relativeAgenticAttemptPath(node.node_seq, role.id, phase, attemptIndex, "raw.log");
  const errorRef = relativeAgenticAttemptPath(node.node_seq, role.id, phase, attemptIndex, "error.log");
  const validationRef = relativeAgenticAttemptPath(node.node_seq, role.id, phase, attemptIndex, "validation.json");

  const attempt: RunNodeAttempt = {
    phase,
    attempt_id: attemptId,
    status: "running",
    started_at: isoNow(),
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
  node.attempts.push(attempt);
  await writePhaseFile(projectRoot, run, node, phase, attemptIndex, "prompt.md", prompt);

  await events.emit({
    type: "adapter_invocation_started",
    message: "Adapter invocation started",
    node_id: node.node_id,
    role_id: role.id,
    adapter_id: adapter.id,
    attempt_id: attemptId,
    data: { phase, resumed_external_session: Boolean(existingSession) }
  });

  const result = await executeAdapterStep(adapter, prompt, {
    cwd: projectRoot,
    env,
    externalSessionId: existingSession,
    outputSchemaPath,
    outputSchemaJson
  });
  recordAgenticAdapterCall(run, { prompt, stdout: result.stdout, stderr: result.stderr, isRetry });
  await writePhaseFile(projectRoot, run, node, phase, attemptIndex, "raw.log", result.stdout);
  await writePhaseFile(projectRoot, run, node, phase, attemptIndex, "error.log", result.stderr);

  await events.emit({
    type: "adapter_invocation_completed",
    message: "Adapter invocation completed",
    node_id: node.node_id,
    role_id: role.id,
    adapter_id: adapter.id,
    attempt_id: attemptId,
    data: {
      phase,
      exit_code: result.exitCode ?? -1,
      duration_ms: result.durationMs,
      external_session_id: result.externalSessionId ?? "",
      error: result.error ?? "",
      error_code: adapterErrorCode(result)
    }
  });

  const validationRecord: { initial: PhaseValidation | null; correction: PhaseValidation | null; valid: boolean } = {
    initial: null,
    correction: null,
    valid: false
  };

  if (result.exitCode !== 0 || !result.externalSessionId) {
    attempt.status = "failed";
    attempt.completed_at = isoNow();
    attempt.duration_ms = result.durationMs;
    attempt.exit_code = result.exitCode ?? -1;
    attempt.external_session_id = result.externalSessionId ?? "";
    attempt.error = result.error || (result.externalSessionId ? "adapter process failed" : "missing external session id");
    attempt.error_code = adapterErrorCode(result) || "adapter_process_failed";
    validationRecord.initial = {
      ...emptyValidation(),
      content_errors: [attempt.error],
      error_code: attempt.error_code
    };
    await writePhaseFile(
      projectRoot,
      run,
      node,
      phase,
      attemptIndex,
      "validation.json",
      `${JSON.stringify(validationRecord, null, 2)}\n`
    );
    return { ok: false, value: null, attempt, attemptIndex, externalSessionId: result.externalSessionId ?? null, errorCode: attempt.error_code };
  }

  const initial = await validate(result.stdout);
  validationRecord.initial = initial.validation;
  await events.emit({
    type: "validation_completed",
    message: initial.validation.valid ? "Validation completed" : "Validation failed",
    node_id: node.node_id,
    role_id: role.id,
    adapter_id: adapter.id,
    attempt_id: attemptId,
    data: { phase: "initial", valid: initial.validation.valid, error_code: initial.validation.error_code }
  });

  let value = initial.value;
  let externalSessionId = result.externalSessionId;
  let combinedStdout = result.stdout;
  let durationMs = result.durationMs;
  let finalValidation = initial.validation;

  if (!initial.validation.valid) {
    attempt.status = "self_correcting";
    attempt.correction_count = 1;
    const correctionPrompt = buildCorrectionPrompt(validationErrorsToList(initial.validation), result.stdout, contract);
    await writePhaseFile(projectRoot, run, node, phase, attemptIndex, "correction-prompt.md", correctionPrompt);

    await events.emit({
      type: "adapter_invocation_started",
      message: "Adapter correction invocation started",
      node_id: node.node_id,
      role_id: role.id,
      adapter_id: adapter.id,
      attempt_id: attemptId,
      data: { phase, correction: true }
    });
    const correction = await executeAdapterStep(adapter, correctionPrompt, {
      cwd: projectRoot,
      env,
      externalSessionId: result.externalSessionId,
      outputSchemaPath,
      outputSchemaJson
    });
    recordAgenticAdapterCall(run, { prompt: correctionPrompt, stdout: correction.stdout, stderr: correction.stderr, isRetry: true });
    combinedStdout = combineLogs(result.stdout, correction.stdout);
    durationMs = result.durationMs + correction.durationMs;
    externalSessionId = correction.externalSessionId ?? result.externalSessionId;
    await writePhaseFile(projectRoot, run, node, phase, attemptIndex, "raw.log", combinedStdout);
    await writePhaseFile(projectRoot, run, node, phase, attemptIndex, "correction-raw.log", correction.stdout);
    await writePhaseFile(projectRoot, run, node, phase, attemptIndex, "correction-error.log", correction.stderr);

    await events.emit({
      type: "adapter_invocation_completed",
      message: "Adapter correction invocation completed",
      node_id: node.node_id,
      role_id: role.id,
      adapter_id: adapter.id,
      attempt_id: attemptId,
      data: { phase, correction: true, exit_code: correction.exitCode ?? -1, error_code: adapterErrorCode(correction) }
    });

    if (correction.exitCode === 0 && correction.externalSessionId) {
      const corrected = await validate(correction.stdout);
      validationRecord.correction = corrected.validation;
      finalValidation = corrected.validation;
      value = corrected.value;
      await events.emit({
        type: "validation_completed",
        message: corrected.validation.valid ? "Correction validation completed" : "Correction validation failed",
        node_id: node.node_id,
        role_id: role.id,
        adapter_id: adapter.id,
        attempt_id: attemptId,
        data: { phase: "correction", valid: corrected.validation.valid, error_code: corrected.validation.error_code }
      });
    } else {
      finalValidation = {
        ...emptyValidation(),
        content_errors: [correction.error ?? "correction process failed"],
        error_code: adapterErrorCode(correction) || "adapter_process_failed"
      };
      validationRecord.correction = finalValidation;
    }
  }

  validationRecord.valid = Boolean(validationRecord.initial?.valid || validationRecord.correction?.valid);
  await writePhaseFile(
    projectRoot,
    run,
    node,
    phase,
    attemptIndex,
    "validation.json",
    `${JSON.stringify(validationRecord, null, 2)}\n`
  );

  const ok = Boolean(value) && finalValidation.valid;
  attempt.status = ok ? "completed" : "failed";
  attempt.completed_at = isoNow();
  attempt.duration_ms = durationMs;
  attempt.exit_code = 0;
  attempt.external_session_id = externalSessionId ?? "";
  attempt.error = ok ? "" : finalValidation.error_code || "validation failed";
  attempt.error_code = ok ? "" : finalValidation.error_code || "handoff_content_invalid";

  if (externalSessionId) {
    upsertRoleSession(run, {
      roleId: role.id,
      adapterId: adapter.id,
      externalSessionId,
      resumeStrategy: resumeStrategyFor(adapter.type)
    });
  }

  void combinedStdout;
  return { ok, value, attempt, attemptIndex, externalSessionId: externalSessionId ?? null, errorCode: ok ? "" : attempt.error_code ?? "" };
}

function candidateSourceWhenByRole(role: RoleConfig): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of role.must_handoff_to) {
    if (entry.role && entry.when) {
      map[entry.role] = entry.when;
    }
  }
  return map;
}

async function writeAgenticSummary(projectRoot: string, run: AgenticRun): Promise<void> {
  const nodeLines = run.nodes
    .map((node) => {
      const detail = node.chosen_next_role ? ` -> ${node.chosen_next_role}` : "";
      return `- ${node.node_seq}. ${node.node_id} (${node.role_id}) - ${node.status}${detail}`;
    })
    .join("\n");

  const markdown = `# ForgeKit Agentic Run Summary

## Run

- Run ID: ${run.run_id}
- Workflow: ${run.workflow_id}
- Mode: agentic
- Status: ${run.status}
- Duration: ${run.duration_ms} ms
- Steps: ${run.budget.steps}

## Task

${run.task.input}

## Path

${nodeLines || "- (no nodes executed)"}

${run.escalation ? `## Escalation\n\n- Reason: ${run.escalation.reason}\n- At node: ${run.escalation.at_node_id}\n` : ""}`;

  await writeFile(join(runRoot(projectRoot, run.run_id), "summary.md"), markdown, "utf8");
}

interface RoutingState {
  roleId: string;
  entryReason: RunNode["entry_reason"];
  enteredFrom: string | null;
  instructions: string;
  incomingHandoffRef: string;
  incomingCriteria: string[];
  incomingMarkdown: string;
  rework?: ReworkContext;
}

async function executeAgenticRun({
  projectRoot,
  env,
  events,
  run,
  workflow,
  candidatesByRole,
  initialState,
  resumeNode = null,
  initialSender = null
}: {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  events: RunEventEmitter;
  run: AgenticRun;
  workflow: AgenticWorkflowConfig;
  candidatesByRole: Record<string, { candidates: string[]; source: CandidateSource }>;
  initialState?: RoutingState;
  resumeNode?: RunNode | null;
  initialSender?: RunNode | null;
}): Promise<AgenticRun> {
  const handoffSchemaPath = schemaPath("handoff.v2");
  const handoffSchemaJson = (await schemaText("handoff.v2")).replace(/\s+/g, " ");
  const verdictSchemaPath = schemaPath("acceptance-verdict.v1");
  const verdictSchemaJson = (await schemaText("acceptance-verdict.v1")).replace(/\s+/g, " ");

  run.status = "running";
  await writeAgenticRun(projectRoot, run);
  await events.emit({
    type: "run_started",
    message: "Run started",
    data: { workflow_id: run.workflow_id, mode: "agentic", entrypoint: workflow.entrypoint }
  });

  const repoSummary = await loadOrCollectRepoSummary(projectRoot, run);
  const workflowSummary = { schema_version: "workflow-summary.v1", run_id: run.run_id, task_summary: run.task.input } as unknown;

  const terminalRoles = new Set(workflow.terminal_roles);
  let state: RoutingState = initialState ?? {
    roleId: workflow.entrypoint,
    entryReason: "entrypoint",
    enteredFrom: null,
    instructions: "",
    incomingHandoffRef: "",
    incomingCriteria: [],
    incomingMarkdown: ""
  };
  let lastSenderNode: RunNode | null = initialSender;
  let pendingResumeNode: RunNode | null = resumeNode;

  const escalate = async (reason: BudgetExceededKey, atNodeId: string): Promise<void> => {
    markAgenticBudgetExceeded(run, reason);
    run.status = "escalated";
    const lastNode = run.nodes[run.nodes.length - 1];
    const latest = lastNode
      ? [lastNode.handoff_ref, lastNode.acceptance?.verdict_ref ?? ""].filter((ref) => ref.length > 0)
      : [];
    run.escalation = { reason, at_node_id: atNodeId, latest_artifacts: latest };
    setActiveCursor(run, null);
    await events.emit({
      type: "run_escalated",
      message: `Run escalated: ${reason}`,
      data: { reason, at_node_id: atNodeId }
    });
  };

  // Main agentic loop.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // On a retry, the first iteration re-runs the previously failed node in place
    // (preserving its old attempts); guardrails and node creation are skipped because
    // it was already counted against the budget (spec §8).
    const resuming = pendingResumeNode !== null;
    if (!resuming) {
      // Hard guardrails are checked before entering any new node (spec §6.2).
      const lastNodeId = run.nodes[run.nodes.length - 1]?.node_id ?? "";
      if (run.budget.steps + 1 > run.budget.max_steps) {
        await escalate("max_steps", lastNodeId);
        break;
      }
      if (roleVisits(run, state.roleId) + 1 > run.budget.max_role_visits) {
        await escalate("max_role_visits", lastNodeId);
        break;
      }
    }

    const { role, adapterId } = await loadRoleConfig(state.roleId, projectRoot);
    const { adapter } = await loadAdapterConfig(adapterId, projectRoot);
    const objective = workflow.roles[state.roleId]?.objective ?? "";
    let node: RunNode;
    if (pendingResumeNode) {
      node = pendingResumeNode;
      pendingResumeNode = null;
      node.adapter_id = adapterId;
      node.status = "pending";
      node.handoff_ref = "";
      node.chosen_next_role = null;
      node.acceptance = null;
    } else {
      node = appendNode(run, {
        roleId: state.roleId,
        adapterId,
        entryReason: state.entryReason,
        enteredFrom: state.enteredFrom,
        objective,
        edgeReason: state.entryReason === "rework" ? state.rework?.unmet : undefined
      });
    }
    setActiveCursor(run, { role_id: role.id, node_id: node.node_id, phase: "idle" });
    await events.emit({
      type: "node_entered",
      message: "Node entered",
      node_id: node.node_id,
      role_id: role.id,
      adapter_id: adapterId,
      data: { node_seq: node.node_seq, entry_reason: node.entry_reason, entered_from: node.entered_from ?? "" }
    });
    await writeAgenticRun(projectRoot, run);

    // --- Acceptance gate (spec §7.2): only on inbound handoffs with criteria. ---
    if (state.entryReason === "handoff" && state.incomingHandoffRef && state.incomingCriteria.length > 0) {
      node.status = "verifying";
      setActiveCursor(run, { role_id: role.id, node_id: node.node_id, phase: "verification" });
      await events.emit({
        type: "acceptance_verification_started",
        message: "Acceptance verification started",
        node_id: node.node_id,
        role_id: role.id,
        data: { incoming_handoff_ref: state.incomingHandoffRef, criteria_count: state.incomingCriteria.length }
      });

      const gatePrompt = buildAcceptanceGatePrompt({
        runId: run.run_id,
        nodeId: node.node_id,
        role,
        incomingHandoffRef: state.incomingHandoffRef,
        incomingMarkdown: state.incomingMarkdown,
        acceptanceCriteria: state.incomingCriteria
      });
      const verdictContract = `Output exactly one acceptance-verdict.v1 JSON object for node ${node.node_id}.`;
      const phaseResult = await runPhaseCall<VerificationValue>({
        projectRoot,
        env,
        events,
        run,
        node,
        role,
        adapter,
        phase: "verification",
        prompt: gatePrompt,
        contract: verdictContract,
        isRetry: false,
        outputSchemaPath: verdictSchemaPath,
        outputSchemaJson: verdictSchemaJson,
        validate: async (raw) => {
          const parsed = parseAcceptanceVerdict(raw);
          if (!parsed.verdict) {
            return {
              validation: { ...emptyValidation(), parse_errors: parsed.errors, error_code: "acceptance_verdict_invalid" },
              value: null
            };
          }
          const verification = await validateAcceptanceVerdict(parsed.verdict, {
            runId: run.run_id,
            nodeId: node.node_id,
            roleId: role.id,
            incomingHandoffRef: state.incomingHandoffRef,
            criteria: state.incomingCriteria
          });
          const validation: PhaseValidation = {
            valid: verification.valid,
            parse_errors: [],
            schema_errors: verification.schema_errors,
            content_errors: verification.content_errors,
            error_code: verification.valid ? "" : "acceptance_verdict_invalid"
          };
          return {
            validation,
            value: verification.valid && verification.verdict
              ? { verdict: verification.verdict, unmet: verification.unmet, raw: parsed.verdict as Record<string, unknown> }
              : null
          };
        }
      });

      const verdictRef = relativeAgenticAttemptPath(node.node_seq, role.id, "verification", phaseResult.attemptIndex, "verdict.json");
      if (!phaseResult.ok || !phaseResult.value) {
        node.status = "failed";
        run.status = "failed";
        await events.emit({
          type: "step_failed",
          message: "Acceptance gate failed",
          node_id: node.node_id,
          role_id: role.id,
          data: { error_code: phaseResult.errorCode || "acceptance_verdict_invalid" }
        });
        await writeAgenticRun(projectRoot, run);
        break;
      }

      await writePhaseFile(
        projectRoot,
        run,
        node,
        "verification",
        phaseResult.attemptIndex,
        "verdict.json",
        `${JSON.stringify(phaseResult.value.raw, null, 2)}\n`
      );
      node.acceptance = {
        incoming_handoff_ref: state.incomingHandoffRef,
        verdict: phaseResult.value.verdict,
        verdict_ref: verdictRef,
        unmet: phaseResult.value.unmet
      };
      await events.emit({
        type: "acceptance_verification_completed",
        message: "Acceptance verification completed",
        node_id: node.node_id,
        role_id: role.id,
        data: { verdict: phaseResult.value.verdict, unmet: phaseResult.value.unmet, verdict_ref: verdictRef }
      });

      if (phaseResult.value.verdict === "reject") {
        node.status = "rejected_upstream";
        const sender = lastSenderNode;
        await events.emit({
          type: "handoff_rejected",
          message: "Handoff rejected at acceptance gate",
          node_id: node.node_id,
          role_id: role.id,
          data: { unmet: phaseResult.value.unmet, sender_node: sender?.node_id ?? "" }
        });
        if (!sender) {
          // No upstream sender to rework against; treat as a failure.
          node.status = "failed";
          run.status = "failed";
          await writeAgenticRun(projectRoot, run);
          break;
        }
        await events.emit({
          type: "rework_routed",
          message: "Rework routed to upstream sender",
          node_id: node.node_id,
          role_id: role.id,
          data: { from: node.node_id, to_role: sender.role_id, reason: phaseResult.value.unmet }
        });
        state = {
          roleId: sender.role_id,
          entryReason: "rework",
          enteredFrom: node.node_id,
          instructions: "",
          incomingHandoffRef: "",
          incomingCriteria: [],
          incomingMarkdown: "",
          rework: {
            unmet: phaseResult.value.unmet,
            verdictNotes: typeof phaseResult.value.raw.notes === "string" ? phaseResult.value.raw.notes : "",
            originalObjective: workflow.roles[sender.role_id]?.objective ?? ""
          }
        };
        await writeAgenticRun(projectRoot, run);
        continue;
      }
    }

    // --- Work call (spec §4, §5, §9). ---
    node.status = "working";
    setActiveCursor(run, { role_id: role.id, node_id: node.node_id, phase: "work" });
    const candidateInfo = candidatesByRole[state.roleId] ?? { candidates: [], source: "none" as CandidateSource };
    const candidateIds = candidateInfo.candidates;
    const canFinal = terminalRoles.has(state.roleId) || candidateIds.length === 0;
    await events.emit({
      type: "route_candidates_resolved",
      message: "Route candidates resolved",
      node_id: node.node_id,
      role_id: role.id,
      data: { candidates: candidateIds, source: candidateInfo.source, can_final: canFinal }
    });

    const directory = await buildCandidateDirectory(candidateIds, {
      projectRoot,
      whenByRole: candidateSourceWhenByRole(role)
    });
    const workPrompt = buildAgenticWorkPrompt({
      runId: run.run_id,
      nodeId: node.node_id,
      roleId: role.id,
      taskInput: run.task.input,
      role,
      objective,
      instructions: state.instructions,
      candidates: directory,
      canFinal,
      repoSummary,
      workflowSummary: workflowSummary as never,
      rework: state.rework
    });
    const workContract = agenticHandoffOutputContract({
      runId: run.run_id,
      nodeId: node.node_id,
      roleId: role.id,
      candidates: candidateIds,
      canFinal
    });

    const workResult = await runPhaseCall<HandoffV2>({
      projectRoot,
      env,
      events,
      run,
      node,
      role,
      adapter,
      phase: "work",
      prompt: workPrompt,
      contract: workContract,
      isRetry: state.entryReason === "rework",
      outputSchemaPath: handoffSchemaPath,
      outputSchemaJson: handoffSchemaJson,
      validate: async (raw) => validateWorkHandoff(raw, { runId: run.run_id, nodeId: node.node_id, roleId: role.id }, { candidates: candidateIds, canFinal })
    });

    if (!workResult.ok || !workResult.value) {
      node.status = "failed";
      run.status = "failed";
      await events.emit({
        type: "step_failed",
        message: "Work call failed",
        node_id: node.node_id,
        role_id: role.id,
        data: { error_code: workResult.errorCode || "handoff_content_invalid" }
      });
      await writeAgenticRun(projectRoot, run);
      break;
    }

    const handoff = workResult.value;
    const handoffRef = relativeAgenticAttemptPath(node.node_seq, role.id, "work", workResult.attemptIndex, "handoff.json");
    const markdownRef = relativeAgenticAttemptPath(node.node_seq, role.id, "work", workResult.attemptIndex, "output.md");
    await writePhaseFile(projectRoot, run, node, "work", workResult.attemptIndex, "handoff.json", `${JSON.stringify(handoff, null, 2)}\n`);
    await writePhaseFile(projectRoot, run, node, "work", workResult.attemptIndex, "output.md", `${handoff.markdown_body.trim()}\n`);
    workResult.attempt.handoff_ref = handoffRef;
    workResult.attempt.markdown_ref = markdownRef;
    node.handoff_ref = handoffRef;
    await events.emit({
      type: "artifact_written",
      message: "Artifact written",
      node_id: node.node_id,
      role_id: role.id,
      data: artifactEventData(handoffRef, "handoff")
    });

    if (handoff.next_handoff.kind === "final") {
      node.status = "completed";
      run.status = "completed";
      await events.emit({
        type: "step_completed",
        message: "Node completed (final)",
        node_id: node.node_id,
        role_id: role.id,
        data: { handoff_ref: handoffRef, final: true }
      });
      await writeAgenticRun(projectRoot, run);
      break;
    }

    // kind === "handoff": route to the chosen next role.
    const nextRole = handoff.next_handoff.recommended_role;
    node.chosen_next_role = nextRole;
    node.status = "completed";
    lastSenderNode = node;
    await events.emit({
      type: "route_selected",
      message: "Route selected",
      node_id: node.node_id,
      role_id: role.id,
      data: { next_role: nextRole, handoff_ref: handoffRef }
    });
    await events.emit({
      type: "step_completed",
      message: "Node completed (handoff)",
      node_id: node.node_id,
      role_id: role.id,
      data: { handoff_ref: handoffRef, next_role: nextRole }
    });
    state = {
      roleId: nextRole,
      entryReason: "handoff",
      enteredFrom: node.node_id,
      instructions: handoff.next_handoff.instructions,
      incomingHandoffRef: handoffRef,
      incomingCriteria: handoff.next_handoff.acceptance_criteria,
      incomingMarkdown: handoff.markdown_body
    };
    await writeAgenticRun(projectRoot, run);
  }

  run.completed_at = isoNow();
  run.duration_ms = Date.now() - Date.parse(run.started_at);
  if (run.duration_ms > run.budget.max_duration_minutes * 60_000) {
    markAgenticBudgetExceeded(run, "max_duration_minutes");
  }
  setActiveCursor(run, null);
  await writeAgenticRun(projectRoot, run);
  await writeAgenticSummary(projectRoot, run);

  const finalStatus = run.status as AgenticRun["status"];
  const terminalEvent =
    finalStatus === "completed" ? "run_completed" : finalStatus === "escalated" ? "run_escalated" : "run_failed";
  await events.emit({
    type: terminalEvent,
    message: `Run ${finalStatus}`,
    data: { status: finalStatus, duration_ms: run.duration_ms, summary_ref: "summary.md" }
  });

  return run;
}

async function validateWorkHandoff(
  raw: string,
  expected: { runId: string; nodeId: string; roleId: string },
  routing: { candidates: string[]; canFinal: boolean }
): Promise<{ validation: PhaseValidation; value: HandoffV2 | null }> {
  const parsed = parseHandoffV2FromRaw(raw);
  if (!parsed.handoff) {
    return {
      validation: { ...emptyValidation(), parse_errors: parsed.errors, error_code: "handoff_parse_failed" },
      value: null
    };
  }

  const markdownRef = "output.md";
  const normalized = normalizeHandoffArtifacts(parsed.handoff as never, markdownRef) as never as HandoffV2;
  const base = await validateHandoffV2Content(normalized as never, {
    runId: expected.runId,
    stepId: expected.nodeId,
    roleId: expected.roleId
  });

  const contentErrors = [...base.content_errors];
  const nextHandoff = (normalized.next_handoff ?? {}) as { kind?: string; recommended_role?: string };
  let semanticCode = "";

  if (base.schema_errors.length === 0) {
    if (nextHandoff.kind === "final" && !routing.canFinal) {
      contentErrors.push("premature_final: this role is not terminal and has handoff candidates, so it must not finalize.");
      semanticCode = "premature_final";
    }
    if (nextHandoff.kind === "handoff" && !routing.candidates.includes(nextHandoff.recommended_role ?? "")) {
      contentErrors.push(
        `route_target_not_allowed: recommended_role "${nextHandoff.recommended_role ?? ""}" is not in the candidate set [${routing.candidates.join(", ")}].`
      );
      semanticCode = "route_target_not_allowed";
    }
  }

  const valid = base.schema_errors.length === 0 && contentErrors.length === 0;
  let errorCode = "";
  if (!valid) {
    if (base.schema_errors.length > 0) errorCode = "handoff_schema_invalid";
    else if (semanticCode) errorCode = semanticCode;
    else errorCode = "handoff_content_invalid";
  }

  return {
    validation: {
      valid,
      parse_errors: [],
      schema_errors: base.schema_errors,
      content_errors: contentErrors,
      error_code: errorCode
    },
    value: valid ? normalized : null
  };
}

async function loadOrCollectRepoSummary(projectRoot: string, run: AgenticRun): Promise<RepoSummary> {
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

export async function runAgenticWorkflow({
  workflow,
  taskInput,
  projectRoot = process.cwd(),
  env = process.env,
  eventObservers = [],
  eventSinks = [],
  writeEventsJsonl = false
}: RunAgenticWorkflowOptions): Promise<AgenticRun> {
  const { config } = await loadProjectConfig(projectRoot);
  const { candidatesByRole } = await validateAgenticWorkflow(workflow, projectRoot);

  const run = createInitialAgenticRun({
    runId: createRunId(workflow.id),
    workflow,
    taskInput,
    budgets: resolveAgenticBudgets(config)
  });

  await ensureAgenticRunDirectories(projectRoot, run);
  const events = await createRunEventEmitter({
    runId: run.run_id,
    projectRoot,
    observers: eventObservers,
    sinks: eventSinks,
    writeJsonl: writeEventsJsonl
  });

  const repoSummary = await collectRepoContext(projectRoot);
  await writeFile(
    join(projectRoot, ".forgekit/runs", run.run_id, "context/repo-summary.json"),
    `${JSON.stringify(repoSummary, null, 2)}\n`,
    "utf8"
  );
  await writeAgenticRun(projectRoot, run);
  await events.emit({
    type: "run_created",
    message: "Run created",
    data: {
      workflow_id: run.workflow_id,
      mode: "agentic",
      entrypoint: workflow.entrypoint,
      task_input_chars: taskInput.length,
      run_ref: "run.json"
    }
  });

  return executeAgenticRun({ projectRoot, env, events, run, workflow, candidatesByRole });
}

interface RetryAgenticWorkflowOptions {
  runId: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  eventObservers?: RunEventObserver[];
  eventSinks?: RunEventSink[];
  writeEventsJsonl?: boolean;
}

/**
 * Reconstructs the routing context of the last failed node and re-runs from there
 * (spec §8). Succeeded nodes are reused read-only; the failed node keeps its prior
 * attempts and gains new ones. Only `failed` runs can retry — `escalated` cannot.
 */
export async function retryAgenticWorkflow({
  runId,
  projectRoot = process.cwd(),
  env = process.env,
  eventObservers = [],
  eventSinks = [],
  writeEventsJsonl = false
}: RetryAgenticWorkflowOptions): Promise<AgenticRun> {
  const run = await readAgenticRun(projectRoot, runId);
  if (run.status !== "failed") {
    throw new ForgeKitError({
      code: "run_not_retryable",
      message: `Only failed runs can be retried. Current status: ${run.status}`,
      category: "run",
      retryable: false,
      details: { run_id: runId, status: run.status }
    });
  }

  let failedIndex = -1;
  for (let index = run.nodes.length - 1; index >= 0; index -= 1) {
    if (run.nodes[index].status === "failed") {
      failedIndex = index;
      break;
    }
  }
  if (failedIndex === -1) {
    throw new ForgeKitError({
      code: "run_not_retryable",
      message: `Run ${runId} is failed but has no failed node.`,
      category: "run",
      retryable: false,
      details: { run_id: runId, status: run.status }
    });
  }

  const failedNode = run.nodes[failedIndex];
  const sender = failedNode.entered_from
    ? run.nodes.find((node) => node.node_id === failedNode.entered_from) ?? null
    : null;

  const loaded = await loadAnyWorkflowConfig(run.workflow_id, projectRoot);
  if (loaded.kind !== "agentic") {
    throw new ForgeKitError({
      code: "workflow_invalid",
      message: `Run ${runId} references a non-agentic workflow ${run.workflow_id}.`,
      category: "workflow",
      retryable: false,
      details: { run_id: runId, workflow_id: run.workflow_id }
    });
  }
  const workflow = loaded.workflow;
  const { candidatesByRole } = await validateAgenticWorkflow(workflow, projectRoot);

  let state: RoutingState;
  let initialSender: RunNode | null = null;
  if (failedNode.entry_reason === "rework" && sender) {
    state = {
      roleId: failedNode.role_id,
      entryReason: "rework",
      enteredFrom: sender.node_id,
      instructions: "",
      incomingHandoffRef: "",
      incomingCriteria: [],
      incomingMarkdown: "",
      rework: {
        unmet: sender.acceptance?.unmet ?? [],
        verdictNotes: "",
        originalObjective: workflow.roles[failedNode.role_id]?.objective ?? ""
      }
    };
  } else if (failedNode.entry_reason === "handoff" && sender) {
    const senderHandoff = await readJsonFile<HandoffV2>(join(runRoot(projectRoot, runId), sender.handoff_ref));
    const nextHandoff = senderHandoff.next_handoff;
    state = {
      roleId: failedNode.role_id,
      entryReason: "handoff",
      enteredFrom: sender.node_id,
      instructions: nextHandoff.kind === "handoff" ? nextHandoff.instructions : "",
      incomingHandoffRef: sender.handoff_ref,
      incomingCriteria: nextHandoff.kind === "handoff" ? nextHandoff.acceptance_criteria : [],
      incomingMarkdown: senderHandoff.markdown_body
    };
    initialSender = sender;
  } else {
    state = {
      roleId: failedNode.role_id,
      entryReason: "entrypoint",
      enteredFrom: null,
      instructions: "",
      incomingHandoffRef: "",
      incomingCriteria: [],
      incomingMarkdown: ""
    };
  }

  run.completed_at = "";
  run.escalation = null;

  const events = await createRunEventEmitter({
    runId: run.run_id,
    projectRoot,
    observers: eventObservers,
    sinks: eventSinks,
    writeJsonl: writeEventsJsonl
  });

  return executeAgenticRun({
    projectRoot,
    env,
    events,
    run,
    workflow,
    candidatesByRole,
    initialState: state,
    resumeNode: failedNode,
    initialSender
  });
}
