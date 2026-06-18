export const TEMPLATE_IDS = ["blank", "generic-plan-review", "feature-planning"];

const CODEX_COMMAND =
  "/home/lotus/.nvm/versions/node/v24.15.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex";

function adapter(id, type, command) {
  return {
    schema_version: "forgekit.adapter.v1",
    id,
    type,
    command,
    args: [],
    working_directory: "project_root",
    timeout_seconds: 600,
    session_mode: "resumable_role_session",
    resume: {
      strategy: "adapter_defined",
      session_id_ref: "run.role_sessions.<role_id>.external_session_id"
    },
    write_policy: {
      default_mode: "no_write_intent",
      enforcement: "best_effort",
      adapter_permission_args: [],
      warn_if_unenforceable: true
    },
    auth: {
      mode: "external_cli_auth",
      description: "Use the CLI's existing logged-in account or subscription."
    },
    billing: {
      mode: "user_subscription",
      cost_tracking: "unavailable",
      budget_policy: "soft"
    },
    capabilities: {
      resumable_session: true,
      structured_output_prompting: true,
      file_editing: false,
      tool_use: "external_agent_defined"
    },
    env_allowlist: []
  };
}

function role(id, name, description, responsibilities, canDo, cannotDo, handoffRole = "reviewer") {
  return {
    schema_version: "forgekit.role.v1",
    id,
    name,
    description,
    responsibilities,
    expertise: {
      domains: ["general"],
      depth: "intermediate",
      style: "concise",
      output_formats: ["handoff_json", "markdown"],
      permissions: ["read_context", "produce_artifact", "request_handoff"]
    },
    write_policy: {
      mode: "no_write_intent",
      allowed_paths: [],
      requires_human_confirmation: true
    },
    can_do: canDo,
    cannot_do: cannotDo,
    must_handoff_to: [
      {
        when: "next workflow step requires a different responsibility boundary",
        role: handoffRole
      }
    ],
    required_sections: ["summary", "assumptions", "risks", "open_questions", "next_handoff"]
  };
}

function workflow(id, name, steps) {
  return {
    schema_version: "forgekit.workflow.v1",
    id,
    name,
    version: "0.1",
    mode: "workflow_run",
    entrypoint: steps[0].id,
    repo_context: "standard",
    steps: steps.map((step, index) => ({
      id: step.id,
      role: step.role,
      objective: step.objective,
      next: index < steps.length - 1 ? [steps[index + 1].id] : [],
      output_schema: "handoff.v1",
      ...(step.constraints ? { constraints: step.constraints } : {})
    })),
    conflict_policy: {
      default: "merge_role_decides",
      require_human_when: [
        "security_or_privacy_risk",
        "data_loss_or_destructive_action",
        "large_scope_change"
      ]
    }
  };
}

function config(projectName, defaultWorkflow, roleAdapters) {
  return {
    schema_version: "forgekit.config.v1",
    project: {
      name: projectName
    },
    defaults: {
      workflow: defaultWorkflow,
      repo_context: "standard",
      confirmation: "before_run_only"
    },
    roles: Object.fromEntries(
      Object.entries(roleAdapters).map(([roleId, adapterId]) => [
        roleId,
        {
          definition: `.forgekit/roles/${roleId}.json`,
          adapter: adapterId
        }
      ])
    ),
    adapters: {
      "codex-local": ".forgekit/adapters/codex.json",
      "claude-code": ".forgekit/adapters/claude-code.json"
    },
    budgets: {
      max_invocations: 8,
      max_retries_per_step: 1,
      max_duration_minutes: 30,
      max_output_bytes: 200000,
      token_budget: "[TBD]"
    }
  };
}

function commonAdapters() {
  return {
    "codex.json": adapter("codex-local", "codex", CODEX_COMMAND),
    "claude-code.json": adapter("claude-code", "claude-code", "claude")
  };
}

