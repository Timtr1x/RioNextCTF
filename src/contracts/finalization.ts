import type { CoverageResultItem, TaskOutcome, TaskOutcomeReason, VerificationResult, WakeCondition } from "../domain/types.ts";

export type WorkerPhase = "primary" | "finalizing" | "settled";

export type PrimaryStopTrigger =
  | "finish_committed"
  | "natural_stop"
  | "turn_cap"
  | "tool_cap"
  | "budget_exhausted"
  | "deadline"
  | "cancelled"
  | "stale_fence"
  | "model_error"
  | "aborted"
  | "runtime_error";

export type ModelStepDisposition = "resolved" | "deferred" | "blocked";

export interface FinishStepInput {
  disposition: ModelStepDisposition;
  summary: string;
  evidence_refs: string[];
  blocked_on?: string;
  reopen_condition?: string;
  reopen_rule?: WakeCondition;
  next_action?: string;
  /** Verify runs only: an explicit verdict on the step's target. */
  verification_result?: VerificationResult;
  /** Assessment runs only: explicit per-obligation results (max 8). */
  coverage_result?: CoverageResultItem[];
}

export function parseCoverageResults(raw: unknown): CoverageResultItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CoverageResultItem[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (typeof p.coverage_id !== "string" || !p.coverage_id) continue;
    if (!["no_issue_observed", "suspected", "confirmed", "inconclusive"].includes(String(p.outcome))) continue;
    const evidence_refs = Array.isArray(p.evidence_refs) ? p.evidence_refs.filter((x): x is string => typeof x === "string") : [];
    out.push({
      coverage_id: p.coverage_id,
      outcome: p.outcome as CoverageResultItem["outcome"],
      evidence_refs: evidence_refs.slice(0, 32),
      note: typeof p.note === "string" ? p.note.slice(0, 1000) : "",
    });
  }
  return out;
}

export function parseVerificationResult(raw: unknown): VerificationResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.target_id !== "string" || !p.target_id) return undefined;
  if (p.verdict !== "confirmed" && p.verdict !== "refuted" && p.verdict !== "inconclusive") return undefined;
  const evidence_refs = Array.isArray(p.evidence_refs) ? p.evidence_refs.filter((x): x is string => typeof x === "string") : [];
  const rationale = typeof p.rationale === "string" ? p.rationale.slice(0, 4000) : "";
  return { target_id: p.target_id, verdict: p.verdict, evidence_refs: evidence_refs.slice(0, 32), rationale };
}

export interface FinishPayload extends FinishStepInput {
  submission_id: string;
  observation_ids: string[];
  fact_ids: string[];
  finding_ids: string[];
  source: "primary" | "finalizer";
}

export interface SubmitRunOutcomeArgs {
  campaign_id: string;
  run_id: string;
  fence: number;
  submission_id: string;
  payload: FinishStepInput;
  observation_ids: string[];
  fact_ids: string[];
  finding_ids: string[];
  source: "primary" | "finalizer";
}

export interface SubmitRunOutcomeResult {
  accepted: boolean;
  duplicate: boolean;
  conflict: boolean;
  outcome: TaskOutcome | null;
  error?: string;
}

export interface FinalizeContext {
  run_id: string;
  step_id: string;
  stop_trigger: "natural_stop" | "turn_cap" | "tool_cap";
  step: {
    question: string;
    completion_criteria: string;
    expected_observations: string[];
  };
  submitted: {
    observation_ids: string[];
    fact_ids: string[];
    finding_ids: string[];
    artifact_ids: string[];
  };
  last_checkpoint: null | { note: string; next: string | null };
  last_assistant_text: string;
  last_tool_results: Array<{
    name: string;
    is_error: boolean;
    preview: string;
    artifact_id?: string;
  }>;
}

export interface FinalizationConfig {
  enabled: boolean;
  max_attempts: 1;
  max_output_tokens: number;
  transcript_tail_chars: number;
  tool_result_tail_count: number;
}

export const DEFAULT_FINALIZATION: FinalizationConfig = {
  enabled: true,
  max_attempts: 1,
  max_output_tokens: 12800,
  transcript_tail_chars: 4000,
  tool_result_tail_count: 8,
};

export function parseLegacyReason(reason: unknown): ModelStepDisposition | null {
  if (reason === "resolved" || reason === "deferred" || reason === "blocked") return reason;
  return null;
}

