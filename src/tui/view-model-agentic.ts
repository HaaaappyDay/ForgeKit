import type { AgenticRun, NodeStatus, RunEvent, RunStatus, BudgetExceededKey } from "../types.js";

export interface AgenticNodeView {
  nodeSeq: number;
  nodeId: string;
  roleId: string;
  status: NodeStatus;
  entryReason: string;
  enteredFrom: string | null;
  phase: string;
  verdict: string;
  unmet: string[];
  chosenNextRole: string | null;
  attemptCount: number;
  exitCode: number | null;
  error: string;
}

export interface AgenticBudgetView {
  invocations: number;
  maxInvocations: number;
  retries: number;
  steps: number;
  maxSteps: number;
  roleVisits: Array<{ roleId: string; count: number }>;
  maxRoleVisits: number;
  outputBytes: number;
  maxOutputBytes: number;
  exceeded: BudgetExceededKey[];
}

export interface AgenticEscalationView {
  reason: string;
  atNodeId: string;
  latestArtifacts: string[];
}

export interface AgenticEdgeView {
  from: string;
  to: string;
  type: string;
}

export interface AgenticMonitorViewModel {
  runId: string;
  workflowId: string;
  status: RunStatus;
  durationMs: number;
  activeNodeId: string | null;
  nodes: AgenticNodeView[];
  edges: AgenticEdgeView[];
  budget: AgenticBudgetView;
  escalation: AgenticEscalationView | null;
  recentEvents: Array<{ eventId: string; type: string; message: string; nodeId?: string }>;
}

export interface BuildAgenticMonitorViewModelOptions {
  maxEvents?: number;
}

const DEFAULT_MAX_EVENTS = 8;

/**
 * Pure projection of an agentic run (`run.json`, schema v2) plus a window of
 * recent events into a renderable node-list model. No I/O; no graph drawing.
 */
export function buildAgenticMonitorViewModel(
  run: AgenticRun,
  events: RunEvent[],
  options: BuildAgenticMonitorViewModelOptions = {}
): AgenticMonitorViewModel {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;

  const nodes: AgenticNodeView[] = run.nodes.map((node) => {
    const attempt = node.attempts.at(-1);
    return {
      nodeSeq: node.node_seq,
      nodeId: node.node_id,
      roleId: node.role_id,
      status: node.status,
      entryReason: node.entry_reason,
      enteredFrom: node.entered_from,
      phase: attempt?.phase ?? "",
      verdict: node.acceptance?.verdict ?? "",
      unmet: node.acceptance ? [...node.acceptance.unmet] : [],
      chosenNextRole: node.chosen_next_role,
      attemptCount: node.attempts.length,
      exitCode: attempt ? attempt.exit_code : null,
      error: attempt?.error ?? ""
    };
  });

  const recentEvents = events.slice(-maxEvents).map((event) => ({
    eventId: event.event_id,
    type: event.type,
    message: event.message,
    ...(event.node_id ? { nodeId: event.node_id } : {})
  }));

  const roleVisits = Object.entries(run.budget.role_visits).map(([roleId, count]) => ({ roleId, count }));

  return {
    runId: run.run_id,
    workflowId: run.workflow_id,
    status: run.status,
    durationMs: run.duration_ms,
    activeNodeId: run.active_cursor?.node_id ?? null,
    nodes,
    edges: run.edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type })),
    budget: {
      invocations: run.budget.invocations,
      maxInvocations: run.budget.max_invocations,
      retries: run.budget.retries,
      steps: run.budget.steps,
      maxSteps: run.budget.max_steps,
      roleVisits,
      maxRoleVisits: run.budget.max_role_visits,
      outputBytes: run.budget.output_bytes,
      maxOutputBytes: run.budget.max_output_bytes,
      exceeded: [...run.budget.exceeded]
    },
    escalation: run.escalation
      ? {
          reason: String(run.escalation.reason),
          atNodeId: run.escalation.at_node_id,
          latestArtifacts: [...run.escalation.latest_artifacts]
        }
      : null,
    recentEvents
  };
}
