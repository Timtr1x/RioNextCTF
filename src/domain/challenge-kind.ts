/**
 * CTF challenge classification shared by the CLI, triage, tool allowlists and
 * the Execute skill loader. Pure data: no IO, no docker, no model calls.
 */
import { invalidInput } from "./errors.ts";

export const CHALLENGE_KINDS = ["auto", "web", "reverse", "pwn", "misc", "crypto", "generic"] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

export function isChallengeKind(raw: string): raw is ChallengeKind {
  return (CHALLENGE_KINDS as readonly string[]).includes(raw);
}

/** Evidence gathered by the deterministic triage. Never from running the sample. */
export interface TriageEvidence {
  source: "user" | "magic" | "container" | "header" | "text";
  value: string;
  weight: number;
}

export type TriageOverlay = "apk" | "dotnet" | "protocol" | "stego" | "forensics";

export interface TriageResult {
  kind: Exclude<ChallengeKind, "auto">;
  overlay?: TriageOverlay;
  confidence: "high" | "medium" | "low";
  evidence: TriageEvidence[];
  /** method_family of the step seeded for this input. */
  seed_method_family: string;
}

/**
 * method_family -> prompts/skills/<file>. Families not listed here (http-probe
 * and anything a Web campaign proposes) get no skill text.
 */
export const SKILL_BY_METHOD_FAMILY: Record<string, string> = {
  "reverse-native": "reverse-native.txt",
  "pwn-chain": "pwn-chain.txt",
  "apk-reverse": "apk-reverse.txt",
  "dotnet-reverse": "dotnet-reverse.txt",
  "protocol-pcap": "protocol-pcap.txt",
  "ctf-misc": "ctf-misc.txt",
  "ctf-crypto": "ctf-crypto.txt",
  "ctf-triage": "ctf-triage.txt",
};

/** Default seed family when the user forces --kind. */
export function seedFamilyForKind(kind: Exclude<ChallengeKind, "auto">, overlay?: TriageOverlay): string {
  switch (kind) {
    case "web":
      return "http-probe";
    case "reverse":
      if (overlay === "apk") return "apk-reverse";
      if (overlay === "dotnet") return "dotnet-reverse";
      return "reverse-native";
    case "pwn":
      return "pwn-chain";
    case "misc":
      return overlay === "protocol" ? "protocol-pcap" : "ctf-misc";
    case "crypto":
      return "ctf-crypto";
    case "generic":
      return "ctf-triage";
  }
}

/** An explicit --kind always wins over the automatic classification. */
export function applyKindOverride(detected: TriageResult, requested: ChallengeKind | undefined): TriageResult {
  if (!requested || requested === "auto") return detected;
  if (requested === detected.kind) return detected;
  return {
    kind: requested,
    confidence: "high",
    evidence: [{ source: "user", value: `--kind ${requested}`, weight: 99 }],
    seed_method_family: seedFamilyForKind(requested),
  };
}

/** Persisted on CampaignSpec. Triage runs once; resume reuses this record. */
export interface ChallengeInfo {
  kind: Exclude<ChallengeKind, "auto">;
  detected_kind?: Exclude<ChallengeKind, "auto">;
  overlay?: TriageOverlay;
  confidence?: "high" | "medium" | "low";
  evidence?: TriageEvidence[];
  seed_method_family: string;
  input?: {
    source_name: string;
    files: number;
    total_bytes: number;
    sha256: string;
  };
  endpoint?: string;
}

export interface TcpEndpoint {
  host: string;
  port: number;
}

/** Accepts tcp://host:port or bare host:port. Rejects anything else. */
export function parseTcpEndpoint(raw: string): TcpEndpoint {
  const text = raw.trim();
  const m = text.match(/^(?:tcp:\/\/)?([A-Za-z0-9.-]+):(\d{1,5})$/);
  if (!m) {
    throw invalidInput("invalid_endpoint", `expected tcp://host:port, got ${raw}`);
  }
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidInput("invalid_endpoint", `port out of range in ${raw}`);
  }
  return { host: m[1]!.toLowerCase(), port };
}
