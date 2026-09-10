import { createHash } from "node:crypto";
import type { ChallengeInfo, ChallengeKind, TcpEndpoint, TriageResult } from "./challenge-kind.ts";
import { invalidInput } from "./errors.ts";
import { SCHEMA_VERSION } from "../version.ts";
import { DEFAULT_MAX_CALLS, DEFAULT_MAX_TOKENS } from "./spec.ts";
import type { CampaignSpec } from "./types.ts";

export const KALI_FLAG_TOOLS = [
  "graph_query",
  "artifact_read",
  "submit_observation",
  "submit_fact",
  "submit_finding",
  "propose_plan",
  "propose_step",
  "finish_step",
  "finish_decision",
  "checkpoint",
  "kali_run",
  "kali_write",
  "playwright",
] as const;

export function looksLikeHttpUrl(raw: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(raw);
}

export function parseTargetUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw invalidInput("invalid_url", "target URL is required");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalidInput("invalid_url", `not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidInput("invalid_url", "URL must be http or https");
  }
  if (!url.hostname) {
    throw invalidInput("invalid_url", "URL must include a hostname");
  }
  return url;
}

export function campaignIdForTarget(url: URL): string {
  const host = url.hostname.toLowerCase();
  const labels = host.split(".").filter(Boolean);
  const head = labels[0] ?? "target";
  let base =
    /^[a-f0-9]{8,32}$/i.test(head) && labels.length >= 2
      ? `camp_${head}`
      : `camp_${host.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/") {
    const tail = createHash("sha256").update(path).digest("hex").slice(0, 6);
    base = `${base}-${tail}`;
  }
  return base.slice(0, 48);
}

/**
 * Deterministic id from the input name + path hash, so re-running resumes.
 * Case-folded only on case-insensitive filesystems (Windows/macOS); on Linux
 * "A.elf" and "a.elf" are different files and must not share a campaign id.
 */
export function campaignIdForInput(sourceName: string, absPath: string): string {
  const slug = sourceName
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "input";
  const norm = absPath.replace(/\\/g, "/");
  const key = process.platform === "win32" || process.platform === "darwin" ? norm.toLowerCase() : norm;
  return `camp_${slug}-${createHash("sha256").update(key).digest("hex").slice(0, 6)}`.slice(0, 48);
}

const KIND_LABEL: Record<string, string> = {
  reverse: "reverse engineering",
  pwn: "binary exploitation (pwn)",
  misc: "misc/forensics/steganography",
  crypto: "cryptography",
  generic: "general CTF",
};

