import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateCampaignSpec } from "../domain/spec.ts";
import { invalidInput } from "../domain/errors.ts";
import type { CampaignSpec } from "../domain/types.ts";
import { PI_COMMIT, PI_DECLARED_VERSION, SCHEMA_VERSION, TYPEBOX_VERSION } from "../version.ts";
import { DEFAULT_FINALIZATION, type FinalizationConfig } from "./finalization.ts";

export interface RuntimeConfig {
  data_dir: string;
  db_path: string;
  artifact_root: string;
  instance_id: string;
  max_concurrent_decide_per_campaign: 1;
  /** Host-level cap on simultaneously active execute runs this process drives. */
  max_concurrent_execute: number;
  /** Host-level cap on in-flight provider streams (contest slots x workers). */
  max_inflight_model_calls: number;
  pi_tool_execution: "sequential";
  max_decide_turns: number;
  max_execute_turns_per_run: number;
  max_tool_calls_per_run: number;
  max_transient_retries_per_invocation: number;
  max_new_steps_per_decision: number;
  max_active_frontier_items: number;
  lease_ttl_ms: number;
  /** Task-run lease: short on purpose. A live worker renews it every heartbeat_ms,
   *  so a crashed process stops renewing and recoverStaleRuns can reclaim the run
   *  within ~run_lease_ms instead of waiting out the controller-lock TTL. */
  run_lease_ms: number;
  heartbeat_ms: number;
  tool_preview_limit: number;
  automatic_model_fallback: false;
  automatic_extension_loading: false;
  finalization: FinalizationConfig;
}

export const DEFAULT_RUNTIME: Omit<RuntimeConfig, "data_dir" | "db_path" | "artifact_root" | "instance_id"> = {
  max_concurrent_decide_per_campaign: 1,
  max_concurrent_execute: 1,
  max_inflight_model_calls: 8,
  pi_tool_execution: "sequential",
  max_decide_turns: 18,
  max_execute_turns_per_run: 72,
  max_tool_calls_per_run: 144,
  max_transient_retries_per_invocation: 2,
  max_new_steps_per_decision: 8,
  max_active_frontier_items: 64,
  lease_ttl_ms: 60 * 60_000,
  run_lease_ms: 2 * 60_000,
  heartbeat_ms: 20_000,
  tool_preview_limit: 50_000,
  automatic_model_fallback: false,
  automatic_extension_loading: false,
  finalization: { ...DEFAULT_FINALIZATION },
};

export function makeRuntimeConfig(dataDir: string, instanceId = `proc-${randomUUID()}`): RuntimeConfig {
  return {
    ...DEFAULT_RUNTIME,
    finalization: { ...DEFAULT_FINALIZATION },
    data_dir: dataDir,
    db_path: `${dataDir.replace(/\\/g, "/")}/rionext.sqlite`,
    artifact_root: `${dataDir.replace(/\\/g, "/")}/artifacts`,
    instance_id: instanceId,
  };
}

export function applyFinalizationFlags(
  runtime: RuntimeConfig,
  flags: Record<string, string | boolean> = {},
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  if (flags.finalization && flags["no-finalization"]) {
    throw invalidInput(
      "finalization_flag_conflict",
      "--finalization and --no-finalization cannot be used together",
    );
  }

  if (flags["no-finalization"] === true) {
    runtime.finalization.enabled = false;
  } else if (flags.finalization === true) {
    runtime.finalization.enabled = true;
  } else if (env.RIONEXT_FINALIZATION === "0") {
    runtime.finalization.enabled = false;
  } else if (env.RIONEXT_FINALIZATION === "1") {
    runtime.finalization.enabled = true;
  }

  return runtime;
}

export function applyExecuteLimitFlags(
  runtime: RuntimeConfig,
  flags: Record<string, string | boolean> = {},
): RuntimeConfig {
  const turns = parsePositiveIntFlag(flags, "max-execute-turns");
  if (turns != null) runtime.max_execute_turns_per_run = turns;
  const tools = parsePositiveIntFlag(flags, "max-tool-calls");
  if (tools != null) runtime.max_tool_calls_per_run = tools;
  return runtime;
}

/** Fields a data-dir runtime.json may carry. Secrets never belong there. */
const RUNTIME_FILE_KEYS = ["max_concurrent_execute", "max_inflight_model_calls"] as const;

function parsePositiveIntValue(raw: unknown, source: string, key: string): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw invalidInput(key, `${source}: ${key} must be a positive safe integer, got ${String(raw)}`);
  }
  return n;
}

/**
 * The single runtime-config resolution every entry point (CLI run/ui/contest,
 * web EngineHost) shares (H05 §7.3). Priority: explicit CLI flags >
 * environment > <dataDir>/runtime.json > DEFAULT_RUNTIME. Unknown runtime.json
 * keys, broken JSON, and illegal values all fail loudly — never silently fall
 * back to 1.
 */
