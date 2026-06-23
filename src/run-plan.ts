import { loadAdapterConfig, loadProjectConfig, loadRoleConfig, loadWorkflowConfig } from "./project-config.js";
import { ForgeKitError } from "./errors.js";
import type {
  AdapterConfig,
  AgenticRunPlan,
  AgenticRunPlanRole,
  AgenticWorkflowConfig,
  CandidateSource,
  ProjectConfig,
  RunPlan,
  RunPlanAdapter,
  RunPlanStep,
  WorkflowConfig
} from "./types.js";

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function formatMaybe(value: unknown, fallback = "unknown"): string {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function expectedNextFor(workflow: WorkflowConfig, index: number): string | null {
  return index < workflow.steps.length - 1 ? workflow.steps[index + 1].id : null;
}

export function validateLinearWorkflow(workflow: WorkflowConfig): void {
  function fail(message: string): never {
    throw new ForgeKitError({
      code: "workflow_invalid",
      message,
      category: "workflow",
      retryable: false,
      details: { workflow_id: workflow.id }
    });
  }

  if (workflow.steps.length === 0) {
    fail("MVP-0 supports only linear workflows: workflow must contain at least one step.");
  }

  const stepIds = workflow.steps.map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length) {
    fail("MVP-0 supports only linear workflows: step ids must be unique.");
  }
  if (workflow.entrypoint !== workflow.steps[0].id) {
    fail("MVP-0 supports only linear workflows: entrypoint must be the first step id.");
  }

  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    const next = step.next ?? [];
    if (next.length > 1) {
      fail(`MVP-0 supports only linear workflows: step ${step.id} has multiple next steps.`);
    }

    const expectedNext = expectedNextFor(workflow, index);
    if (!expectedNext && next.length > 0) {
      fail(`MVP-0 supports only linear workflows: final step ${step.id} must not point to another step.`);
    }
    if (next.length === 1 && next[0] !== expectedNext) {
      fail(`MVP-0 supports only linear workflows: step ${step.id} must point to ${expectedNext}.`);
    }
  }
}

export const AGENTIC_DEFAULT_MAX_STEPS = 24;
export const AGENTIC_DEFAULT_MAX_ROLE_VISITS = 3;

export interface AgenticBudgetPlan {
  max_invocations: number;
  max_retries_per_step: number;
  max_duration_minutes: number;
  max_output_bytes: number;
  max_steps: number;
  max_role_visits: number;
  token_budget: string;
}

export function resolveAgenticBudgets(config: ProjectConfig): AgenticBudgetPlan {
  return {
    max_invocations: config.budgets.max_invocations,
    max_retries_per_step: config.budgets.max_retries_per_step,
    max_duration_minutes: config.budgets.max_duration_minutes,
    max_output_bytes: config.budgets.max_output_bytes,
    max_steps: config.budgets.max_steps ?? AGENTIC_DEFAULT_MAX_STEPS,
    max_role_visits: config.budgets.max_role_visits ?? AGENTIC_DEFAULT_MAX_ROLE_VISITS,
    token_budget: config.budgets.token_budget ?? "[TBD]"
  };
}

interface ResolvedCandidates {
  candidates: string[];
  source: CandidateSource;
}

function resolveCandidates(
  workflow: AgenticWorkflowConfig,
  roleId: string,
  mustHandoffByRole: Record<string, string[]>
): ResolvedCandidates {
  const explicit = workflow.roles[roleId]?.handoff_targets ?? [];
  if (explicit.length > 0) {
    return { candidates: unique(explicit), source: "workflow" };
  }
  const fallback = mustHandoffByRole[roleId] ?? [];
  if (fallback.length > 0) {
    return { candidates: unique(fallback), source: "role_must_handoff_to" };
  }
  return { candidates: [], source: "none" };
}

export interface AgenticWorkflowAnalysis {
  errors: string[];
  warnings: string[];
  candidatesByRole: Record<string, ResolvedCandidates>;
}

