import { loadAdapterConfig, loadProjectConfig, loadRoleConfig, loadWorkflowConfig } from "./project-config.js";

function unique(values) {
  return [...new Set(values)];
}

function formatMaybe(value, fallback = "unknown") {
  return value === undefined || value === null || value === "" ? fallback : value;
}

function expectedNextFor(workflow, index) {
  return index < workflow.steps.length - 1 ? workflow.steps[index + 1].id : null;
}

export function validateLinearWorkflow(workflow) {
  const stepIds = workflow.steps.map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error("MVP-0 supports only linear workflows: step ids must be unique.");
  }
  if (workflow.entrypoint !== workflow.steps[0].id) {
    throw new Error("MVP-0 supports only linear workflows: entrypoint must be the first step id.");
  }

  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    const next = step.next ?? [];
    if (next.length > 1) {
      throw new Error(`MVP-0 supports only linear workflows: step ${step.id} has multiple next steps.`);
    }

    const expectedNext = expectedNextFor(workflow, index);
    if (!expectedNext && next.length > 0) {
      throw new Error(`MVP-0 supports only linear workflows: final step ${step.id} must not point to another step.`);
    }
    if (next.length === 1 && next[0] !== expectedNext) {
      throw new Error(`MVP-0 supports only linear workflows: step ${step.id} must point to ${expectedNext}.`);
    }
  }
}

function adapterSummary(adapter) {
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

function warningsFor(plan) {
  const warnings = [];
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

export async function buildRunPlan({ workflowId, taskInput, projectRoot = process.cwd() }) {
  const [{ workflow }, { config }] = await Promise.all([
    loadWorkflowConfig(workflowId, projectRoot),
    loadProjectConfig(projectRoot)
  ]);
  validateLinearWorkflow(workflow);

  const adapterById = new Map();
  const steps = [];

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

export function formatRunPlan(plan) {
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
