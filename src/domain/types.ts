import type { ChallengeInfo } from "./challenge-kind.ts";
export type { ChallengeInfo } from "./challenge-kind.ts";

export type CampaignMode = "goal_seeking" | "assessment";

export type CampaignState =
  | "created"
  | "active"
  | "waiting"
  | "blocked"
  | "plateau"
  | "budget_paused"
  | "paused"
  | "awaiting_verify"
  | "closing"
  | "completed"
  | "cancelled";

export type GoalStatus = "active" | "retired" | "achieved" | "blocked";

export type EpistemicStatus = "proposed" | "accepted" | "disputed" | "retracted" | "stale";
export type FactSourceGrade = "observed" | "derived" | "verified";
export type FactValidity = "current" | "stale" | "unknown";

export type StepKind = "explore" | "verify" | "acquire_prerequisite" | "reconcile";
export type StepStatus =
  | "proposed"
  | "ready"
  | "leased"
  | "running"
  | "awaiting"
  | "resolved"
  | "deferred"
  | "blocked"
  | "retired";

export type TaskRunState =
  | "claimed"
  | "running"
  | "finished"
  | "aborted"
  | "lease_expired";

export type WorkerMode = "decide" | "execute";

export type InvocationKind = "model" | "tool";
export type InvocationState =
  | "prepared"
  | "dispatching"
  | "running"
  | "completed"
  | "failed_known"
  | "uncertain"
  | "reconciled";

export type FindingStatus = "suspected" | "validating" | "confirmed" | "refuted" | "stale" | "inconclusive";

export type CoverageApplicability = "unknown" | "applicable" | "not_applicable";
export type CoverageExecutionState = "untested" | "in_progress" | "tested" | "blocked" | "waived";
export type CoverageOutcome = "none" | "no_issue_observed" | "suspected" | "confirmed" | "inconclusive";
export type CoverageEvidenceState = "missing" | "current" | "stale" | "disputed";

export type TaskOutcomeReason =
  | "resolved"
  | "deferred"
  | "blocked"
  | "cancelled"
  | "budget"
  | "context_limit"
  | "protocol_error"
  | "incomplete_protocol";

export type SubmitFactResultStatus = "accepted_as_observation" | "pending_verification" | "rejected";

export type EffectClass = "pure" | "read" | "workspace_write" | "external_write" | "unknown";

export type ActorKind = "user" | "controller" | "worker" | "adapter";

export interface EntityRef {
  id: string;
  revision: number;
}

export interface ReadSetEntry {
  table: string;
  id: string;
  revision: number;
}

export interface Actor {
  kind: ActorKind;
  id: string;
}

export interface CommonFields {
  id: string;
  campaign_id: string;
  schema_version: number;
  revision: number;
  created_at: string;
  created_seq: number;
  updated_seq: number;
  source_run_id: string | null;
  source_submission_id: string | null;
}

export interface BudgetSpec {
  currency: string;
  price_version: string;
  max_cost_micro: number | null;
  max_tokens: number | null;
  max_calls: number | null;
  deadline_ms: number | null;
}

export interface ScopeSpec {
  assets: string[];
  workspace: string;
  identities: string[];
  entries: string[];
  exclusions: string[];
  profile: string;
}

export interface ModelPolicy {
  provider: string;
  model: string;
  thinking_level: "low" | "high" | "max";
  allow_retry: boolean;
  allow_model_fallback: boolean;
}

export interface VerificationPolicy {
  require_independent_verify: boolean;
  oracle_id: string;
  /** Assessment acceptance: suspected/validating findings must reach a verdict
   *  before delivery. Absent on old specs means strict (true). */
  require_confirmed_findings?: boolean;
}

/** Explicit verdict from a verify run's primary finish. Never from Finalize. */
export interface VerificationResult {
  target_id: string;
  verdict: "confirmed" | "refuted" | "inconclusive";
  evidence_refs: string[];
  rationale: string;
}