/**
 * Pure static analysis of an agentic workflow graph (spec §5.3). `mustHandoffByRole`
 * supplies each role's `must_handoff_to` targets so candidate-set fallback can be
 * resolved without filesystem access, keeping this function unit-testable.
 */
export function analyzeAgenticWorkflow(
  workflow: AgenticWorkflowConfig,
  mustHandoffByRole: Record<string, string[]>
): AgenticWorkflowAnalysis {
  const errors: string[] = [];
  const warnings: string[] = [];
  const candidatesByRole: Record<string, ResolvedCandidates> = {};

  const roleIds = Object.keys(workflow.roles);
  const roleSet = new Set(roleIds);

  if (roleIds.length === 0) {
    errors.push("agentic workflow must define at least one role.");
    return { errors, warnings, candidatesByRole };
  }

  if (!roleSet.has(workflow.entrypoint)) {
    errors.push(`entrypoint "${workflow.entrypoint}" is not defined in roles.`);
  }

  const terminalRoles = workflow.terminal_roles ?? [];
  if (terminalRoles.length === 0) {
    errors.push("terminal_roles must not be empty.");
  }
  for (const terminal of terminalRoles) {
    if (!roleSet.has(terminal)) {
      errors.push(`terminal role "${terminal}" is not defined in roles.`);
    }
  }
  const terminalSet = new Set(terminalRoles);

  const graph: Record<string, string[]> = {};
  for (const roleId of roleIds) {
    const explicit = workflow.roles[roleId]?.handoff_targets ?? [];
    for (const target of explicit) {
      if (!roleSet.has(target)) {
        errors.push(`role "${roleId}" handoff_targets references unknown role "${target}".`);
      }
    }

    const resolved = resolveCandidates(workflow, roleId, mustHandoffByRole);
    candidatesByRole[roleId] = resolved;

    const known = resolved.candidates.filter((candidate) => roleSet.has(candidate));
    if (resolved.source === "role_must_handoff_to") {
      for (const candidate of resolved.candidates) {
        if (!roleSet.has(candidate)) {
          warnings.push(
            `role "${roleId}" must_handoff_to references unknown role "${candidate}"; ignored for routing.`
          );
        }
      }
    }

    if (!terminalSet.has(roleId) && known.length === 0) {
      errors.push(`role "${roleId}" is not terminal but has no reachable handoff candidates (dead end).`);
    }

    graph[roleId] = known;
  }

  if (roleSet.has(workflow.entrypoint)) {
    const reachable = reachableRoles(workflow.entrypoint, graph);
    if (terminalRoles.length > 0 && !terminalRoles.some((terminal) => reachable.has(terminal))) {
      errors.push(`no terminal role is reachable from entrypoint "${workflow.entrypoint}".`);
    }
    for (const roleId of roleIds) {
      if (!reachable.has(roleId)) {
        warnings.push(`role "${roleId}" is unreachable from entrypoint "${workflow.entrypoint}".`);
      }
    }
  }

  return { errors, warnings, candidatesByRole };
}

function reachableRoles(entrypoint: string, graph: Record<string, string[]>): Set<string> {
  const reachable = new Set<string>([entrypoint]);
  const queue = [entrypoint];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of graph[current] ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return reachable;
}

function agenticWorkflowInvalid(workflow: AgenticWorkflowConfig, errors: string[]): never {
  throw new ForgeKitError({
    code: "workflow_invalid",
    message: `Invalid agentic workflow ${workflow.id}:\n${errors.join("\n")}`,
    category: "workflow",
    retryable: false,
    details: { workflow_id: workflow.id, errors }
  });
}

export interface AgenticWorkflowValidation {
  warnings: string[];
  candidatesByRole: Record<string, ResolvedCandidates>;
}

/**
 * Loads each role's `must_handoff_to` from disk, runs the pure analysis, and throws
 * `workflow_invalid` on the first structural error (spec §5.3). Returns non-blocking
 * warnings (e.g. unreachable roles) on success.
 */