export function resolveRuntimeConfig(
  dataDir: string,
  flags: Record<string, string | boolean> = {},
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const cfg = makeRuntimeConfig(dataDir);
  const filePath = join(dataDir, "runtime.json");
  if (existsSync(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw invalidInput("runtime_config", `runtime.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidInput("runtime_config", "runtime.json must be a JSON object");
    }
    for (const key of Object.keys(parsed as Record<string, unknown>)) {
      if (!(RUNTIME_FILE_KEYS as readonly string[]).includes(key)) {
        throw invalidInput("runtime_config", `runtime.json key not allowed: ${key} (allowed: ${RUNTIME_FILE_KEYS.join(", ")})`);
      }
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.max_concurrent_execute != null) {
      cfg.max_concurrent_execute = parsePositiveIntValue(obj.max_concurrent_execute, "runtime.json", "max_concurrent_execute");
    }
    if (obj.max_inflight_model_calls != null) {
      cfg.max_inflight_model_calls = parsePositiveIntValue(obj.max_inflight_model_calls, "runtime.json", "max_inflight_model_calls");
    }
  }
  if (env.RIONEXT_MAX_CONCURRENT_EXECUTE != null && env.RIONEXT_MAX_CONCURRENT_EXECUTE !== "") {
    cfg.max_concurrent_execute = parsePositiveIntValue(env.RIONEXT_MAX_CONCURRENT_EXECUTE, "RIONEXT_MAX_CONCURRENT_EXECUTE", "max_concurrent_execute");
  }
  if (env.RIONEXT_MAX_INFLIGHT_MODEL_CALLS != null && env.RIONEXT_MAX_INFLIGHT_MODEL_CALLS !== "") {
    cfg.max_inflight_model_calls = parsePositiveIntValue(env.RIONEXT_MAX_INFLIGHT_MODEL_CALLS, "RIONEXT_MAX_INFLIGHT_MODEL_CALLS", "max_inflight_model_calls");
  }
  const flagExecute = parsePositiveIntFlag(flags, "max-concurrent-execute");
  if (flagExecute != null) cfg.max_concurrent_execute = flagExecute;
  const flagModel = parsePositiveIntFlag(flags, "max-inflight-model-calls");
  if (flagModel != null) cfg.max_inflight_model_calls = flagModel;
  return cfg;
}

/** The requested per-campaign worker count: spec.execution_policy. 1-8. */
export function parseWorkersFlag(flags: Record<string, string | boolean>): number | null {
  if (!("workers" in flags)) return null;
  const raw = flags.workers;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > 8) {
    throw invalidInput("workers", `--workers must be an integer between 1 and 8, got ${String(raw)}`);
  }
  return n;
}

function parsePositiveIntFlag(flags: Record<string, string | boolean>, key: string): number | null {
  if (!(key in flags)) return null;
  const raw = flags[key];
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw invalidInput(key.replaceAll("-", "_"), `--${key} must be an integer >= 1`);
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw invalidInput(key.replaceAll("-", "_"), `--${key} must be an integer >= 1`);
  }
  return n;
}

export function validateStartupInput(spec: unknown, runtime: RuntimeConfig): CampaignSpec {
  if (runtime.pi_tool_execution !== "sequential") {
    throw invalidInput("tool_execution", "P0 requires sequential toolExecution");
  }
  if (!Number.isInteger(runtime.max_concurrent_execute) || runtime.max_concurrent_execute < 1) {
    throw invalidInput("execute_slot", "max_concurrent_execute must be an integer >= 1");
  }
  if (!Number.isInteger(runtime.max_inflight_model_calls) || runtime.max_inflight_model_calls < 1) {
    throw invalidInput("inflight_model_calls", "max_inflight_model_calls must be an integer >= 1");
  }
  if (runtime.automatic_model_fallback) {
    throw invalidInput("model_fallback", "automatic model fallback is disabled");
  }
  return validateCampaignSpec(spec);
}

export function configFingerprint(runtime: RuntimeConfig): Record<string, unknown> {
  return {
    node: process.version,
    pi_commit: PI_COMMIT,
    pi_version: PI_DECLARED_VERSION,
    typebox: TYPEBOX_VERSION,
    schema_version: SCHEMA_VERSION,
    pi_tool_execution: runtime.pi_tool_execution,
    max_concurrent_execute: runtime.max_concurrent_execute,
    max_concurrent_decide_per_campaign: runtime.max_concurrent_decide_per_campaign,
    model_fallback: runtime.automatic_model_fallback,
    instance_id: runtime.instance_id,
    db_path: runtime.db_path,
    artifact_root: runtime.artifact_root,
  };
}

export function printStartupBanner(runtime: RuntimeConfig, log: (s: string) => void = console.log): void {
  const fp = configFingerprint(runtime);
  log(`rionext start ${JSON.stringify(fp)}`);
}
