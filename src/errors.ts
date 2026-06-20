import { isNodeErrorCode } from "./node-error.js";
import type { JsonObject } from "./types.js";

export type ForgeKitErrorCode =
  | "config_missing"
  | "config_invalid"
  | "workflow_invalid"
  | "role_missing"
  | "adapter_missing"
  | "adapter_command_not_found"
  | "adapter_process_failed"
  | "adapter_timeout"
  | "handoff_parse_failed"
  | "handoff_schema_invalid"
  | "handoff_content_invalid"
  | "run_not_found"
  | "run_not_retryable"
  | "artifact_not_found";

export type ForgeKitErrorCategory =
  | "config"
  | "workflow"
  | "role"
  | "adapter"
  | "handoff"
  | "run"
  | "artifact";

export interface ForgeKitErrorShape {
  code: ForgeKitErrorCode;
  message: string;
  category: ForgeKitErrorCategory;
  retryable: boolean;
  details: JsonObject;
}

export class ForgeKitError extends Error {
  readonly code: ForgeKitErrorCode;
  readonly category: ForgeKitErrorCategory;
  readonly retryable: boolean;
  readonly details: JsonObject;

  constructor(error: ForgeKitErrorShape) {
    super(error.message);
    this.name = "ForgeKitError";
    this.code = error.code;
    this.category = error.category;
    this.retryable = error.retryable;
    this.details = error.details;
  }

  toJSON(): ForgeKitErrorShape {
    return {
      code: this.code,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      details: this.details
    };
  }
}

export function toForgeKitError(error: unknown): ForgeKitError {
  if (error instanceof ForgeKitError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (isNodeErrorCode(error, "ENOENT") && message.includes(".forgekit/config.json")) {
    return new ForgeKitError({
      code: "config_missing",
      message: "ForgeKit config not found.",
      category: "config",
      retryable: false,
      details: {}
    });
  }

  if (message.includes("Command not found or not executable")) {
    return new ForgeKitError({
      code: "adapter_command_not_found",
      message,
      category: "adapter",
      retryable: false,
      details: {}
    });
  }

  if (message.includes("timed out")) {
    return new ForgeKitError({
      code: "adapter_timeout",
      message,
      category: "adapter",
      retryable: true,
      details: {}
    });
  }

  if (message.startsWith("Only failed runs can be retried") || message.includes("has no failed step")) {
    return new ForgeKitError({
      code: "run_not_retryable",
      message,
      category: "run",
      retryable: false,
      details: {}
    });
  }

  if (message.startsWith("Artifact not found") || message.startsWith("Invalid artifact ref")) {
    return new ForgeKitError({
      code: "artifact_not_found",
      message,
      category: "artifact",
      retryable: false,
      details: {}
    });
  }

  if (message.startsWith("Unknown role id")) {
    return new ForgeKitError({
      code: "role_missing",
      message,
      category: "role",
      retryable: false,
      details: {}
    });
  }

  if (message.startsWith("Unknown adapter id")) {
    return new ForgeKitError({
      code: "adapter_missing",
      message,
      category: "adapter",
      retryable: false,
      details: {}
    });
  }

  if (message.includes("MVP-0 supports only linear workflows") || message.includes("Invalid forgekit.workflow.v1")) {
    return new ForgeKitError({
      code: "workflow_invalid",
      message,
      category: "workflow",
      retryable: false,
      details: {}
    });
  }

  if (message.includes("Invalid forgekit.config.v1") || message.includes("Invalid forgekit.role.v1") || message.includes("Invalid forgekit.adapter.v1")) {
    return new ForgeKitError({
      code: "config_invalid",
      message,
      category: "config",
      retryable: false,
      details: {}
    });
  }

  return new ForgeKitError({
    code: "config_invalid",
    message,
    category: "config",
    retryable: false,
    details: {}
  });
}

export function errorResponse(error: unknown): { ok: false; error: ForgeKitErrorShape } {
  return {
    ok: false,
    error: toForgeKitError(error).toJSON()
  };
}