export async function validateAgenticWorkflow(
  workflow: AgenticWorkflowConfig,
  projectRoot = process.cwd()
): Promise<AgenticWorkflowValidation> {
  const mustHandoffByRole: Record<string, string[]> = {};
  for (const roleId of Object.keys(workflow.roles)) {
    const { role } = await loadRoleConfig(roleId, projectRoot);
    mustHandoffByRole[roleId] = role.must_handoff_to.map((entry) => entry.role);
  }

  const analysis = analyzeAgenticWorkflow(workflow, mustHandoffByRole);
  if (analysis.errors.length > 0) {
    agenticWorkflowInvalid(workflow, analysis.errors);
  }
  return { warnings: analysis.warnings, candidatesByRole: analysis.candidatesByRole };
}

function adapterSummary(adapter: AdapterConfig): RunPlanAdapter {
  return {
    adapter_id: adapter.id,
    type: adapter.type,
    command: adapter.command,
    auth_mode: formatMaybe(adapter.auth?.mode),
    billing_mode: formatMaybe(adapter.billing?.mode),
    cost_tracking: formatMaybe(adapter.billing?.cost_tracking),
    budget_policy: formatMaybe(adapter.billing?.budget_policy),
    write_policy_default: formatMaybe(adapter.write_policy?.default_mode),
    write_policy_enforcement: formatMaybe(adapter.write_policy?.enforcement)
  };
}

function warningsFor(plan: { adapters: RunPlanAdapter[]; steps: RunPlanStep[] }): string[] {
  const warnings: string[] = [];
  for (const adapter of plan.adapters) {
    if (adapter.write_policy_default !== "no_write_intent") {
      warnings.push(`Adapter ${adapter.adapter_id} default write policy is ${adapter.write_policy_default}; MVP-0 still runs with no-write intent.`);
    }
    if (adapter.write_policy_enforcement !== "strict") {
      warnings.push(`Adapter ${adapter.adapter_id} write enforcement is ${adapter.write_policy_enforcement}; external CLI behavior is audited but not fully controlled.`);
    }
  }
  for (const step of plan.steps) {
    if (step.role_write_policy !== "no_write_intent") {
      warnings.push(`Role ${step.role_id} declares ${step.role_write_policy}; MVP-0 workflow runs do not allow file modifications.`);
    }
  }
  return unique(warnings);
}

export async function buildRunPlan({
  workflowId,
  taskInput,
  projectRoot = process.cwd()
}: {
  workflowId: string;
  taskInput: string;
  projectRoot?: string;
}): Promise<RunPlan> {
  const [{ workflow }, { config }] = await Promise.all([
    loadWorkflowConfig(workflowId, projectRoot),
    loadProjectConfig(projectRoot)
  ]);
  validateLinearWorkflow(workflow);

  const adapterById = new Map<string, RunPlanAdapter>();
  const steps: RunPlanStep[] = [];

  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    const { role, adapterId } = await loadRoleConfig(step.role, projectRoot);
    const { adapter } = await loadAdapterConfig(adapterId, projectRoot);
    adapterById.set(adapter.id, adapterSummary(adapter));
    steps.push({
      index: index + 1,
      step_id: step.id,
      objective: step.objective,
      role_id: role.id,
      role_name: role.name,
      adapter_id: adapter.id,
      adapter_type: adapter.type,
      role_write_policy: role.write_policy.mode,
      output_schema: step.output_schema
    });
  }

  const plan = {
    workflow_id: workflow.id,
    workflow_name: workflow.name,
    task_input: taskInput,
    steps,
    adapters: [...adapterById.values()],
    context: {
      repo: `${workflow.repo_context} lightweight repo summary`,
      sharing: "workflow summary + previous handoff",
      mode: "no file modifications"
    },
    budgets: {
      max_invocations: config.budgets.max_invocations,
      max_retries_per_step: config.budgets.max_retries_per_step,
      max_duration_minutes: config.budgets.max_duration_minutes,
      max_output_bytes: config.budgets.max_output_bytes,
      token_budget: config.budgets.token_budget ?? "[TBD]"
    }
  };
  return {
    ...plan,
    warnings: warningsFor(plan)
  };
}