export interface CoveragePolicy {
  dimensions: string[];
  mandatory_ids: string[];
}

export interface ArtifactPolicy {
  max_bytes: number;
  retention_days: number;
}

export interface StopPolicy {
  max_empty_reviews_per_progress_epoch: number;
  decide_debounce_ms: number;
}

export interface RootGoalSpec {
  statement: string;
  success_predicate_ref: string;
}

export interface CampaignSpec {
  campaign_id: string;
  schema_version: number;
  mode: CampaignMode;
  root_goal: RootGoalSpec;
  scope: ScopeSpec;
  policy_version: string;
  scope_version: string;
  goal_version: string;
  tool_allowlist: string[];
  execution_profile: string;
  model_policy: ModelPolicy;
  budget: BudgetSpec;
  verification_policy: VerificationPolicy;
  coverage_policy: CoveragePolicy;
  artifact_policy: ArtifactPolicy;
  stop_policy: StopPolicy;
  environment_revision: string;
  /** Present only for campaigns created from --input (local CTF attachments). */
  challenge?: ChallengeInfo;
}

export interface CampaignRecord {
  id: string;
  spec: CampaignSpec;
  state: CampaignState;
  epoch: number;
  cancel_epoch: number;
  event_head: number;
  progress_epoch: number;
  reviewed_seq: number;
  requested_seq: number;
  empty_reviews: number;
  created_at: string;
  updated_at: string;
}

export type PredicateExpr =
  | { op: "atom"; fact_id?: string; key?: string; expected?: unknown }
  | { op: "all"; of: PredicateExpr[] }
  | { op: "any"; of: PredicateExpr[] };

export type TriValue = "true" | "false" | "unknown";

export interface WakeCondition {
  kind: "fact_key" | "env_revision" | "always" | "never" | "observation_subject";
  key?: string;
  env_revision?: string;
  subject?: string;
}

export interface BudgetSlice {
  max_calls?: number;
  max_tokens?: number;
  max_cost_micro?: number;
}

export interface ResourceClaim {
  key: string;
  mode: "shared" | "exclusive";
}

export interface StepSpec {
  id: string;
  campaignId: string;
  branchId: string;
  kind: StepKind;
  question: string;
  goalRefs: string[];
  inputRefs: EntityRef[];
  preconditions: PredicateExpr;
  methodFamily: string;
  expectedObservations: string[];
  completionCriteria: string;
  resourceClaims: ResourceClaim[];
  budgetHint: BudgetSlice;
  fingerprint: string;
  reopenRule: WakeCondition;
}

export interface TaskOutcome {
  run_id: string;
  step_id: string | null;
  mode: WorkerMode;
  reason: TaskOutcomeReason;
  summary: string;
  observation_ids: string[];
  fact_ids: string[];
  finding_ids: string[];
  blocked_on: string | null;
  reopen_rule: WakeCondition | null;
  next_action?: string | null;
  finish_requested: boolean;
  protocol_error: string | null;
  /** Present on verify runs whose primary submitted an explicit verdict. */
  verification_result?: VerificationResult | null;
}

export interface DomainEvent {
  eventId: string;
  campaignId: string;
  seq: number;
  schemaVersion: number;
  type: string;
  actor: Actor;
  entityId?: string;
  entityRevision?: number;
  causationId?: string;
  correlationId: string;
  submissionId?: string;
  recordedAt: string;
  payload: unknown;
}