export function parseFinishInput(raw: unknown): { ok: true; value: FinishStepInput; usedLegacyReason: boolean } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "finish_payload_invalid" };
  const p = raw as Record<string, unknown>;
  let usedLegacyReason = false;
  let disposition: ModelStepDisposition | null = null;
  if (p.disposition != null) {
    if (p.disposition === "resolved" || p.disposition === "deferred" || p.disposition === "blocked") {
      disposition = p.disposition;
    } else {
      return { ok: false, error: `illegal_disposition:${String(p.disposition)}` };
    }
  } else if (p.reason != null) {
    usedLegacyReason = true;
    disposition = parseLegacyReason(p.reason);
    if (!disposition) return { ok: false, error: `illegal_reason:${String(p.reason)}` };
  } else {
    return { ok: false, error: "missing_disposition" };
  }
  if (typeof p.summary !== "string" || p.summary.length < 1 || p.summary.length > 8000) {
    return { ok: false, error: "summary_required" };
  }
  const evidence_refs = Array.isArray(p.evidence_refs)
    ? p.evidence_refs.filter((x): x is string => typeof x === "string")
    : [];
  if (evidence_refs.length > 128) return { ok: false, error: "evidence_refs_limit" };
  const blocked_on = typeof p.blocked_on === "string" && p.blocked_on.length > 0 ? p.blocked_on : undefined;
  const reopen_condition =
    typeof p.reopen_condition === "string" && p.reopen_condition.length > 0 ? p.reopen_condition : undefined;
  const next_action = typeof p.next_action === "string" && p.next_action.length > 0 ? p.next_action : undefined;
  if (disposition === "blocked" && !blocked_on) return { ok: false, error: "blocked_requires_blocked_on" };
  let reopen_rule = parseWakeCondition(p.reopen_rule);
  if (!reopen_rule && reopen_condition) {
    try {
      reopen_rule = parseWakeCondition(JSON.parse(reopen_condition));
    } catch {
      reopen_rule = null;
    }
  }
  if (disposition === "deferred" && !reopen_rule) {
    reopen_rule = next_action ? { kind: "always" } : { kind: "never" };
  }
  if (disposition === "blocked" && !reopen_rule) {
    reopen_rule = { kind: "never" };
  }
  return {
    ok: true,
    usedLegacyReason,
    value: {
      disposition,
      summary: p.summary,
      evidence_refs,
      blocked_on,
      reopen_condition,
      reopen_rule: reopen_rule ?? undefined,
      next_action,
      verification_result: parseVerificationResult(p.verification_result),
      coverage_result: parseCoverageResults(p.coverage_result),
    },
  };
}

export function parseWakeCondition(raw: unknown): WakeCondition | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as { kind?: unknown; key?: unknown; env_revision?: unknown; subject?: unknown };
  if (p.kind === "always" || p.kind === "never") return { kind: p.kind };
  if (p.kind === "fact_key") {
    if (typeof p.key !== "string" || p.key.length < 1) return null;
    return { kind: "fact_key", key: p.key };
  }
  if (p.kind === "env_revision") {
    if (typeof p.env_revision !== "string" || p.env_revision.length < 1) return null;
    return { kind: "env_revision", env_revision: p.env_revision };
  }
  if (p.kind === "observation_subject") {
    if (typeof p.subject !== "string" || p.subject.length < 1) return null;
    return { kind: "observation_subject", subject: p.subject };
  }
  return null;
}

export function canonicalizeFinishPayload(p: FinishStepInput): string {
  return JSON.stringify({
    disposition: p.disposition,
    summary: p.summary,
    evidence_refs: [...p.evidence_refs].sort(),
    blocked_on: p.blocked_on ?? null,
    reopen_condition: p.reopen_condition ?? null,
    reopen_rule: p.reopen_rule ?? null,
    next_action: p.next_action ?? null,
    verification_result: p.verification_result
      ? {
          target_id: p.verification_result.target_id,
          verdict: p.verification_result.verdict,
          evidence_refs: [...p.verification_result.evidence_refs].sort(),
          rationale: p.verification_result.rationale,
        }
      : null,
    coverage_result: p.coverage_result
      ? p.coverage_result
          .map((r) => ({
            coverage_id: r.coverage_id,
            outcome: r.outcome,
            evidence_refs: [...r.evidence_refs].sort(),
            note: r.note,
          }))
          .sort((a, b) => a.coverage_id.localeCompare(b.coverage_id))
      : null,
  });
}

export function needsFinalizer(trigger: PrimaryStopTrigger): boolean {
  return trigger === "natural_stop" || trigger === "turn_cap" || trigger === "tool_cap";
}

export function isSemanticDisposition(reason: string): reason is ModelStepDisposition {
  return reason === "resolved" || reason === "deferred" || reason === "blocked";
}

export function frameworkReason(trigger: PrimaryStopTrigger): TaskOutcomeReason {
  switch (trigger) {
    case "natural_stop":
    case "turn_cap":
    case "tool_cap":
      return "incomplete_protocol";
    case "budget_exhausted":
    case "deadline":
      return "budget";
    case "cancelled":
    case "aborted":
      return "cancelled";
    case "finish_committed":
      return "resolved";
    default:
      return "protocol_error";
  }
}

export function incompleteReopenRule(): WakeCondition {
  return { kind: "never" };
}

export function stepRequiresEvidence(completionCriteria: string, expectedObservations: unknown): boolean {
  const criteria = completionCriteria.trim().toLowerCase();
  if (criteria === "none" || criteria === "no_evidence" || criteria === "n/a") return false;
  void expectedObservations;
  return true;
}

export interface FinalizationStats {
  execute_runs_total: number;
  finish_primary_total: number;
  finalizer_started_total: number;
  finalizer_committed_total: number;
  finalizer_failed_total: number;
  incomplete_protocol_total: number;
  finish_conflict_total: number;
  finish_validation_error_total: number;
  primary_finish_rate: number | null;
  finalizer_success_rate: number | null;
  protocol_complete_rate: number | null;
}