function agenticWarningsFor(adapters: RunPlanAdapter[], roles: AgenticRunPlanRole[]): string[] {
  const warnings: string[] = [];
  for (const adapter of adapters) {
    if (adapter.write_policy_default !== "no_write_intent") {
      warnings.push(`Adapter ${adapter.adapter_id} default write policy is ${adapter.write_policy_default}; agentic runs still use no-write intent.`);
    }
    if (adapter.write_policy_enforcement !== "strict") {
      warnings.push(`Adapter ${adapter.adapter_id} write enforcement is ${adapter.write_policy_enforcement}; external CLI behavior is audited but not fully controlled.`);
    }
  }
  for (const role of roles) {
    if (role.role_write_policy !== "no_write_intent") {
      warnings.push(`Role ${role.role_id} declares ${role.role_write_policy}; agentic workflow runs do not allow file modifications.`);
    }
  }
  return unique(warnings);
}

export async function buildAgenticRunPlan({
  workflow,
  taskInput,
  projectRoot = process.cwd()
}: {
  workflow: AgenticWorkflowConfig;
  taskInput: string;
  projectRoot?: string;
}): Promise<AgenticRunPlan> {
  const { config } = await loadProjectConfig(projectRoot);

  const roleIds = Object.keys(workflow.roles);
  const adapterById = new Map<string, RunPlanAdapter>();
  const adapterTypeById = new Map<string, AdapterConfig["type"]>();
  const roleEntries = new Map<string, { roleName: string; adapterId: string; writePolicy: RunPlanStep["role_write_policy"] }>();
  const mustHandoffByRole: Record<string, string[]> = {};

  for (const roleId of roleIds) {
    const { role, adapterId } = await loadRoleConfig(roleId, projectRoot);
    const { adapter } = await loadAdapterConfig(adapterId, projectRoot);
    adapterById.set(adapter.id, adapterSummary(adapter));
    adapterTypeById.set(adapter.id, adapter.type);
    roleEntries.set(roleId, {
      roleName: role.name,
      adapterId: adapter.id,
      writePolicy: role.write_policy.mode
    });
    mustHandoffByRole[roleId] = role.must_handoff_to.map((entry) => entry.role);
  }

  const analysis = analyzeAgenticWorkflow(workflow, mustHandoffByRole);
  if (analysis.errors.length > 0) {
    agenticWorkflowInvalid(workflow, analysis.errors);
  }

  const terminalSet = new Set(workflow.terminal_roles);
  const roles: AgenticRunPlanRole[] = roleIds.map((roleId) => {
    const entry = roleEntries.get(roleId)!;
    const resolved = analysis.candidatesByRole[roleId];
    return {
      role_id: roleId,
      role_name: entry.roleName,
      adapter_id: entry.adapterId,
      adapter_type: adapterTypeById.get(entry.adapterId)!,
      role_write_policy: entry.writePolicy,
      objective: workflow.roles[roleId]?.objective ?? "",
      is_entrypoint: roleId === workflow.entrypoint,
      is_terminal: terminalSet.has(roleId),
      candidates: resolved.candidates,
      candidate_source: resolved.source
    };
  });

  const adapters = [...adapterById.values()];
  return {
    workflow_id: workflow.id,
    workflow_name: workflow.name,
    run_mode: "agentic",
    task_input: taskInput,
    entrypoint: workflow.entrypoint,
    terminal_roles: [...workflow.terminal_roles],
    roles,
    adapters,
    context: {
      repo: `${workflow.repo_context} lightweight repo summary`,
      sharing: "workflow summary + previous handoff",
      mode: "no file modifications"
    },
    budgets: resolveAgenticBudgets(config),
    warnings: unique([...agenticWarningsFor(adapters, roles), ...analysis.warnings])
  };
}

