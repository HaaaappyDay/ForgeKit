import type { Run, RunEvent, StepStatus, RunStatus, BudgetExceededKey } from "../types.js";

export interface MonitorStepView {
  index: number;
  stepId: string;
  roleId: string;
  status: StepStatus;
  activeAttempt: string;
  attemptCount: number;
  exitCode: number | null;
  error: string;
  markdownRef: string;
}

export interface MonitorBudgetView {
  invocations: number;
  maxInvocations: number;
  retries: number;
  outputBytes: number;
  maxOutputBytes: number;
  exceeded: BudgetExceededKey[];
}

export interface MonitorEventView {
  eventId: string;
  type: string;
  message: string;
  stepId?: string;
}

export interface MonitorViewModel {
  runId: string;
  workflowId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  steps: MonitorStepView[];
  budget: MonitorBudgetView;
  recentEvents: MonitorEventView[];
}

export interface BuildMonitorViewModelOptions {
  maxEvents?: number;
}

const DEFAULT_MAX_EVENTS = 8;

/**
 * Pure projection of authoritative run state (`run.json`) plus a window of the
 * most recent run events into a renderable monitor model. No I/O. `run.json`
 * drives structure and status; events only feed the activity feed.
 */
export function buildMonitorViewModel(
  run: Run,
  events: RunEvent[],
  options: BuildMonitorViewModelOptions = {}
): MonitorViewModel {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;

  const steps: MonitorStepView[] = run.steps.map((step) => {
    const attempt = step.attempts.at(-1);
    return {
      index: step.index,
      stepId: step.step_id,
      roleId: step.role_id,
      status: step.status,
      activeAttempt: step.active_attempt,
      attemptCount: step.attempts.length,
      exitCode: attempt ? attempt.exit_code : null,
      error: attempt?.error ?? "",
      markdownRef: attempt?.markdown_ref ?? ""
    };
  });

  const recentEvents: MonitorEventView[] = events.slice(-maxEvents).map((event) => ({
    eventId: event.event_id,
    type: event.type,
    message: event.message,
    ...(event.step_id ? { stepId: event.step_id } : {})
  }));

  return {
    runId: run.run_id,
    workflowId: run.workflow_id,
    status: run.status,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    durationMs: run.duration_ms,
    steps,
    budget: {
      invocations: run.budget.invocations,
      maxInvocations: run.budget.max_invocations,
      retries: run.budget.retries,
      outputBytes: run.budget.output_bytes,
      maxOutputBytes: run.budget.max_output_bytes,
      exceeded: [...run.budget.exceeded]
    },
    recentEvents
  };
}
