import { SCHEMA_VERSION } from "../version.ts";
import { isChallengeKind, type ChallengeInfo, type TriageEvidence } from "./challenge-kind.ts";
import { invalidInput } from "./errors.ts";
import type { CampaignSpec, CampaignState } from "./types.ts";
import { parseHttpUrl } from "./url.ts";

export const DEFAULT_MAX_CALLS = 3000;
export const DEFAULT_MAX_TOKENS = 120_000_000;

export const ALLOWED_MODELS = new Set(["scripted", "scripted-react"]);
export const ALLOWED_STATES = new Set<CampaignState>([
  "created",
  "active",
  "waiting",
  "blocked",
  "plateau",
  "budget_paused",
  "paused",
  "awaiting_verify",
  "closing",
  "completed",
  "cancelled",
]);

export function validateCampaignSpec(input: unknown): CampaignSpec {
  if (input === null || typeof input !== "object") {
    throw invalidInput("spec_not_object", "CampaignSpec must be an object");
  }
  const raw = input as Record<string, unknown>;
  const campaign_id = requireString(raw, "campaign_id");
  const schema_version = requireInt(raw, "schema_version");
  if (schema_version !== SCHEMA_VERSION) {
    throw invalidInput("schema_version_mismatch", `schema_version must be ${SCHEMA_VERSION}`, {
      schema_version,
    });
  }
  const mode = requireString(raw, "mode");
  if (mode !== "goal_seeking" && mode !== "assessment") {
    throw invalidInput("unknown_mode", `unknown mode ${mode}`);
  }
  const root_goal_raw = raw.root_goal;
  if (!root_goal_raw || typeof root_goal_raw !== "object") {
    throw invalidInput("missing_root_goal", "root_goal is required");
  }
  const root_goal_obj = root_goal_raw as Record<string, unknown>;
  const statement = typeof root_goal_obj.statement === "string" ? root_goal_obj.statement.trim() : "";
  if (!statement) {
    throw invalidInput("missing_root_goal", "root_goal.statement is required");
  }
  const success_predicate_ref = requireString(root_goal_obj, "success_predicate_ref");

  const budgetRaw = requireObject(raw, "budget");
  const budget = {
    currency: optionalString(budgetRaw, "currency") ?? "USD",
    price_version: optionalString(budgetRaw, "price_version") ?? "unknown",
    max_cost_micro: optionalIntOrNull(budgetRaw, "max_cost_micro"),
    max_tokens: "max_tokens" in budgetRaw ? optionalIntOrNull(budgetRaw, "max_tokens") : DEFAULT_MAX_TOKENS,
    max_calls: "max_calls" in budgetRaw ? optionalIntOrNull(budgetRaw, "max_calls") : DEFAULT_MAX_CALLS,
    deadline_ms: optionalIntOrNull(budgetRaw, "deadline_ms"),
  };
  if (budget.max_cost_micro !== null && budget.max_cost_micro < 0) {
    throw invalidInput("negative_budget", "budget.max_cost_micro must be >= 0");
  }
  if (budget.max_tokens !== null && budget.max_tokens < 0) {
    throw invalidInput("negative_budget", "budget.max_tokens must be >= 0");
  }
  if (budget.max_calls !== null && budget.max_calls < 0) {
    throw invalidInput("negative_budget", "budget.max_calls must be >= 0");
  }
  if (
    budget.max_cost_micro === null &&
    budget.max_tokens === null &&
    budget.max_calls === null
  ) {
    throw invalidInput("no_hard_cap", "at least one of max_cost_micro, max_tokens, max_calls is required");
  }

  const model_policy_raw = requireObject(raw, "model_policy");
  const provider = requireString(model_policy_raw, "provider");
  const model = requireString(model_policy_raw, "model");
  if (provider === "scripted") {
    if (!ALLOWED_MODELS.has(model)) {
      throw invalidInput("unknown_model", `unknown model ${model}`);
    }
  } else if (!provider.startsWith("prv_")) {
    throw invalidInput("unknown_model", `unknown provider ${provider}`);
  }
  const thinking_level = optionalString(model_policy_raw, "thinking_level") ?? "high";
  if (!["low", "high", "max"].includes(thinking_level)) {
    throw invalidInput("unknown_thinking_level", `unknown thinking_level ${thinking_level}`);
  }

  const scopeRaw = requireObject(raw, "scope");
  const spec: CampaignSpec = {
    campaign_id,
    schema_version,
    mode,
    root_goal: { statement, success_predicate_ref },
    scope: {
      assets: stringArray(scopeRaw, "assets"),
      workspace: optionalString(scopeRaw, "workspace") ?? "synthetic",
      identities: stringArray(scopeRaw, "identities"),
      entries: stringArray(scopeRaw, "entries"),
      exclusions: stringArray(scopeRaw, "exclusions"),
      profile: optionalString(scopeRaw, "profile") ?? "synthetic",
    },
    policy_version: requireString(raw, "policy_version"),
    scope_version: requireString(raw, "scope_version"),
    goal_version: requireString(raw, "goal_version"),
    tool_allowlist: stringArray(raw, "tool_allowlist"),
    execution_profile: optionalString(raw, "execution_profile") ?? "synthetic",
    model_policy: {
      provider,
      model,
      thinking_level: thinking_level as CampaignSpec["model_policy"]["thinking_level"],
      allow_retry: Boolean(model_policy_raw.allow_retry),
      allow_model_fallback: Boolean(model_policy_raw.allow_model_fallback),
    },
    budget,
    verification_policy: (() => {
      const vp = requireObject(raw, "verification_policy");
      const policy: CampaignSpec["verification_policy"] = {
        require_independent_verify: Boolean(vp.require_independent_verify),
        oracle_id: optionalString(vp, "oracle_id") ?? "synthetic-oracle",
      };
      if (typeof vp.require_confirmed_findings === "boolean") {
        policy.require_confirmed_findings = vp.require_confirmed_findings;
      }
      return policy;
    })(),
    coverage_policy: (() => {
      const cp = requireObject(raw, "coverage_policy");
      const policy: CampaignSpec["coverage_policy"] = {
        dimensions: stringArray(cp, "dimensions"),
        mandatory_ids: stringArray(cp, "mandatory_ids"),
      };
      if (typeof cp.require_complete === "boolean") {
        policy.require_complete = cp.require_complete;
      }
      return policy;
    })(),
    artifact_policy: {
      max_bytes: optionalIntOrNull(requireObject(raw, "artifact_policy"), "max_bytes") ?? 1_000_000,
      retention_days: optionalIntOrNull(requireObject(raw, "artifact_policy"), "retention_days") ?? 30,
    },
    stop_policy: {
      max_empty_reviews_per_progress_epoch:
        optionalIntOrNull(requireObject(raw, "stop_policy"), "max_empty_reviews_per_progress_epoch") ?? 2,
      decide_debounce_ms: optionalIntOrNull(requireObject(raw, "stop_policy"), "decide_debounce_ms") ?? 0,
    },
    environment_revision: requireString(raw, "environment_revision"),
  };
  const challenge = parseChallengeInfo(raw.challenge);
  if (challenge) {
    // A declared live web target must be backed by an explicit scope entry;
    // the validator never widens scope on its own.
    if (challenge.web_url && !spec.scope.entries.includes(challenge.web_url)) {
      throw invalidInput(
        "invalid_challenge",
        "challenge.web_url must also be declared in scope.entries; the validator does not widen scope",
      );
    }
    spec.challenge = challenge;
  }
  return spec;
}

