export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonSchemaType = "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  type?: JsonSchemaType;
  const?: JsonValue;
  enum?: JsonValue[];
  minLength?: number;
  minimum?: number;
  minItems?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
}

export type SchemaId =
  | "forgekit.adapter.v1"
  | "forgekit.config.v1"
  | "forgekit.role.v1"
  | "forgekit.run-event.v1"
  | "forgekit.run.v1"
  | "forgekit.workflow.v1"
  | "handoff.v1"
  | "workflow-summary.v1";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export type AdapterType = "codex" | "claude-code";
export type ResumeStrategy = "adapter_defined" | "codex_exec_resume" | "claude_resume";
export type WritePolicyMode =
  | "read_only_enforced"
  | "no_write_intent"
  | "write_with_confirmation"
  | "write_allowed";

export interface AdapterConfig {
  schema_version: "forgekit.adapter.v1";
  id: string;
  type: AdapterType;
  command: string;
  args: string[];
  working_directory: "project_root";
  timeout_seconds: number;
  session_mode: "resumable_role_session";
  resume: {
    strategy: "adapter_defined";
    session_id_ref?: string;
  };
  write_policy: {
    default_mode: WritePolicyMode;
    enforcement: "best_effort" | "enforced";
    adapter_permission_args: string[];
    warn_if_unenforceable: boolean;
  };
  auth: {
    mode: "external_cli_auth" | "env_api_key" | "secret_ref";
    description?: string;
    env_allowlist?: string[];
  };
  billing: {
    mode: "user_subscription" | "api_key_metered" | "unknown";
    cost_tracking: "unavailable" | "provider_reported_or_unknown" | "reported";
    budget_policy: "soft";
  };
  capabilities?: Record<string, unknown>;
  env_allowlist: string[];
}

export type AdapterRuntimeConfig = Pick<AdapterConfig, "id" | "type" | "command"> &
  Partial<Pick<AdapterConfig, "args" | "timeout_seconds" | "auth" | "billing" | "write_policy" | "env_allowlist">>;

export interface ProjectConfig {
  schema_version: "forgekit.config.v1";
  project: {
    name: string;
  };
  defaults: {
    workflow: string;
    repo_context: string;
    confirmation: "before_run_only";
  };
  roles: Record<string, {
    definition: string;
    adapter: string;
  }>;
  adapters: Record<string, string>;
  budgets: {
    max_invocations: number;
    max_retries_per_step: number;
    max_duration_minutes: number;
    max_output_bytes: number;
    token_budget?: string;
  };
}

export interface RoleConfig {
  schema_version: "forgekit.role.v1";
  id: string;
  name: string;
  description: string;
  responsibilities: string[];
  expertise: {
    domains: string[];
    depth: "basic" | "intermediate" | "senior" | "expert";
    style: string;
    output_formats: Array<"handoff_json" | "markdown" | "checklist">;
    permissions: Array<"read_context" | "produce_artifact" | "request_handoff">;
  };
  write_policy: {
    mode: WritePolicyMode;
    allowed_paths: string[];
    requires_human_confirmation: boolean;
  };
  can_do: string[];
  cannot_do: string[];
  must_handoff_to: Array<{
    when: string;
    role: string;
  }>;
  required_sections: string[];
}

export interface WorkflowStep {
  id: string;
  role: string;
  objective: string;
  next?: string[];
  inputs?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  output_schema: "handoff.v1";
}

export interface WorkflowConfig {
  schema_version: "forgekit.workflow.v1";
  id: string;
  name: string;
  version: string;
  mode: "workflow_run";
  entrypoint: string;
  repo_context: string;
  steps: WorkflowStep[];
  conflict_policy?: Record<string, unknown>;
}

export type RunStatus = "pending" | "running" | "completed" | "failed";
export type StepStatus =
  | "pending"
  | "starting_session"
  | "running"
  | "validating"
  | "self_correcting"
  | "completed"
  | "failed"
  | "skipped";
export type BudgetExceededKey =
  | "max_invocations"
  | "max_retries_per_step"
  | "max_duration_minutes"
  | "max_output_bytes";

export interface RoleSession {
  role_id: string;
  adapter_id: string;
  external_session_id: string;
  resume_strategy: ResumeStrategy;
  created_at: string;
  status: string;
}

export interface RunAttempt {
  attempt_id: string;
  status: StepStatus;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  prompt_ref: string;
  stdout_ref: string;
  stderr_ref: string;
  handoff_ref: string;
  markdown_ref: string;
  validation_ref: string;
  exit_code: number;
  external_session_id: string;
  correction_count: number;
  error: string;
  error_code?: string;
}

export interface RunStep {
  index: number;
  step_id: string;
  role_id: string;
  adapter_id: string;
  status: StepStatus;
  active_attempt: string;
  attempts: RunAttempt[];
}

export interface Run {
  schema_version: "forgekit.run.v1";
  run_id: string;
  workflow_id: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  task: {
    input: string;
  };
  role_sessions: Record<string, RoleSession>;
  budget: {
    max_invocations: number;
    max_retries_per_step: number;
    max_duration_minutes: number;
    max_output_bytes: number;
    invocations: number;
    retries: number;
    input_chars: number;
    output_bytes: number;
    exceeded: BudgetExceededKey[];
  };
  steps: RunStep[];
}

export interface HandoffDecision {
  decision: string;
  reason: string;
  alternatives: string[];
}

export interface HandoffArtifact {
  path: string;
  type: string;
  generated_from: string;
}