function genericPlanReview(projectName) {
  const roles = {
    "planner.json": role(
      "planner",
      "Planner",
      "Clarifies task scope, constraints, and success criteria.",
      ["Clarify the task", "Define success criteria", "Identify constraints"],
      ["Break down goals", "Produce planning handoffs"],
      ["Modify project files", "Make final specialist decisions"],
      "specialist"
    ),
    "specialist.json": role(
      "specialist",
      "Specialist",
      "Produces a focused domain plan or analysis within the task scope.",
      ["Analyze the task", "Produce a domain-specific plan", "Identify implementation risks"],
      ["Provide specialist recommendations", "Prepare handoff for review"],
      ["Expand task scope", "Approve its own work as final"],
      "reviewer"
    ),
    "reviewer.json": role(
      "reviewer",
      "Reviewer",
      "Reviews outputs for quality, risk, and completeness.",
      ["Evaluate completeness", "Identify risks", "Recommend whether to proceed"],
      ["Review prior handoffs", "List blocking issues"],
      ["Modify project files", "Perform irreversible external actions"],
      "planner"
    )
  };

  return {
    config: config(projectName, "generic-plan-review", {
      planner: "codex-local",
      specialist: "claude-code",
      reviewer: "codex-local"
    }),
    roles,
    workflows: {
      "generic-plan-review.json": workflow("generic-plan-review", "Generic Plan Review", [
        {
          id: "plan",
          role: "planner",
          objective: "Clarify the task, constraints, assumptions, and acceptance criteria."
        },
        {
          id: "specialist-analysis",
          role: "specialist",
          objective: "Produce a focused plan or analysis without editing files."
        },
        {
          id: "review",
          role: "reviewer",
          objective: "Review the prior handoff for completeness, risk, and next actions."
        }
      ])
    },
    adapters: commonAdapters(),
    examples: {}
  };
}

function featurePlanning(projectName) {
  const baseCannot = ["Modify project files", "Perform irreversible external actions"];
  const roles = {
    "pm.json": role(
      "pm",
      "Product Manager",
      "Clarifies user value, scope, constraints, and acceptance criteria.",
      ["Clarify requirements", "Define acceptance criteria", "Identify product risks"],
      ["Write user stories", "Separate MVP from follow-up work"],
      ["Write code", "Decide technical architecture"],
      "architect"
    ),
    "architect.json": role(
      "architect",
      "Architect",
      "Creates technical design and integration guidance without editing files.",
      ["Design system boundaries", "Identify integration risks", "Recommend architecture"],
      ["Produce technical design", "Prepare implementation handoff"],
      ["Modify files", "Override product requirements"],
      "engineer"
    ),
    "engineer.json": role(
      "engineer",
      "Engineer",
      "Turns approved design into an implementation plan without changing files.",
      ["Plan implementation steps", "Identify code areas", "Call out rollback considerations"],
      ["Produce implementation plan", "Estimate sequencing"],
      baseCannot,
      "qa"
    ),
    "qa.json": role(
      "qa",
      "QA Engineer",
      "Produces test strategy, edge cases, and acceptance risks.",
      ["Define test plan", "Identify regression risks", "Check acceptance coverage"],
      ["Produce test plan", "Recommend verification steps"],
      ["Modify implementation", "Approve product scope changes"],
      "pm"
    )
  };

  return {
    config: config(projectName, "feature-planning", {
      pm: "codex-local",
      architect: "claude-code",
      engineer: "codex-local",
      qa: "codex-local"
    }),
    roles,
    workflows: {
      "feature-planning.json": workflow("feature-planning", "Feature Planning", [
        {
          id: "clarify-requirement",
          role: "pm",
          objective: "Clarify user need, constraints, MVP scope, and acceptance criteria."
        },
        {
          id: "technical-design",
          role: "architect",
          objective: "Produce technical design without editing files.",
          constraints: {
            focus_area: ["architecture", "integration risks"],
            forbidden_actions: ["modify_files"]
          }
        },
        {
          id: "implementation-plan",
          role: "engineer",
          objective: "Turn the design into an implementation plan without editing files."
        },
        {
          id: "test-plan",
          role: "qa",
          objective: "Produce a test plan, edge cases, and acceptance risks."
        }
      ])
    },
    adapters: commonAdapters(),
    examples: {}
  };
}

function blank(projectName) {
  const exampleRole = role(
    "example-role",
    "Example Role",
    "Example role contract for a custom workflow.",
    ["Define the role responsibility boundary"],
    ["Read context", "Produce a handoff artifact"],
    ["Modify project files"],
    "next-role"
  );

  return {
    config: config(projectName, "custom-workflow", {}),
    roles: {},
    workflows: {},
    adapters: commonAdapters(),
    examples: {
      "roles/example-role.json": exampleRole,
      "workflows/custom-workflow.json": workflow("custom-workflow", "Custom Workflow", [
        {
          id: "example-step",
          role: "example-role",
          objective: "Replace this objective with the custom workflow step goal."
        }
      ])
    }
  };
}

export function buildTemplate(templateId, projectName) {
  if (templateId === "blank") return blank(projectName);
  if (templateId === "generic-plan-review") return genericPlanReview(projectName);
  if (templateId === "feature-planning") return featurePlanning(projectName);
  throw new Error(`Unknown template: ${templateId}`);
}