export function formatAgenticRunPlan(plan: AgenticRunPlan): string {
  const lines = [
    `ForgeKit will start agentic workflow: ${plan.workflow_id}`,
    "",
    "Task:",
    `  ${plan.task_input}`,
    "",
    `Entrypoint: ${plan.entrypoint}`,
    `Terminal roles: ${plan.terminal_roles.join(", ")}`,
    "",
    "Roles & routing:"
  ];

  for (const role of plan.roles) {
    const markers = [role.is_entrypoint ? "entry" : null, role.is_terminal ? "terminal" : null]
      .filter((marker): marker is string => marker !== null)
      .join(", ");
    const suffix = markers ? ` [${markers}]` : "";
    const targets = role.candidates.length > 0 ? role.candidates.join(", ") : "(none)";
    lines.push(`  - ${role.role_id}${suffix}     role: ${role.role_name}     adapter: ${role.adapter_id}`);
    lines.push(`      can hand off to: ${targets}     (source: ${role.candidate_source})`);
  }

  lines.push(
    "",
    "Context:",
    `  repo: ${plan.context.repo}`,
    `  sharing: ${plan.context.sharing}`,
    `  mode: ${plan.context.mode}`,
    "",
    "Auth & billing:"
  );

  for (const adapter of plan.adapters) {
    lines.push(
      `  ${adapter.adapter_id}: ${adapter.auth_mode}, ${adapter.billing_mode}, cost_tracking: ${adapter.cost_tracking}, budget_policy: ${adapter.budget_policy}`
    );
  }

  lines.push(
    "",
    "Write policy:",
    "  effective mode: no_write_intent",
    "  external agents are instructed not to modify project files",
    "",
    "Guardrails:",
    `  max_steps: ${plan.budgets.max_steps}`,
    `  max_role_visits: ${plan.budgets.max_role_visits}`,
    `  max_invocations: ${plan.budgets.max_invocations}`,
    `  max_retries_per_step: ${plan.budgets.max_retries_per_step}`,
    `  max_duration_minutes: ${plan.budgets.max_duration_minutes}`,
    `  max_output_bytes: ${plan.budgets.max_output_bytes}`,
    `  token_budget: ${plan.budgets.token_budget}`
  );

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatRunPlan(plan: RunPlan): string {
  const lines = [
    `ForgeKit will start workflow: ${plan.workflow_id}`,
    "",
    "Task:",
    `  ${plan.task_input}`,
    "",
    "Steps:"
  ];

  for (const step of plan.steps) {
    lines.push(`  ${step.index}. ${step.step_id}     role: ${step.role_id}     adapter: ${step.adapter_id}`);
  }

  lines.push(
    "",
    "Context:",
    `  repo: ${plan.context.repo}`,
    `  sharing: ${plan.context.sharing}`,
    `  mode: ${plan.context.mode}`,
    "",
    "Auth & billing:"
  );

  for (const adapter of plan.adapters) {
    lines.push(
      `  ${adapter.adapter_id}: ${adapter.auth_mode}, ${adapter.billing_mode}, cost_tracking: ${adapter.cost_tracking}, budget_policy: ${adapter.budget_policy}`
    );
  }

  lines.push(
    "",
    "Write policy:",
    "  effective mode: no_write_intent",
    "  external agents are instructed not to modify project files",
    "",
    "Soft budget:",
    `  max_invocations: ${plan.budgets.max_invocations}`,
    `  max_retries_per_step: ${plan.budgets.max_retries_per_step}`,
    `  max_duration_minutes: ${plan.budgets.max_duration_minutes}`,
    `  max_output_bytes: ${plan.budgets.max_output_bytes}`,
    `  token_budget: ${plan.budgets.token_budget}`
  );

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