/** Optional --input metadata. Only kind and seed_method_family are load-bearing. */
function parseChallengeInfo(raw: unknown): ChallengeInfo | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidInput("invalid_challenge", "challenge must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const kindRaw = requireString(obj, "kind");
  if (!isChallengeKind(kindRaw) || kindRaw === "auto") {
    throw invalidInput("invalid_challenge", `challenge.kind must be one of web|reverse|pwn|misc|crypto|generic, got ${kindRaw}`);
  }
  const kind = kindRaw as ChallengeInfo["kind"];
  const out: ChallengeInfo = {
    kind,
    seed_method_family: optionalString(obj, "seed_method_family") ?? "ctf-triage",
  };
  const detected = optionalString(obj, "detected_kind");
  if (detected && isChallengeKind(detected) && detected !== "auto") out.detected_kind = detected;
  const overlay = optionalString(obj, "overlay");
  if (overlay) out.overlay = overlay as ChallengeInfo["overlay"];
  const confidence = optionalString(obj, "confidence");
  if (confidence === "high" || confidence === "medium" || confidence === "low") out.confidence = confidence;
  if (Array.isArray(obj.evidence)) {
    const sources = new Set(["user", "magic", "container", "header", "text"]);
    out.evidence = obj.evidence
      .filter(
        (e): e is TriageEvidence =>
          Boolean(e && typeof e === "object") &&
          typeof (e as TriageEvidence).value === "string" &&
          sources.has(String((e as TriageEvidence).source)),
      )
      .map((e) => ({ source: e.source, value: e.value, weight: Number(e.weight ?? 0) }));
  }
  if (obj.input && typeof obj.input === "object") {
    const inp = obj.input as Record<string, unknown>;
    out.input = {
      source_name: optionalString(inp, "source_name") ?? "input",
      files: optionalIntOrNull(inp, "files") ?? 0,
      total_bytes: optionalIntOrNull(inp, "total_bytes") ?? 0,
      sha256: optionalString(inp, "sha256") ?? "",
    };
  }
  const endpoint = optionalString(obj, "endpoint");
  if (endpoint) out.endpoint = endpoint;
  const webUrl = optionalString(obj, "web_url");
  if (webUrl !== undefined) {
    if (webUrl.trim() === "") {
      throw invalidInput("invalid_challenge", "challenge.web_url must not be blank");
    }
    try {
      out.web_url = parseHttpUrl(webUrl).toString();
    } catch (err) {
      throw invalidInput(
        "invalid_challenge",
        `challenge.web_url is not a valid http(s) URL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw invalidInput(`missing_${key}`, `${key} is required`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalidInput(`invalid_${key}`, `${key} must be a string`);
  return v;
}

function requireInt(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw invalidInput(`invalid_${key}`, `${key} must be an integer`);
  }
  return v;
}

function optionalIntOrNull(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw invalidInput(`invalid_${key}`, `${key} must be an integer`);
  }
  return v;
}

function requireObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw invalidInput(`missing_${key}`, `${key} is required`);
  }
  return v as Record<string, unknown>;
}

function stringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw invalidInput(`invalid_${key}`, `${key} must be a string array`);
  }
  return v as string[];
}
