import type {
  CampaignMode,
  CampaignSpec,
  CampaignState,
  CoverageApplicability,
  CoverageEvidenceState,
  CoverageExecutionState,
  CoverageOutcome,
  FindingStatus,
  StepStatus,
} from "./types.ts";

/** One place that decides whether the root goal needs independent acceptance. */
export function requiresIndependentGoalVerification(spec: CampaignSpec): boolean {
  return Boolean(spec.verification_policy.require_independent_verify);
}

/**
 * One place that decides whether a fact satisfies the root goal. observed-only
 * policies accept observed/verified grades; the independent policy requires
 * verified. derived never satisfies directly on either.
 */
export function goalFactCanSatisfy(
  spec: CampaignSpec,
  fact: { fact_key: string | null; epistemic_status: string; validity: string; source_grade: string },
): boolean {
  const ref = spec.root_goal.success_predicate_ref;
  if (!ref || fact.fact_key !== ref) return false;
  if (fact.epistemic_status !== "accepted" || fact.validity !== "current") return false;
  if (fact.source_grade === "derived") return false;
  if (requiresIndependentGoalVerification(spec)) return fact.source_grade === "verified";
  return fact.source_grade === "observed" || fact.source_grade === "verified";
}

export interface CompletionSnapshot {
  mode: CampaignMode;
  state: CampaignState;
  cancel_epoch: number;
  in_flight_runs: number;
  in_flight_invocations: number;
  unconsumed_events: number;
  pending_important_proposals: number;
  uncertain_invocations: number;
  empty_reviews: number;
  max_empty_reviews: number;
  ready_steps: number;
  blocked_steps: number;
  frontier_size: number;
  new_observation_since_progress: boolean;
  /** Planner-relevant input not yet reviewed (requested_seq > reviewed_seq). */
  pending_decision?: boolean;
  findings: { status: FindingStatus }[];
  coverage: CoverageRow[];
  root_goal_satisfied: boolean;
  pending_goal_claim?: boolean;
}

export interface CoverageRow {
  id: string;
  mandatory: boolean;
  applicability: CoverageApplicability;
  execution_state: CoverageExecutionState;
  outcome: CoverageOutcome;
  evidence_state: CoverageEvidenceState;
}

export interface CompletionResult {
  canClose: boolean;
  suggestedState: CampaignState;
  blockers: string[];
}

export function evaluateCompletion(snap: CompletionSnapshot): CompletionResult {
  const blockers: string[] = [];
  if (snap.state === "cancelled") {
    return { canClose: false, suggestedState: "cancelled", blockers: ["cancelled"] };
  }
  if (snap.state === "paused") {
    return { canClose: false, suggestedState: "paused", blockers: ["paused"] };
  }
  if (snap.in_flight_runs > 0 || snap.in_flight_invocations > 0) {
    blockers.push("in_flight_work");
    return { canClose: false, suggestedState: "waiting", blockers };
  }
  if (snap.uncertain_invocations > 0) {
    blockers.push("uncertain_invocations");
    return { canClose: false, suggestedState: "waiting", blockers };
  }
  if (snap.mode === "goal_seeking" && snap.root_goal_satisfied) {
    return { canClose: true, suggestedState: "completed", blockers: [] };
  }
  if (snap.mode === "goal_seeking" && snap.pending_goal_claim) {
    return { canClose: false, suggestedState: "awaiting_verify", blockers: ["human_goal_verify"] };
  }
  if (snap.state === "awaiting_verify") {
    return { canClose: false, suggestedState: "awaiting_verify", blockers: ["human_goal_verify"] };
  }
  // Planner-relevant input waits for a Decide review. Audit-style events alone
  // (bookkeeping, heartbeats) never block completion; legacy callers that only
  // count unconsumed events fall back to the old semantics.
  const pendingDecision = snap.pending_decision ?? snap.unconsumed_events > 0;
  if (pendingDecision) {
    blockers.push("pending_decision");
    return { canClose: false, suggestedState: "active", blockers };
  }
  if (snap.pending_important_proposals > 0) {
    blockers.push("pending_proposals");
    return { canClose: false, suggestedState: "active", blockers };
  }
  if (snap.ready_steps > 0) {
    blockers.push("ready_steps");
    return { canClose: false, suggestedState: "active", blockers };
  }

  if (snap.mode === "goal_seeking") {
    if (!snap.root_goal_satisfied) {
      if (snap.blocked_steps > 0 && snap.frontier_size > 0) {
        return { canClose: false, suggestedState: "blocked", blockers: ["missing_precondition"] };
      }
      if (snap.empty_reviews < snap.max_empty_reviews) {
        return { canClose: false, suggestedState: "active", blockers: ["review_allowance_remaining"] };
      }
      return { canClose: false, suggestedState: "plateau", blockers: ["frontier_exhausted"] };
    }
    return { canClose: true, suggestedState: "completed", blockers: [] };
  }

  const mandatoryUntested = snap.coverage.filter(
    (c) => c.mandatory && c.applicability === "applicable" && c.execution_state !== "tested" && c.execution_state !== "waived",
  );
  if (mandatoryUntested.length > 0) {
    blockers.push("mandatory_coverage_untested");
    if (snap.blocked_steps > 0) {
      return { canClose: false, suggestedState: "blocked", blockers };
    }
    if (snap.empty_reviews < snap.max_empty_reviews) {
      return { canClose: false, suggestedState: "active", blockers: [...blockers, "review_allowance_remaining"] };
    }
    return { canClose: false, suggestedState: "plateau", blockers };
  }

  const mandatoryBadEvidence = snap.coverage.filter(
    (c) =>
      c.mandatory &&
      c.applicability === "applicable" &&
      c.execution_state === "tested" &&
      (c.evidence_state === "stale" || c.evidence_state === "missing"),
  );
  if (mandatoryBadEvidence.length > 0) {
    blockers.push("coverage_evidence_not_current");
    return { canClose: false, suggestedState: "plateau", blockers };
  }

  const pendingFindings = snap.findings.filter((f) => f.status === "suspected" || f.status === "validating");
  if (pendingFindings.length > 0) {
    blockers.push("findings_pending_verification");
    return { canClose: false, suggestedState: "waiting", blockers };
  }

  if (snap.frontier_size === 0 && !snap.new_observation_since_progress) {
    if (snap.empty_reviews < snap.max_empty_reviews) {
      return { canClose: false, suggestedState: "active", blockers: ["review_allowance_remaining"] };
    }
  }

  const untestedApplicable = snap.coverage.filter(
    (c) => c.applicability === "applicable" && c.execution_state === "untested",
  );
  if (untestedApplicable.length > 0) {
    blockers.push("applicable_coverage_untested");
    return { canClose: false, suggestedState: "plateau", blockers };
  }

  return { canClose: true, suggestedState: "completed", blockers: [] };
}
