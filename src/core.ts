import { probeAdapter as probeAdapterConfig } from "./adapters/probe.js";
import {
  getAdapter as getAdapterConfig,
  getRole as getRoleConfig,
  getWorkflow as getWorkflowConfig,
  listAdapters as listAdapterConfigs,
  listRoles as listRoleConfigs,
  listWorkflows as listWorkflowConfigs
} from "./config-discovery.js";
import { loadRunHistory } from "./history-command.js";
import { loadAdapterConfig } from "./project-config.js";
import { buildRunPlan } from "./run-plan.js";
import { readRun } from "./run-store.js";
import { listRunArtifacts, readRunArtifact as readRunArtifactContent } from "./run-artifacts.js";
import { retryWorkflow, runWorkflow } from "./workflow-runner.js";
import type {
  AdapterConfig,
  AdapterDiscoveryEntry,
  AdapterProbeResult,
  ConfigDetail,
  RoleConfig,
  RoleDiscoveryEntry,
  Run,
  RunArtifact,
  RunArtifactContent,
  RunPlan,
  WorkflowConfig,
  WorkflowDiscoveryEntry
} from "./types.js";
import type { RunEventObserver, RunEventSink } from "./run-events.js";

export interface CoreProjectOptions {
  projectRoot?: string;
}

export interface StartWorkflowRunOptions extends CoreProjectOptions {
  workflowId: string;
  taskInput: string;
  env?: NodeJS.ProcessEnv;
  eventObservers?: RunEventObserver[];
  eventSinks?: RunEventSink[];
  writeEventsJsonl?: boolean;
}

export interface RetryRunOptions extends CoreProjectOptions {
  runId: string;
  env?: NodeJS.ProcessEnv;
  eventObservers?: RunEventObserver[];
  eventSinks?: RunEventSink[];
  writeEventsJsonl?: boolean;
}

export interface BuildWorkflowRunPlanOptions extends CoreProjectOptions {
  workflowId: string;
  taskInput: string;
}

export async function startWorkflowRun(options: StartWorkflowRunOptions): Promise<Run> {
  return runWorkflow(options);
}

export async function retryRun(options: RetryRunOptions): Promise<Run> {
  return retryWorkflow(options);
}

export async function buildWorkflowRunPlan(options: BuildWorkflowRunPlanOptions): Promise<RunPlan> {
  return buildRunPlan(options);
}

export async function getRunSnapshot(runId: string, projectRoot = process.cwd()): Promise<Run> {
  return readRun(projectRoot, runId);
}

export async function listRuns(projectRoot = process.cwd()): Promise<Run[]> {
  return loadRunHistory(projectRoot);
}

export async function getRunArtifacts(runId: string, projectRoot = process.cwd()): Promise<RunArtifact[]> {
  return listRunArtifacts(runId, projectRoot);
}

export async function readRunArtifact(
  runId: string,
  artifactRef: string,
  projectRoot = process.cwd()
): Promise<RunArtifactContent> {
  return readRunArtifactContent(runId, artifactRef, projectRoot);
}

export async function listWorkflows(projectRoot = process.cwd()): Promise<WorkflowDiscoveryEntry[]> {
  return listWorkflowConfigs(projectRoot);
}

export async function getWorkflow(id: string, projectRoot = process.cwd()): Promise<ConfigDetail<WorkflowConfig>> {
  return getWorkflowConfig(id, projectRoot);
}

export async function listRoles(projectRoot = process.cwd()): Promise<RoleDiscoveryEntry[]> {
  return listRoleConfigs(projectRoot);
}

export async function getRole(id: string, projectRoot = process.cwd()): Promise<ConfigDetail<RoleConfig>> {
  return getRoleConfig(id, projectRoot);
}

export async function listAdapters(projectRoot = process.cwd()): Promise<AdapterDiscoveryEntry[]> {
  return listAdapterConfigs(projectRoot);
}

export async function getAdapter(id: string, projectRoot = process.cwd()): Promise<ConfigDetail<AdapterConfig>> {
  return getAdapterConfig(id, projectRoot);
}

export async function probeAdapter(id: string, projectRoot = process.cwd()): Promise<AdapterProbeResult> {
  const { adapter } = await loadAdapterConfig(id, projectRoot);
  return probeAdapterConfig(adapter, { cwd: projectRoot });
}
