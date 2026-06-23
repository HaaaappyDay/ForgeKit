import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { ForgeKitError } from "./errors.js";
import { isNodeErrorCode } from "./node-error.js";
import { isAgenticRun, readAnyRun, runRoot } from "./run-store.js";
import type { AgenticRun, RunArtifact, RunArtifactContent } from "./types.js";

interface ArtifactCandidate {
  ref: string;
  type: string;
  step_id?: string;
  node_id?: string;
  attempt_id?: string;
  optional?: boolean;
}

function uniqueCandidates(candidates: ArtifactCandidate[]): ArtifactCandidate[] {
  const seen = new Set<string>();
  const unique: ArtifactCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.ref}:${candidate.step_id ?? ""}:${candidate.node_id ?? ""}:${candidate.attempt_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function safeArtifactPath(projectRoot: string, runId: string, ref: string): string {
  if (!ref || ref.startsWith("/") || ref.includes("\0")) {
    throw new ForgeKitError({
      code: "artifact_not_found",
      message: `Invalid artifact ref: ${ref}`,
      category: "artifact",
      retryable: false,
      details: { run_id: runId, ref }
    });
  }

  const root = resolve(runRoot(projectRoot, runId));
  const path = resolve(root, ref);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new ForgeKitError({
      code: "artifact_not_found",
      message: `Invalid artifact ref: ${ref}`,
      category: "artifact",
      retryable: false,
      details: { run_id: runId, ref }
    });
  }
  return path;
}

async function artifactFromCandidate(
  projectRoot: string,
  runId: string,
  candidate: ArtifactCandidate
): Promise<RunArtifact | null> {
  const path = safeArtifactPath(projectRoot, runId, candidate.ref);
  try {
    const file = await stat(path);
    return {
      ref: candidate.ref,
      type: candidate.type,
      exists: true,
      size: file.size,
      ...(candidate.step_id ? { step_id: candidate.step_id } : {}),
      ...(candidate.node_id ? { node_id: candidate.node_id } : {}),
      ...(candidate.attempt_id ? { attempt_id: candidate.attempt_id } : {})
    };
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
    if (candidate.optional) return null;
    return {
      ref: candidate.ref,
      type: candidate.type,
      exists: false,
      size: null,
      ...(candidate.step_id ? { step_id: candidate.step_id } : {}),
      ...(candidate.node_id ? { node_id: candidate.node_id } : {}),
      ...(candidate.attempt_id ? { attempt_id: candidate.attempt_id } : {})
    };
  }
}

function agenticArtifactCandidates(run: AgenticRun): ArtifactCandidate[] {
  const candidates: ArtifactCandidate[] = [];
  for (const node of run.nodes) {
    for (const attempt of node.attempts) {
      const context = { node_id: node.node_id, attempt_id: attempt.attempt_id };
      candidates.push(
        { ref: attempt.prompt_ref, type: "prompt", ...context },
        { ref: attempt.stdout_ref, type: "stdout", ...context },
        { ref: attempt.stderr_ref, type: "stderr", ...context },
        { ref: attempt.validation_ref, type: "validation", ...context }
      );
      if (attempt.handoff_ref) candidates.push({ ref: attempt.handoff_ref, type: "handoff", ...context });
      if (attempt.markdown_ref) candidates.push({ ref: attempt.markdown_ref, type: "markdown", ...context });

      const attemptDir = dirname(attempt.prompt_ref);
      candidates.push(
        { ref: `${attemptDir}/correction-prompt.md`, type: "correction_prompt", optional: true, ...context },
        { ref: `${attemptDir}/correction-raw.log`, type: "correction_stdout", optional: true, ...context },
        { ref: `${attemptDir}/correction-error.log`, type: "correction_stderr", optional: true, ...context }
      );
      if (attempt.phase === "verification") {
        candidates.push({ ref: `${attemptDir}/verdict.json`, type: "acceptance_verdict", optional: true, ...context });
      }
    }
  }
  return candidates;
}

export async function listRunArtifacts(runId: string, projectRoot = process.cwd()): Promise<RunArtifact[]> {
  const run = await readAnyRun(projectRoot, runId);
  const candidates: ArtifactCandidate[] = [
    { ref: "summary.md", type: "summary" },
    { ref: "context/repo-summary.json", type: "repo_context" },
    { ref: "context/workflow-summary.json", type: "workflow_summary", optional: isAgenticRun(run) },
    { ref: "events.jsonl", type: "run_events", optional: true }
  ];

  if (isAgenticRun(run)) {
    candidates.push(...agenticArtifactCandidates(run));
  } else {
    for (const step of run.steps) {
      for (const attempt of step.attempts) {
        const context = {
          step_id: step.step_id,
          attempt_id: attempt.attempt_id
        };
        candidates.push(
          { ref: attempt.prompt_ref, type: "prompt", ...context },
          { ref: attempt.stdout_ref, type: "stdout", ...context },
          { ref: attempt.stderr_ref, type: "stderr", ...context },
          { ref: attempt.validation_ref, type: "validation", ...context }
        );
        if (attempt.handoff_ref) candidates.push({ ref: attempt.handoff_ref, type: "handoff", ...context });
        if (attempt.markdown_ref) candidates.push({ ref: attempt.markdown_ref, type: "markdown", ...context });

        const attemptDir = dirname(attempt.prompt_ref);
        candidates.push(
          { ref: `${attemptDir}/correction-prompt.md`, type: "correction_prompt", optional: true, ...context },
          { ref: `${attemptDir}/correction-raw.log`, type: "correction_stdout", optional: true, ...context },
          { ref: `${attemptDir}/correction-error.log`, type: "correction_stderr", optional: true, ...context }
        );
      }
    }
  }

  const artifacts: RunArtifact[] = [];
  for (const candidate of uniqueCandidates(candidates)) {
    const artifact = await artifactFromCandidate(projectRoot, runId, candidate);
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

export async function readRunArtifact(
  runId: string,
  artifactRef: string,
  projectRoot = process.cwd()
): Promise<RunArtifactContent> {
  const path = safeArtifactPath(projectRoot, runId, artifactRef);
  try {
    const content = await readFile(path, "utf8");
    return {
      ref: artifactRef,
      content,
      size: Buffer.byteLength(content, "utf8")
    };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ForgeKitError({
        code: "artifact_not_found",
        message: `Artifact not found: ${artifactRef}`,
        category: "artifact",
        retryable: false,
        details: { run_id: runId, ref: artifactRef }
      });
    }
    throw error;
  }
}