export const EVENT_TYPES = [
  "campaign.created",
  "control.changed",
  "step.proposed",
  "step.ready",
  "step.blocked",
  "step.retired",
  "run.claimed",
  "run.finished",
  "invocation.prepared",
  "invocation.dispatched",
  "observation.recorded",
  "fact.accepted",
  "fact.invalidated",
  "finding.proposed",
  "finding.status_changed",
  "verification.completed",
  "decision.committed",
  "campaign.state_changed",
  "coverage.updated",
  "goal.created",
  "goal.retired",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ProposalOp =
  | {
      op: "propose_step";
      step: Omit<StepSpec, "id" | "campaignId" | "branchId" | "fingerprint"> & {
        id?: string;
        branchId?: string;
        fingerprint?: string;
      };
    }
  | { op: "revise_step_priority"; step_id: string; expected_revision?: number; priority: number }
  | { op: "retire_step"; step_id: string; expected_revision?: number; reason: string }
  | { op: "propose_subgoal"; statement: string; parent_id: string; success_predicate_ref?: string }
  | { op: "retire_subgoal"; goal_id: string; expected_revision?: number; reason: string }
  | { op: "propose_hypothesis"; proposition: string; support_refs: string[]; conditions: Record<string, unknown> }
  | { op: "request_verification"; finding_or_fact_id: string; method: string }
  | {
      op: "propose_coverage_item";
      obligation: string;
      dimensions: Record<string, string>;
      mandatory: boolean;
    }
  | { op: "recommend_state"; state: CampaignState; reason: string };

export const ALLOWED_PROPOSAL_OPS: ProposalOp["op"][] = [
  "propose_step",
  "revise_step_priority",
  "retire_step",
  "propose_subgoal",
  "retire_subgoal",
  "propose_hypothesis",
  "request_verification",
  "propose_coverage_item",
  "recommend_state",
];

export interface ContextManifest {
  run_id: string;
  mode: WorkerMode;
  prompt_version: string;
  tool_schema_hash: string;
  graph_snapshot_seq: number;
  root_goal_version: string;
  scope_version: string;
  policy_version: string;
  model_id: string;
  selected_entity_revisions: ReadSetEntry[];
  artifact_slices: { artifact_id: string; offset: number; length: number }[];
  omitted_items: { kind: string; count: number }[];
  estimated_tokens: number;
  context_hash: string;
}

export interface RunLease {
  run_id: string;
  campaign_id: string;
  step_id: string | null;
  mode: WorkerMode;
  kind: StepKind | "decide";
  attempt_no: number;
  fence: number;
  cancel_epoch: number;
  deadline_ms: number;
  lease_owner: string;
  continuation_of: string | null;
}

export const CAMPAIGN_TRANSITIONS: Record<CampaignState, CampaignState[]> = {
  created: ["active", "paused", "cancelled"],
  active: ["waiting", "blocked", "plateau", "budget_paused", "paused", "awaiting_verify", "closing", "cancelled"],
  waiting: ["active", "blocked", "plateau", "budget_paused", "paused", "awaiting_verify", "closing", "cancelled"],
  blocked: ["active", "waiting", "plateau", "paused", "closing", "cancelled"],
  plateau: ["active", "paused", "cancelled", "closing"],
  budget_paused: ["active", "paused", "awaiting_verify", "cancelled"],
  paused: ["active", "cancelled"],
  awaiting_verify: ["active", "paused", "closing", "cancelled"],
  closing: ["completed", "active", "cancelled"],
  completed: [],
  cancelled: [],
};

export const STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  proposed: ["ready", "blocked", "retired"],
  ready: ["leased", "retired", "blocked"],
  leased: ["running", "ready", "blocked"],
  running: ["awaiting", "resolved", "deferred", "blocked", "retired"],
  awaiting: ["running", "blocked"],
  resolved: [],
  deferred: ["ready", "retired"],
  blocked: ["ready", "retired"],
  retired: [],
};

export const FINDING_TRANSITIONS: Record<FindingStatus, FindingStatus[]> = {
  suspected: ["validating", "stale"],
  validating: ["confirmed", "refuted", "inconclusive", "stale"],
  confirmed: ["stale"],
  refuted: ["stale"],
  stale: ["suspected", "validating"],
  inconclusive: ["validating", "stale"],
};