export function buildInputFlagSpec(args: {
  provider: string;
  model: string;
  campaign_id: string;
  triage: TriageResult;
  /** Automatic classification before --kind override, when they differ. */
  detected_kind?: Exclude<ChallengeKind, "auto">;
  input: { source_name: string; files: number; total_bytes: number; sha256: string };
  endpoint?: TcpEndpoint;
  thinking_level?: CampaignSpec["model_policy"]["thinking_level"];
  /** Container-side workspace root in the prompt text. Defaults to /workspace;
   *  the contest shared container passes /workspace/<campaignId>. */
  container_root?: string;
}): CampaignSpec {
  if (!args.provider.startsWith("prv_")) {
    throw invalidInput("unknown_model", `unknown provider ${args.provider}`);
  }
  if (!args.model.trim()) throw invalidInput("unknown_model", "model is required");
  const { triage } = args;
  const label = KIND_LABEL[triage.kind] ?? "general CTF";
  const root = args.container_root ?? "/workspace";
  const endpointText = args.endpoint
    ? ` The remote service is reachable from inside the campaign container at tcp://${args.endpoint.host}:${args.endpoint.port} (use pwntools remote() or nc).`
    : "";
  const statement =
    `Authorized ${label} challenge. Challenge files are staged at ${root}/input/original ` +
    `(SHA-256 manifest at ${root}/input/manifest.json). Treat input/original as read-only; ` +
    `write scripts and scratch output to ${root}/work and final evidence to ${root}/artifacts.${endpointText} ` +
    `Recover the flag. When you have the flag, submit a fact with fact_key flag_recovered and the flag string in the proposition.`;
  const challenge: ChallengeInfo = {
    kind: triage.kind,
    overlay: triage.overlay,
    confidence: triage.confidence,
    evidence: triage.evidence.slice(0, 12),
    seed_method_family: triage.seed_method_family,
    input: args.input,
  };
  if (args.detected_kind && args.detected_kind !== triage.kind) challenge.detected_kind = args.detected_kind;
  if (args.endpoint) challenge.endpoint = `tcp://${args.endpoint.host}:${args.endpoint.port}`;
  return {
    campaign_id: args.campaign_id,
    schema_version: SCHEMA_VERSION,
    mode: "goal_seeking",
    root_goal: { statement, success_predicate_ref: "flag_recovered" },
    scope: {
      assets: args.endpoint ? [`${args.endpoint.host}:${args.endpoint.port}`] : [],
      workspace: "kali",
      identities: ["operator"],
      entries: args.endpoint ? [`tcp://${args.endpoint.host}:${args.endpoint.port}`] : [],
      exclusions: [],
      profile: "kali-lab",
    },
    policy_version: "p1-kali-1",
    scope_version: "s-input-1",
    goal_version: "g-flag-1",
    tool_allowlist: [...KALI_FLAG_TOOLS],
    execution_profile: "kali",
    model_policy: {
      provider: args.provider,
      model: args.model,
      thinking_level: args.thinking_level ?? "max",
      allow_retry: false,
      allow_model_fallback: false,
    },
    budget: {
      currency: "USD",
      price_version: "unknown",
      max_cost_micro: null,
      max_tokens: DEFAULT_MAX_TOKENS,
      max_calls: DEFAULT_MAX_CALLS,
      deadline_ms: null,
    },
    verification_policy: {
      require_independent_verify: true,
      oracle_id: "authorized-lab",
    },
    coverage_policy: {
      dimensions: ["asset", "method"],
      mandatory_ids: [triage.seed_method_family],
    },
    artifact_policy: {
      max_bytes: 2_000_000,
      retention_days: 7,
    },
    stop_policy: {
      max_empty_reviews_per_progress_epoch: 6,
      decide_debounce_ms: 0,
    },
    environment_revision: "env-1",
    challenge,
  };
}

export function buildKaliFlagSpec(args: {
  url: string;
  provider: string;
  model: string;
  campaign_id?: string;
  thinking_level?: CampaignSpec["model_policy"]["thinking_level"];
}): CampaignSpec {
  const url = parseTargetUrl(args.url);
  const href = url.toString();
  const campaign_id = args.campaign_id?.trim() || campaignIdForTarget(url);
  if (!campaign_id) throw invalidInput("missing_campaign_id", "campaign_id is required");
  if (!args.provider.startsWith("prv_")) {
    throw invalidInput("unknown_model", `unknown provider ${args.provider}`);
  }
  if (!args.model.trim()) throw invalidInput("unknown_model", "model is required");
  const thinking_level = args.thinking_level ?? "max";
  return {
    campaign_id,
    schema_version: SCHEMA_VERSION,
    mode: "goal_seeking",
    root_goal: {
      statement: `Authorized web challenge. Recover the flag from ${href}. Stay on that host. When you have the flag, submit a fact with fact_key flag_recovered and the flag string in the proposition.`,
      success_predicate_ref: "flag_recovered",
    },
    scope: {
      assets: [url.hostname, href],
      workspace: "kali",
      identities: ["operator"],
      entries: [href],
      exclusions: [],
      profile: "kali-lab",
    },
    policy_version: "p1-kali-1",
    scope_version: "s-quick-1",
    goal_version: "g-flag-1",
    tool_allowlist: [...KALI_FLAG_TOOLS],
    execution_profile: "kali",
    model_policy: {
      provider: args.provider,
      model: args.model,
      thinking_level,
      allow_retry: false,
      allow_model_fallback: false,
    },
    budget: {
      currency: "USD",
      price_version: "unknown",
      max_cost_micro: null,
      max_tokens: DEFAULT_MAX_TOKENS,
      max_calls: DEFAULT_MAX_CALLS,
      deadline_ms: null,
    },
    verification_policy: {
      require_independent_verify: true,
      oracle_id: "authorized-lab",
    },
    coverage_policy: {
      dimensions: ["asset", "method"],
      mandatory_ids: ["http-probe"],
    },
    artifact_policy: {
      max_bytes: 2_000_000,
      retention_days: 7,
    },
    stop_policy: {
      max_empty_reviews_per_progress_epoch: 6,
      decide_debounce_ms: 0,
    },
    environment_revision: "env-1",
  };
}