export interface Handoff {
  schema_version: "handoff.v1";
  run_id: string;
  step_id: string;
  role_id: string;
  status: string;
  summary: string;
  decisions: HandoffDecision[];
  assumptions: string[];
  risks: string[];
  open_questions: string[];
  out_of_scope: string[];
  markdown_body: string;
  next_handoff: {
    recommended_role: string;
    instructions: string;
  };
  artifacts: HandoffArtifact[];
}

export type HandoffCandidate = Partial<Handoff> & Record<string, unknown>;

export interface WorkflowSummaryCompletedStep {
  step_id: string;
  role_id: string;
  handoff_ref: string;
  summary: string;
  key_decisions: string[];
  risks: string[];
  open_questions: string[];
}

export interface WorkflowSummary {
  schema_version: "workflow-summary.v1";
  run_id: string;
  revision: number;
  updated_after_step: string;
  task_summary: string;
  completed_steps: WorkflowSummaryCompletedStep[];
  current_assumptions: string[];
  current_risks: string[];
  current_open_questions: string[];
  next_step_hint: string;
}

export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  input?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  status: "passed" | "failed";
  error: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface AdapterExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error: string | null;
  timedOut: boolean;
  externalSessionId: string | null;
}

export interface RepoSummary {
  schema_version: "repo-summary.v1";
  generated_at: string;
  readme: {
    path: string;
    excerpt: string;
  } | null;
  tree: string[];
  tree_truncated: boolean;
  config_files: Array<{
    path: string;
    bytes: number;
  }>;
  git_status: {
    available: boolean;
    output: string;
  };
}

export type TemplateId = "blank" | "generic-plan-review" | "feature-planning";

export interface Template {
  config: ProjectConfig;
  roles: Record<string, RoleConfig>;
  workflows: Record<string, WorkflowConfig>;
  adapters: Record<string, AdapterConfig>;
  examples: Record<string, RoleConfig | WorkflowConfig>;
}

export interface RunPlanStep {
  index: number;
  step_id: string;
  objective: string;
  role_id: string;
  role_name: string;
  adapter_id: string;
  adapter_type: AdapterType;
  role_write_policy: WritePolicyMode;
  output_schema: string;
}

export interface RunPlanAdapter {
  adapter_id: string;
  type: AdapterType;
  command: string;
  auth_mode: string;
  billing_mode: string;
  cost_tracking: string;
  budget_policy: string;
  write_policy_default: string;
  write_policy_enforcement: string;
}

export interface RunPlan {
  workflow_id: string;
  workflow_name: string;
  task_input: string;
  steps: RunPlanStep[];
  adapters: RunPlanAdapter[];
  context: {
    repo: string;
    sharing: string;
    mode: string;
  };
  budgets: {
    max_invocations: number;
    max_retries_per_step: number;
    max_duration_minutes: number;
    max_output_bytes: number;
    token_budget: string;
  };
  warnings: string[];
}

export interface RunArtifact {
  ref: string;
  type: string;
  exists: boolean;
  size: number | null;
  step_id?: string;
  attempt_id?: string;
}

export interface RunArtifactContent {
  ref: string;
  content: string;
  size: number;
}

export interface ConfigDiscoveryValidation {
  valid: boolean;
  errors: string[];
}

export interface WorkflowDiscoveryEntry {
  id: string;
  name: string;
  version: string;
  step_count: number;
  path: string;
  validation: ConfigDiscoveryValidation;
}

export interface RoleDiscoveryEntry {
  id: string;
  name: string;
  adapter_id: string;
  write_policy: string;
  path: string;
  validation: ConfigDiscoveryValidation;
}

export interface AdapterDiscoveryEntry {
  id: string;
  type: string;
  command: string;
  auth: string;
  billing: string;
  write_policy: string;
  path: string;
  validation: ConfigDiscoveryValidation;
}

export interface ConfigDetail<T> {
  id: string;
  path: string;
  config: T | null;
  validation: ConfigDiscoveryValidation;
}

export interface AdapterProbeCheck {
  name: string;
  status: "passed" | "failed";
  message?: string;
  resolved_command?: string;
  argv?: string[];
  exit_code?: number | null;
  duration_ms?: number;
  stdout?: string;
  stderr?: string;
  error?: string | null;
}

export interface AdapterProbeResult {
  adapter_id: string;
  adapter_type: AdapterType;
  ok: boolean;
  command: string;
  resolved_command: string | null;
  checks: AdapterProbeCheck[];
  auth?: AdapterConfig["auth"];
  billing?: AdapterConfig["billing"];
  write_policy?: AdapterConfig["write_policy"];
  notes?: string[];
}

export type RunEventType =
  | "run_created"
  | "run_started"
  | "repo_context_collected"
  | "workflow_summary_updated"
  | "step_started"
  | "attempt_started"
  | "adapter_invocation_started"
  | "adapter_invocation_completed"
  | "validation_started"
  | "validation_completed"
  | "self_correction_started"
  | "artifact_written"
  | "step_completed"
  | "step_failed"
  | "step_skipped"
  | "budget_exceeded"
  | "run_completed"
  | "run_failed";

export interface RunEvent {
  schema_version: "forgekit.run-event.v1";
  event_id: string;
  run_id: string;
  timestamp: string;
  type: RunEventType;
  message: string;
  data: JsonObject;
  step_id?: string;
  role_id?: string;
  adapter_id?: string;
  attempt_id?: string;
}
