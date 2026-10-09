import { createHash } from "node:crypto";
import { DomainError, conflict, denied, invalidInput } from "../domain/errors.ts";
import { newId, newCorrelationId } from "../domain/ids.ts";
import { evalPredicate, type FactLookup } from "../domain/predicates.ts";
import { defaultStepFingerprint, legacyStepFingerprint, parseProposalOps } from "../domain/proposals.ts";
import { requiresIndependentGoalVerification } from "../domain/completion.ts";
import { hashJson } from "../domain/fingerprint.ts";
import { transitionCampaign, transitionFinding, transitionStep } from "../domain/states.ts";
import type {
  Actor,
  CampaignRecord,
  CampaignSpec,
  CampaignState,
  CoverageApplicability,
  CoverageEvidenceState,
  CoverageExecutionState,
  CoverageOutcome,
  DomainEvent,
  EpistemicStatus,
  FactSourceGrade,
  FactValidity,
  FindingStatus,
  PredicateExpr,
  ProposalOp,
  ReadSetEntry,
  StepKind,
  StepStatus,
  SubmitFactResultStatus,
  TaskOutcome,
  WakeCondition,
  WorkerMode,
} from "../domain/types.ts";
import {
  canonicalizeFinishPayload,
  incompleteReopenRule,
  isSemanticDisposition,
  parseFinishInput,
  stepRequiresEvidence,
  type FinishPayload,
  type FinalizationStats,
  type PrimaryStopTrigger,
  type SubmitRunOutcomeArgs,
  type SubmitRunOutcomeResult,
} from "../contracts/finalization.ts";
import { SCHEMA_VERSION } from "../version.ts";
import { applyVerification } from "../verification/verdict.ts";
import { pickFairReadyStep } from "../scheduler/fair.ts";
import { ArtifactStore, type StoredArtifact } from "./artifacts.ts";
import { Store, asJson, fromJson, nowIso } from "./db.ts";

export interface IdempotentResult {
  status: "ok" | "replayed" | "conflict";
  canonical_ids: Record<string, string>;
  seq: number;
  reason?: string;
  extra?: Record<string, unknown>;
}

export const MAX_STEP_ATTEMPTS = 5;

/**
 * A framework stop is not a conclusion about the step: the worker died on a
 * provider/network failure or ran out of budget/context before it could judge
 * its own work. Parking such a step with `never` (what incompleteReopenRule
 * returns) silently destroys the retry door — a seed step's `always` was
 * overwritten that way in production. Keep those retryable; the attempt cap in
 * reopenSatisfied still bounds the loop. Anything else, including the model's
 * explicit `never`, keeps the old semantics.
 */
function parkRuleForReason(reason: TaskOutcome["reason"]): WakeCondition {
  if (reason === "protocol_error" || reason === "budget" || reason === "context_limit") {
    return { kind: "always" };
  }
  return incompleteReopenRule();
}

/** Entity name → table for graph_query; anything else is rejected. */
function graphEntityTable(entity: string): string {
  const table = {
    facts: "facts",
    steps: "steps",
    goals: "goals",
    findings: "findings",
    coverage: "coverage_items",
    observations: "observations",
  }[entity];
  if (!table) throw invalidInput("unknown_entity", `graph_query entity ${entity} not allowed`);
  return table;
}

export class StorageService {
  constructor(
    readonly store: Store,
    readonly artifacts: ArtifactStore,
  ) {}

  close(): void {
    this.store.close();
  }

  acquireControllerLock(campaignId: string, owner: string, leaseMs = 60_000): { generation: number; takeover: boolean } {
    return this.store.transaction(() => {
      const now = Date.now();
      const existing = this.store.db
        .prepare("SELECT owner, lease_until, heartbeat_at, generation FROM controller_locks WHERE campaign_id = ?")
        .get(campaignId) as
        | { owner: string; lease_until: number | null; heartbeat_at: string | null; generation: number }
        | undefined;
      const iso = nowIso();
      const until = now + leaseMs;
      if (!existing) {
        this.store.db
          .prepare(
            "INSERT INTO controller_locks(campaign_id, owner, acquired_at, heartbeat_at, lease_until, generation) VALUES (?, ?, ?, ?, ?, 1)",
          )
          .run(campaignId, owner, iso, iso, until);
        return { generation: 1, takeover: false };
      }
      if (existing.owner === owner) {
        this.store.db
          .prepare("UPDATE controller_locks SET heartbeat_at = ?, lease_until = ? WHERE campaign_id = ?")
          .run(iso, until, campaignId);
        return { generation: Number(existing.generation ?? 1), takeover: false };
      }
      const expired = existing.lease_until != null && Number(existing.lease_until) < now;
      const heartbeatMs = existing.heartbeat_at ? Date.parse(existing.heartbeat_at) : 0;
      const staleHeartbeat = heartbeatMs > 0 && now - heartbeatMs > leaseMs;
      if (!expired && !staleHeartbeat) {
        throw denied("controller_lock_held", "another controller owns this campaign", { owner: existing.owner });
      }
      const generation = Number(existing.generation ?? 1) + 1;
      this.store.db
        .prepare(
          "UPDATE controller_locks SET owner = ?, acquired_at = ?, heartbeat_at = ?, lease_until = ?, generation = ? WHERE campaign_id = ?",
        )
        .run(owner, iso, iso, until, generation, campaignId);
      return { generation, takeover: true };
    });
  }

  heartbeatControllerLock(campaignId: string, owner: string, leaseMs = 60_000): void {
    const iso = nowIso();
    const until = Date.now() + leaseMs;
    const row = this.store.db
      .prepare("UPDATE controller_locks SET heartbeat_at = ?, lease_until = ? WHERE campaign_id = ? AND owner = ?")
      .run(iso, until, campaignId, owner);
    void row;
  }

  releaseControllerLock(campaignId: string, owner: string): void {
    this.store.db.prepare("DELETE FROM controller_locks WHERE campaign_id = ? AND owner = ?").run(campaignId, owner);
  }

  releaseAllControllerLocks(owner: string): void {
    this.store.db.prepare("DELETE FROM controller_locks WHERE owner = ?").run(owner);
  }

  recoverStaleRuns(campaignId: string): number {
    return this.store.transaction(() => {
      const recoveredFinishes = this.recoverPendingFinishesTx(campaignId);
      const now = Date.now();
      const stale = this.store.db
        .prepare(
          "SELECT id, step_id, mode FROM task_runs WHERE campaign_id = ? AND state IN ('claimed','running') AND deadline_ms < ?",
        )
        .all(campaignId, now) as { id: string; step_id: string | null; mode: string }[];
      const iso = nowIso();
      let n = recoveredFinishes;
      for (const run of stale) {
        this.store.db
          .prepare("UPDATE task_runs SET state = 'lease_expired', end_reason = 'controller_takeover', updated_at = ? WHERE id = ?")
          .run(iso, run.id);
        if (run.mode === "decide") {
          this.store.db.prepare("UPDATE campaigns SET decide_lock_owner = NULL, updated_at = ? WHERE id = ?").run(iso, campaignId);
        } else {
          this.store.db
            .prepare(
              "UPDATE campaigns SET execute_lock_owner = NULL, execute_run_id = NULL, updated_at = ? WHERE id = ? AND (execute_run_id = ? OR execute_run_id IS NULL)",
            )
            .run(iso, campaignId, run.id);
          if (run.step_id) {
            this.store.db
              .prepare(
                "UPDATE steps SET status = 'deferred', last_failure = 'controller_takeover', active_run_id = NULL, revision = revision + 1 WHERE id = ? AND status IN ('leased','running') AND (active_run_id = ? OR active_run_id IS NULL)",
              )
              .run(run.step_id, run.id);
          }
        }
        n += 1;
      }
      return n;
    });
  }

  recoverPendingFinishes(campaignId: string): number {
    return this.store.transaction(() => this.recoverPendingFinishesTx(campaignId));
  }

  /**
   * Renew a live run's lease. The WHERE clause refuses to touch a run that was
   * already finished or reclaimed, so a partitioned worker cannot steal its
   * own lease back from a controller takeover.
   */
  heartbeatRun(runId: string, deadlineMs: number): void {
    this.store.db
      .prepare("UPDATE task_runs SET deadline_ms = ?, updated_at = ? WHERE id = ? AND state IN ('claimed','running')")
      .run(deadlineMs, nowIso(), runId);
  }

  private recoverPendingFinishesTx(campaignId: string): number {
    const pending = this.store.db
      .prepare(
        "SELECT * FROM task_runs WHERE campaign_id = ? AND mode = 'execute' AND state IN ('claimed','running')",
      )
      .all(campaignId) as Record<string, unknown>[];
    let n = 0;
    for (const run of pending) {
      const runId = String(run.id);
      const payloadJson = run.finish_payload_json ? String(run.finish_payload_json) : "";
      if (payloadJson) {
        const outcome = this.outcomeFromFinishPayload(run, payloadJson);
        this.finishRun(campaignId, runId, outcome);
        n += 1;
        continue;
      }
      if (Number(run.finish_requested) === 1 || Number(run.finalize_attempted) === 1) {
        const outcome = this.frameworkRunOutcome(run, "incomplete_protocol", "missing finish payload");
        this.finishRun(campaignId, runId, outcome);
        n += 1;
      }
    }
    return n;
  }

  createCampaign(spec: CampaignSpec): CampaignRecord {
    const now = nowIso();
    this.store.transaction(() => {
      this.store.db
        .prepare(
          `INSERT INTO campaigns(id, spec_json, state, epoch, cancel_epoch, event_head, progress_epoch, reviewed_seq, requested_seq, empty_reviews, admission_open, created_at, updated_at)
           VALUES (?, ?, 'created', 0, 0, 0, 0, 0, 0, 0, 1, ?, ?)`,
        )
        .run(spec.campaign_id, asJson(spec), now, now);
      const seq = this.appendEvent(spec.campaign_id, "campaign.created", { spec }, { kind: "user", id: "cli" }, spec.campaign_id);
      const goalId = newId("goal");
      this.store.db
        .prepare(
          `INSERT INTO goals(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, statement, parent_id, is_root, success_predicate_ref, mandatory, status, evidence_refs_json)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, 1, ?, 1, 'active', '[]')`,
        )
        .run(goalId, spec.campaign_id, SCHEMA_VERSION, now, seq, seq, spec.root_goal.statement, spec.root_goal.success_predicate_ref);
      this.store.db
        .prepare(
          `INSERT INTO budget_accounts(
            campaign_id, currency, price_version,
            total_cost_micro, free_cost, reserved_cost, liability_cost, spent_cost, overrun_cost,
            total_tokens, free_tokens, reserved_tokens, liability_tokens, spent_tokens, overrun_tokens,
            total_calls, free_calls, reserved_calls, liability_calls, spent_calls, overrun_calls
          ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, 0, 0, 0, 0, ?, ?, 0, 0, 0, 0)`,
        )
        .run(
          spec.campaign_id,
          spec.budget.currency,
          spec.budget.price_version,
          spec.budget.max_cost_micro ?? 0,
          spec.budget.max_cost_micro ?? 0,
          spec.budget.max_tokens ?? 0,
          spec.budget.max_tokens ?? 0,
          spec.budget.max_calls ?? 0,
          spec.budget.max_calls ?? 0,
        );
      for (const obligation of spec.coverage_policy.mandatory_ids) {
        const covId = newId("cov");
        this.store.db
          .prepare(
            `INSERT INTO coverage_items(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, obligation, dimensions_json, applicability, execution_state, outcome, evidence_state, mandatory)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, '{}', 'applicable', 'untested', 'none', 'missing', 1)`,
          )
          .run(covId, spec.campaign_id, SCHEMA_VERSION, now, seq, seq, obligation);
      }
    });
    return this.getCampaign(spec.campaign_id);
  }

  listCampaigns(): { id: string; state: CampaignState; updated_at: string }[] {
    return this.store.db
      .prepare("SELECT id, state, updated_at FROM campaigns ORDER BY updated_at DESC")
      .all() as { id: string; state: CampaignState; updated_at: string }[];
  }

  getCampaign(id: string): CampaignRecord {
    const row = this.store.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw invalidInput("campaign_not_found", `campaign ${id} not found`);
    return {
      id: String(row.id),
      spec: fromJson<CampaignSpec>(String(row.spec_json), null as unknown as CampaignSpec),
      state: row.state as CampaignState,
      epoch: Number(row.epoch),
      cancel_epoch: Number(row.cancel_epoch),
      event_head: Number(row.event_head),
      progress_epoch: Number(row.progress_epoch),
      reviewed_seq: Number(row.reviewed_seq),
      requested_seq: Number(row.requested_seq),
      empty_reviews: Number(row.empty_reviews),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  setCampaignState(id: string, to: CampaignState, actor: Actor): void {
    this.store.transaction(() => {
      const camp = this.getCampaign(id);
      transitionCampaign(camp.state, to);
      this.store.db.prepare("UPDATE campaigns SET state = ?, updated_at = ? WHERE id = ?").run(to, nowIso(), id);
      this.appendEvent(id, "campaign.state_changed", { from: camp.state, to }, actor);
    });
  }

  persistCancel(id: string, actor: Actor): number {
    return this.store.transaction(() => {
      const camp = this.getCampaign(id);
      const cancelEpoch = camp.cancel_epoch + 1;
      const nextState = camp.state === "cancelled" ? "cancelled" : "cancelled";
      if (camp.state !== "cancelled") {
        transitionCampaign(camp.state, "cancelled");
      }
      this.store.db
        .prepare("UPDATE campaigns SET state = ?, cancel_epoch = ?, admission_open = 0, epoch = epoch + 1, updated_at = ? WHERE id = ?")
        .run(nextState, cancelEpoch, nowIso(), id);
      this.appendEvent(id, "control.changed", { command: "cancel", cancel_epoch: cancelEpoch }, actor);
      if (camp.state !== "cancelled") {
        this.appendEvent(id, "campaign.state_changed", { from: camp.state, to: "cancelled" }, actor);
      }
      return cancelEpoch;
    });
  }

  persistPause(id: string, actor: Actor, kind: "paused" | "budget_paused" | "awaiting_verify"): void {
    this.store.transaction(() => {
      const camp = this.getCampaign(id);
      transitionCampaign(camp.state, kind);
      this.store.db
        .prepare("UPDATE campaigns SET state = ?, admission_open = 0, epoch = epoch + 1, updated_at = ? WHERE id = ?")
        .run(kind, nowIso(), id);
      this.appendEvent(id, "control.changed", { command: kind }, actor);
      this.appendEvent(id, "campaign.state_changed", { from: camp.state, to: kind }, actor);
    });
  }

  persistResume(id: string, actor: Actor): void {
    this.store.transaction(() => {
      const camp = this.getCampaign(id);
      if (camp.state === "cancelled") {
        throw denied("cancelled_no_autoresume", "cancelled campaigns do not auto-resume");
      }
      if (camp.state === "awaiting_verify") {
        throw denied("awaiting_human_verify", "use verify-goal --accept or --reject, not resume");
      }
      transitionCampaign(camp.state, "active");
      this.store.db
        .prepare("UPDATE campaigns SET state = ?, admission_open = 1, epoch = epoch + 1, updated_at = ? WHERE id = ?")
        .run("active", nowIso(), id);
      this.appendEvent(id, "control.changed", { command: "resume" }, actor);
      this.appendEvent(id, "campaign.state_changed", { from: camp.state, to: "active" }, actor);
    });
  }

  persistHint(id: string, text: string, actor: Actor): number {
    return this.store.transaction(() => {
      const seq = this.appendEvent(id, "control.changed", { command: "hint", text }, actor);
      this.markRequested(id, seq);
      this.store.db.prepare("UPDATE campaigns SET epoch = epoch + 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
      return this.getCampaign(id).epoch;
    });
  }

  pendingGoalClaim(campaignId: string): { id: string; proposition: string; fact_key: string } | null {
    const camp = this.getCampaign(campaignId);
    const key = camp.spec.root_goal.success_predicate_ref;
    if (!key || key === "sample_recovered") return null;
    // observed-only policies never park a claim for review; derived claims are
    // inferences, not reviewable observations, on any policy.
    if (!requiresIndependentGoalVerification(camp.spec)) return null;
    const row = this.store.db
      .prepare(
        "SELECT id, proposition, fact_key FROM facts WHERE campaign_id = ? AND fact_key = ? AND epistemic_status = 'proposed' AND validity = 'current' AND source_grade != 'derived' ORDER BY created_seq DESC LIMIT 1",
      )
      .get(campaignId, key) as { id: string; proposition: string; fact_key: string } | undefined;
    return row ?? null;
  }

  acceptGoalClaim(campaignId: string, factId: string, actor: Actor): void {
    this.store.transaction(() => {
      const camp = this.getCampaign(campaignId);
      const key = camp.spec.root_goal.success_predicate_ref;
      const row = this.store.db
        .prepare("SELECT id, fact_key, epistemic_status FROM facts WHERE id = ? AND campaign_id = ?")
        .get(factId, campaignId) as { id: string; fact_key: string | null; epistemic_status: string } | undefined;
      if (!row || row.fact_key !== key) {
        throw invalidInput("not_goal_claim", "fact is not the campaign success predicate");
      }
      const seq = this.appendEvent(campaignId, "control.changed", { command: "goal_verdict", verdict: "accepted", fact_id: factId }, actor);
      this.store.db
        .prepare(
          "UPDATE facts SET epistemic_status = 'accepted', source_grade = 'verified', validity = 'current', revision = revision + 1, updated_seq = ? WHERE id = ?",
        )
        .run(seq, factId);
      this.store.db
        .prepare(
          "UPDATE facts SET epistemic_status = 'disputed', validity = 'stale', revision = revision + 1 WHERE campaign_id = ? AND fact_key = ? AND id != ? AND epistemic_status = 'proposed'",
        )
        .run(campaignId, key, factId);
      this.bumpProgress(campaignId);
    });
  }

  rejectGoalClaim(campaignId: string, text: string, actor: Actor, factId?: string): { proposition: string } {
    return this.store.transaction(() => {
      const camp = this.getCampaign(campaignId);
      const key = camp.spec.root_goal.success_predicate_ref;
      const target =
        factId ??
        (this.store.db
          .prepare(
            "SELECT id FROM facts WHERE campaign_id = ? AND fact_key = ? AND epistemic_status = 'proposed' ORDER BY created_seq DESC LIMIT 1",
          )
          .get(campaignId, key) as { id: string } | undefined)?.id;
      if (!target) throw invalidInput("no_goal_claim", "no pending success-predicate fact to reject");
      const row = this.store.db
        .prepare("SELECT proposition FROM facts WHERE id = ? AND campaign_id = ?")
        .get(target, campaignId) as { proposition: string } | undefined;
      if (!row) throw invalidInput("no_goal_claim", "pending fact missing");
      this.store.db
        .prepare(
          "UPDATE facts SET epistemic_status = 'disputed', validity = 'stale', revision = revision + 1 WHERE campaign_id = ? AND fact_key = ? AND epistemic_status = 'proposed'",
        )
        .run(campaignId, key);
      const hint = text.trim()
        ? `Human rejected the submitted flag. It is incorrect. Submitted claim: ${row.proposition}. ${text.trim()} Do not resubmit this value. Continue searching.`
        : `Human rejected the submitted flag. It is incorrect. Submitted claim: ${row.proposition}. Do not resubmit this value. Continue searching.`;
      const seq = this.appendEvent(
        campaignId,
        "control.changed",
        { command: "hint", text: hint, verdict: "rejected", fact_id: target },
        actor,
      );
      this.markRequested(campaignId, seq);
      this.bumpProgress(campaignId);
      if (camp.state === "awaiting_verify") {
        transitionCampaign(camp.state, "active");
        this.store.db
          .prepare("UPDATE campaigns SET state = ?, admission_open = 1, epoch = epoch + 1, updated_at = ? WHERE id = ?")
          .run("active", nowIso(), campaignId);
        this.appendEvent(campaignId, "campaign.state_changed", { from: camp.state, to: "active" }, actor);
      } else {
        this.store.db.prepare("UPDATE campaigns SET epoch = epoch + 1, updated_at = ? WHERE id = ?").run(nowIso(), campaignId);
      }
      return { proposition: row.proposition };
    });
  }

  persistReviseBudget(id: string, patch: { max_calls?: number; max_tokens?: number; max_cost_micro?: number }, actor: Actor): number {
    return this.store.transaction(() => {
      const camp = this.getCampaign(id);
      if (patch.max_calls !== undefined && patch.max_calls < 0) throw invalidInput("negative_budget", "max_calls < 0");
      if (patch.max_tokens !== undefined && patch.max_tokens < 0) throw invalidInput("negative_budget", "max_tokens < 0");
      if (patch.max_cost_micro !== undefined && patch.max_cost_micro < 0) throw invalidInput("negative_budget", "max_cost_micro < 0");
      const spec = camp.spec;
      if (patch.max_calls !== undefined) spec.budget.max_calls = patch.max_calls;
      if (patch.max_tokens !== undefined) spec.budget.max_tokens = patch.max_tokens;
      if (patch.max_cost_micro !== undefined) spec.budget.max_cost_micro = patch.max_cost_micro;
      this.store.db.prepare("UPDATE campaigns SET spec_json = ?, epoch = epoch + 1, updated_at = ? WHERE id = ?").run(asJson(spec), nowIso(), id);
      if (patch.max_calls !== undefined) {
        this.store.db
          .prepare("UPDATE budget_accounts SET total_calls = ?, free_calls = MAX(0, ? - spent_calls - reserved_calls - liability_calls) WHERE campaign_id = ?")
          .run(patch.max_calls, patch.max_calls, id);
      }
      if (patch.max_tokens !== undefined) {
        this.store.db
          .prepare("UPDATE budget_accounts SET total_tokens = ?, free_tokens = MAX(0, ? - spent_tokens - reserved_tokens - liability_tokens) WHERE campaign_id = ?")
          .run(patch.max_tokens, patch.max_tokens, id);
      }
      const seq = this.appendEvent(id, "control.changed", { command: "revise_budget", patch }, actor);
      this.markRequested(id, seq);
      return this.getCampaign(id).epoch;
    });
  }

  persistReviseScope(id: string, scope_version: string, actor: Actor): number {
    return this.store.transaction(() => {
      const camp = this.getCampaign(id);
      camp.spec.scope_version = scope_version;
      this.store.db.prepare("UPDATE campaigns SET spec_json = ?, epoch = epoch + 1, updated_at = ? WHERE id = ?").run(asJson(camp.spec), nowIso(), id);
      const seq = this.appendEvent(id, "control.changed", { command: "revise_scope", scope_version }, actor);
      this.markRequested(id, seq);
      return this.getCampaign(id).epoch;
    });
  }

  haltAdmission(campaignId: string, reason: string): void {
    this.store.db
      .prepare("UPDATE campaigns SET admission_open = 0, updated_at = ? WHERE id = ?")
      .run(nowIso(), campaignId);
    this.appendEvent(campaignId, "control.changed", { command: "halt_admission", reason }, { kind: "controller", id: "fault" });
  }

  registerOperation(campaignId: string, invocationId: string, executionId: string, state = "running"): void {
    this.store.db
      .prepare(
        `INSERT INTO operations(execution_id, campaign_id, invocation_id, state, next_poll_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(execution_id) DO UPDATE SET
           campaign_id = excluded.campaign_id,
           invocation_id = excluded.invocation_id,
           state = excluded.state`,
      )
      .run(executionId, campaignId, invocationId, state, nowIso());
  }

  getOperation(executionId: string): Record<string, unknown> | undefined {
    return this.store.db.prepare("SELECT * FROM operations WHERE execution_id = ?").get(executionId) as Record<string, unknown> | undefined;
  }

  listOperations(campaignId: string): Record<string, unknown>[] {
    return this.store.db
      .prepare(
        `SELECT o.execution_id, o.campaign_id, o.invocation_id, o.state, o.next_poll_at, o.created_at,
                i.purpose, i.effect_class, i.state AS invocation_state, i.external_id
         FROM operations o
         LEFT JOIN invocations i ON i.id = o.invocation_id
         WHERE o.campaign_id = ?
         ORDER BY o.created_at ASC`,
      )
      .all(campaignId) as Record<string, unknown>[];
  }

  updateOperationState(executionId: string, state: string, nextPollAt: string | null = null): void {
    this.store.db
      .prepare("UPDATE operations SET state = ?, next_poll_at = ? WHERE execution_id = ?")
      .run(state, nextPollAt, executionId);
  }

  acquireResourceLock(campaignId: string, lockKey: string, invocationId: string, effectKnown: boolean): boolean {
    try {
      this.store.db
        .prepare("INSERT INTO resource_locks(lock_key, campaign_id, invocation_id, effect_known, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(lockKey, campaignId, invocationId, effectKnown ? 1 : 0, nowIso());
      return true;
    } catch {
      return false;
    }
  }

  listResourceLocks(campaignId?: string): { lock_key: string; campaign_id: string; invocation_id: string | null; effect_known: number }[] {
    if (campaignId) {
      return this.store.db
        .prepare("SELECT lock_key, campaign_id, invocation_id, effect_known FROM resource_locks WHERE campaign_id = ?")
        .all(campaignId) as { lock_key: string; campaign_id: string; invocation_id: string | null; effect_known: number }[];
    }
    return this.store.db
      .prepare("SELECT lock_key, campaign_id, invocation_id, effect_known FROM resource_locks")
      .all() as { lock_key: string; campaign_id: string; invocation_id: string | null; effect_known: number }[];
  }

  releaseResourceLocksForInvocation(campaignId: string, invocationId: string): void {
    this.store.db
      .prepare("DELETE FROM resource_locks WHERE campaign_id = ? AND invocation_id = ?")
      .run(campaignId, invocationId);
  }

  /** Known-effect locks only. Lease expiry / run finish must not call the unknown variant. */
  releaseKnownResourceLocks(campaignId: string, invocationId: string): void {
    this.store.db
      .prepare("DELETE FROM resource_locks WHERE campaign_id = ? AND invocation_id = ? AND effect_known = 1")
      .run(campaignId, invocationId);
  }

  releaseCampaignResourceLocks(campaignId: string): void {
    this.store.db.prepare("DELETE FROM resource_locks WHERE campaign_id = ?").run(campaignId);
  }

  explainStep(campaignId: string, stepId: string): Record<string, unknown> {
    const step = this.store.db.prepare("SELECT * FROM steps WHERE id = ? AND campaign_id = ?").get(stepId, campaignId) as
      | Record<string, unknown>
      | undefined;
    if (!step) throw invalidInput("step_not_found", "step not found");
    const runs = this.store.db
      .prepare("SELECT id, state, end_reason, outcome_json, attempt_no FROM task_runs WHERE step_id = ? ORDER BY attempt_no")
      .all(stepId) as Record<string, unknown>[];
    return {
      step_id: stepId,
      status: step.status,
      blocked_reason: step.blocked_reason,
      last_failure: step.last_failure,
      reopen_rule: step.reopen_rule_json,
      attempt_count: step.attempt_count,
      ready_since: step.ready_since,
      preconditions: step.preconditions_json,
      eligible: step.status === "ready",
      runs,
    };
  }

  admissionOpen(campaignId: string): boolean {
    const row = this.store.db.prepare("SELECT admission_open, state, cancel_epoch FROM campaigns WHERE id = ?").get(campaignId) as
      | { admission_open: number; state: string; cancel_epoch: number }
      | undefined;
    if (!row) return false;
    return row.admission_open === 1 && row.state !== "cancelled" && row.state !== "paused" && row.state !== "completed";
  }

  submit(
    campaignId: string,
    producerId: string,
    submissionId: string,
    payload: unknown,
    apply: () => IdempotentResult,
  ): IdempotentResult {
    return this.store.transaction(() => {
      const payloadHash = hashJson(payload);
      const existing = this.store.db
        .prepare("SELECT payload_hash, result_json FROM submissions WHERE campaign_id = ? AND producer_id = ? AND submission_id = ?")
        .get(campaignId, producerId, submissionId) as { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw conflict("submission_conflict", "same submission_id with different payload", {
            campaignId,
            producerId,
            submissionId,
          });
        }
        const replayed = fromJson<IdempotentResult>(existing.result_json, { status: "ok", canonical_ids: {}, seq: 0 });
        return { ...replayed, status: "replayed" };
      }
      const result = apply();
      this.store.db
        .prepare(
          "INSERT INTO submissions(campaign_id, producer_id, submission_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(campaignId, producerId, submissionId, payloadHash, asJson(result), nowIso());
      return result;
    });
  }

  async putArtifact(campaignId: string, body: string | Buffer, mime: string, producerAttempt?: string): Promise<StoredArtifact> {
    const stored = await this.artifacts.put(campaignId, body, mime);
    this.commitArtifact(stored, producerAttempt);
    return stored;
  }

  commitArtifact(stored: StoredArtifact, producerAttempt?: string): void {
    this.store.transaction(() => {
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO artifacts(id, campaign_id, hash, size, mime, path, producer_attempt, integrity_state, truncated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', 0, ?)`,
        )
        .run(stored.id, stored.campaign_id, stored.hash, stored.size, stored.mime, stored.path, producerAttempt ?? null, nowIso());
    });
  }

  listArtifacts(campaignId: string): Record<string, unknown>[] {
    return this.store.db.prepare("SELECT * FROM artifacts WHERE campaign_id = ?").all(campaignId) as Record<string, unknown>[];
  }

  scanOrphanArtifacts(campaignId: string): {
    path: string;
    hash: string | null;
    incomplete: boolean;
    registered: boolean;
  }[] {
    const registered = new Set(
      this.listArtifacts(campaignId)
        .map((r) => String(r.path))
        .concat(this.listArtifacts(campaignId).map((r) => String(r.hash))),
    );
    return this.artifacts.listOnDisk(campaignId).map((d) => ({
      path: d.path,
      hash: d.hash,
      incomplete: d.incomplete,
      registered: registered.has(d.path) || (d.hash !== null && registered.has(d.hash)),
    }));
  }

  reclaimOrphans(campaignId: string): { reclaimed: number; incomplete: number } {
    let reclaimed = 0;
    let incomplete = 0;
    for (const row of this.scanOrphanArtifacts(campaignId)) {
      if (row.incomplete) {
        incomplete += 1;
        continue;
      }
      if (row.registered || !row.hash) continue;
      if (!this.artifacts.verify(row.path, row.hash)) {
        incomplete += 1;
        continue;
      }
      const disk = this.artifacts.listOnDisk(campaignId).find((d) => d.path === row.path);
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO artifacts(id, campaign_id, hash, size, mime, path, producer_attempt, integrity_state, truncated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'orphan', 0, ?)`,
        )
        .run(`art_${row.hash}`, campaignId, row.hash, disk?.size ?? 0, "application/octet-stream", row.path, nowIso());
      this.store.db.prepare("UPDATE artifacts SET integrity_state = 'orphan' WHERE id = ? AND integrity_state != 'complete'").run(`art_${row.hash}`);
      reclaimed += 1;
    }
    return { reclaimed, incomplete };
  }

  snapshotReadSet(campaignId: string, refs: { table: string; id: string }[]): ReadSetEntry[] {
    const allowed = new Set(["goals", "steps", "facts", "findings", "coverage_items", "observations"]);
    return refs.map((r) => {
      if (!allowed.has(r.table)) throw invalidInput("read_set_table", `table ${r.table} is not in a decide read-set`);
      const row = this.store.db
        .prepare(`SELECT revision FROM ${r.table} WHERE id = ? AND campaign_id = ?`)
        .get(r.id, campaignId) as { revision: number } | undefined;
      if (!row) throw invalidInput("read_set_missing", `${r.table} ${r.id} not in campaign`);
      return { table: r.table, id: r.id, revision: row.revision };
    });
  }

  readSetConflicts(campaignId: string, readSet: ReadSetEntry[]): ReadSetEntry | null {
    const allowed = new Set(["goals", "steps", "facts", "findings", "coverage_items", "observations"]);
    for (const entry of readSet) {
      if (!allowed.has(entry.table)) return entry;
      const row = this.store.db
        .prepare(`SELECT revision FROM ${entry.table} WHERE id = ? AND campaign_id = ?`)
        .get(entry.id, campaignId) as { revision: number } | undefined;
      if (!row || row.revision !== entry.revision) return entry;
    }
    return null;
  }

  recordObservation(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id: string;
    attempt_id: string;
    subject: string;
    body: unknown;
    artifact_refs: string[];
    conditions: Record<string, unknown>;
    env_rev: string;
    identity_ref?: string;
    skip_progress?: boolean;
    /** Internal: raw tool dumps pass false; the fragment end requests review once. */
    request_review?: boolean;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, () => {
      this.assertRun(args.campaign_id, args.run_id);
      const now = nowIso();
      const id = newId("obs");
      const seq = this.appendEvent(
        args.campaign_id,
        "observation.recorded",
        { observation_id: id, subject: args.subject },
        { kind: "worker", id: args.run_id },
        id,
        args.submission_id,
      );
      this.store.db
        .prepare(
          `INSERT INTO observations(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, source_run_id, source_submission_id, attempt_id, artifact_refs_json, observed_at, subject, identity_ref, conditions_json, env_rev, collector_version, body_json)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'p0', ?)`,
        )
        .run(
          id,
          args.campaign_id,
          SCHEMA_VERSION,
          now,
          seq,
          seq,
          args.run_id,
          args.submission_id,
          args.attempt_id,
          asJson(args.artifact_refs),
          now,
          args.subject,
          args.identity_ref ?? null,
          asJson(args.conditions),
          args.env_rev,
          asJson(args.body),
        );
      if (!args.skip_progress) this.bumpProgress(args.campaign_id);
      if (args.request_review !== false) this.markRequested(args.campaign_id, seq);
      return { status: "ok", canonical_ids: { observation_id: id }, seq };
    });
  }

  submitFact(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id: string;
    proposition: string;
    fact_key?: string;
    support_refs: string[];
    conditions: Record<string, unknown>;
    env_rev?: string;
    identity_ref?: string;
    source_grade?: FactSourceGrade;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, (): IdempotentResult => {
      this.assertRun(args.campaign_id, args.run_id);
      const supportOk = args.support_refs.length > 0 && this.refsExist(args.campaign_id, args.support_refs);
      if (!supportOk) {
        return {
          status: "ok" as const,
          canonical_ids: {} as Record<string, string>,
          seq: this.getCampaign(args.campaign_id).event_head,
          reason: "rejected",
          extra: { submit_status: "rejected" satisfies SubmitFactResultStatus, detail: "missing_evidence" },
        };
      }
      const grade: FactSourceGrade = args.source_grade ?? "observed";
      if (grade === "verified") {
        throw denied("fact_verified_forbidden", "submit_fact cannot mark verified");
      }
      const now = nowIso();
      const id = newId("fact");
      let epistemic: EpistemicStatus = "accepted";
      let submitStatus: SubmitFactResultStatus = "accepted_as_observation";
      const campSpec = this.getCampaign(args.campaign_id).spec;
      const successKey = campSpec.root_goal.success_predicate_ref;
      const isGoalClaim = Boolean(args.fact_key && args.fact_key === successKey && successKey !== "sample_recovered");
      // derived stays proposed everywhere. A root-goal observation parks for
      // independent acceptance only when the campaign policy asks for it;
      // otherwise it is a normal accepted observed fact (still never verified).
      if (grade === "derived" || (isGoalClaim && requiresIndependentGoalVerification(campSpec))) {
        epistemic = "proposed";
        submitStatus = "pending_verification";
      }
      const opposite = this.findOpposite(args.campaign_id, args.proposition, args.fact_key);
      if (opposite) {
        epistemic = "disputed";
        this.store.db.prepare("UPDATE facts SET epistemic_status = 'disputed', revision = revision + 1 WHERE id = ?").run(opposite);
      }
      const seq = this.appendEvent(
        args.campaign_id,
        "fact.accepted",
        { fact_id: id, epistemic, grade, submit_status: submitStatus },
        { kind: "worker", id: args.run_id },
        id,
        args.submission_id,
      );
      this.store.db
        .prepare(
          `INSERT INTO facts(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, source_run_id, source_submission_id, proposition, fact_key, epistemic_status, source_grade, validity, support_refs_json, counter_refs_json, conditions_json, env_rev, observed_at, identity_ref)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          args.campaign_id,
          SCHEMA_VERSION,
          now,
          seq,
          seq,
          args.run_id,
          args.submission_id,
          args.proposition,
          args.fact_key ?? null,
          epistemic,
          grade,
          asJson(args.support_refs),
          asJson(opposite ? [opposite] : []),
          asJson(args.conditions),
          args.env_rev ?? null,
          now,
          args.identity_ref ?? null,
        );
      if (grade !== "derived") this.bumpProgress(args.campaign_id);
      this.markRequested(args.campaign_id, seq);
      this.recomputeStepReadiness(args.campaign_id);
      return {
        status: "ok",
        canonical_ids: { fact_id: id },
        seq,
        extra: { submit_status: submitStatus, epistemic },
      };
    });
  }

  submitFinding(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id: string;
    claim: string;
    evidence_refs: string[];
    dedup_key: string;
    impact?: string;
    conditions?: Record<string, unknown>;
    model_confidence?: number;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, (): IdempotentResult => {
      this.assertRun(args.campaign_id, args.run_id);
      if (args.evidence_refs.length === 0 || !this.refsExist(args.campaign_id, args.evidence_refs)) {
        return {
          status: "ok" as const,
          canonical_ids: {} as Record<string, string>,
          seq: this.getCampaign(args.campaign_id).event_head,
          reason: "rejected",
          extra: { status: "rejected", detail: "missing_evidence" },
        };
      }
      const existing = this.store.db
        .prepare("SELECT id, status FROM findings WHERE campaign_id = ? AND dedup_key = ?")
        .get(args.campaign_id, args.dedup_key) as { id: string; status: string } | undefined;
      if (existing) {
        return {
          status: "ok",
          canonical_ids: { finding_id: existing.id },
          seq: this.getCampaign(args.campaign_id).event_head,
          extra: { status: existing.status, deduped: true },
        };
      }
      const id = newId("find");
      const now = nowIso();
      const seq = this.appendEvent(
        args.campaign_id,
        "finding.proposed",
        { finding_id: id, claim: args.claim },
        { kind: "worker", id: args.run_id },
        id,
        args.submission_id,
      );
      this.store.db
        .prepare(
          `INSERT INTO findings(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, source_run_id, source_submission_id, claim, scope_json, conditions_json, evidence_refs_json, verification_refs_json, status, dedup_key, impact, confidence_model)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '{}', ?, ?, '[]', 'suspected', ?, ?, ?)`,
        )
        .run(
          id,
          args.campaign_id,
          SCHEMA_VERSION,
          now,
          seq,
          seq,
          args.run_id,
          args.submission_id,
          args.claim,
          asJson(args.conditions ?? {}),
          asJson(args.evidence_refs),
          args.dedup_key,
          args.impact ?? null,
          args.model_confidence != null ? String(args.model_confidence) : null,
        );
      this.markRequested(args.campaign_id, seq);
      return { status: "ok", canonical_ids: { finding_id: id }, seq, extra: { status: "suspected" } };
    });
  }

  setFindingStatus(campaignId: string, findingId: string, to: FindingStatus, actor: Actor): void {
    this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT status FROM findings WHERE id = ? AND campaign_id = ?").get(findingId, campaignId) as
        | { status: FindingStatus }
        | undefined;
      if (!row) throw invalidInput("finding_not_found", "finding not found");
      transitionFinding(row.status, to);
      this.store.db.prepare("UPDATE findings SET status = ?, revision = revision + 1 WHERE id = ?").run(to, findingId);
      this.appendEvent(campaignId, "finding.status_changed", { finding_id: findingId, from: row.status, to }, actor, findingId);
    });
  }

  /**
   * Fingerprint resolution for propose_step. Explicit fingerprints pass through
   * unchanged. Otherwise: if a live step still carries the legacy default
   * (kind|method|question), merge into it; only then mint the richer default
   * that also binds goal refs, evidence refs and preconditions — so the same
   * question at a different goal or with different evidence never merges.
   */
  stepFingerprintResolve(
    campaignId: string,
    step: {
      kind: string;
      methodFamily: string;
      question: string;
      goalRefs: string[];
      inputRefs: { id: string }[];
      preconditions: unknown;
      explicit?: string;
    },
  ): string {
    if (step.explicit) return step.explicit;
    const legacy = legacyStepFingerprint(step.kind, step.methodFamily, step.question);
    const legacyHit = this.store.db
      .prepare("SELECT id FROM steps WHERE campaign_id = ? AND fingerprint = ? AND status != 'retired'")
      .get(campaignId, legacy);
    if (legacyHit) return legacy;
    return defaultStepFingerprint(step);
  }

  proposeStepDirect(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id?: string;
    question: string;
    kind: StepKind;
    goal_refs: string[];
    preconditions: PredicateExpr;
    method_family: string;
    expected_observations: string[];
    completion_criteria: string;
    fingerprint: string;
    reopen_rule: WakeCondition;
    branch_id?: string;
    input_refs?: { id: string; revision: number }[];
    priority?: number;
    retry_reason?: string;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, (): IdempotentResult => {
      this.assertRefsSameCampaign(args.campaign_id, args.goal_refs);
      if (args.input_refs) {
        for (const ref of args.input_refs) {
          this.assertEntityCampaign(args.campaign_id, ref.id);
        }
      }
      const dup = this.store.db
        .prepare("SELECT id, status, attempt_count FROM steps WHERE campaign_id = ? AND fingerprint = ? AND status != 'retired'")
        .get(args.campaign_id, args.fingerprint) as { id: string; status: string; attempt_count: number } | undefined;
      if (dup) {
        if (args.retry_reason) {
          this.store.db
            .prepare("UPDATE steps SET retry_reason = ?, revision = revision + 1 WHERE id = ?")
            .run(args.retry_reason, dup.id);
        }
        return {
          status: "ok" as const,
          canonical_ids: { step_id: dup.id } as Record<string, string>,
          seq: this.getCampaign(args.campaign_id).event_head,
          extra: { merged: true, attempt_count: dup.attempt_count },
        };
      }
      const id = newId("step");
      const branch = args.branch_id ?? newId("br");
      const now = nowIso();
      const seq = this.appendEvent(
        args.campaign_id,
        "step.proposed",
        { step_id: id, question: args.question, kind: args.kind },
        { kind: "worker", id: args.run_id ?? args.producer_id },
        id,
        args.submission_id,
      );
      const ready = this.preconditionValue(args.campaign_id, args.preconditions);
      let status: StepStatus = "proposed";
      let blocked: string | null = null;
      if (ready === "true") status = "ready";
      else if (ready === "unknown" || ready === "false") {
        status = "blocked";
        blocked = ready === "unknown" ? "unknown_precondition" : "precondition_false";
      }
      this.store.db
        .prepare(
          `INSERT INTO steps(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, source_run_id, source_submission_id, branch_id, kind, question, goal_refs_json, input_refs_json, preconditions_json, method_family, expected_observations_json, completion_criteria, resource_claims_json, budget_hint_json, fingerprint, reopen_rule_json, status, priority, ready_since, attempt_count, retry_reason, blocked_reason)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          args.campaign_id,
          SCHEMA_VERSION,
          now,
          seq,
          seq,
          args.run_id ?? null,
          args.submission_id,
          branch,
          args.kind,
          args.question,
          asJson(args.goal_refs),
          asJson(args.input_refs ?? []),
          asJson(args.preconditions),
          args.method_family,
          asJson(args.expected_observations),
          args.completion_criteria,
          args.fingerprint,
          asJson(args.reopen_rule),
          status,
          args.priority ?? 100,
          status === "ready" ? now : null,
          args.retry_reason ?? null,
          blocked,
        );
      if (status === "ready") {
        this.appendEvent(args.campaign_id, "step.ready", { step_id: id }, { kind: "controller", id: "scheduler" }, id);
      } else if (status === "blocked") {
        this.appendEvent(args.campaign_id, "step.blocked", { step_id: id, reason: blocked }, { kind: "controller", id: "scheduler" }, id);
      }
      this.markRequested(args.campaign_id, seq);
      return { status: "ok", canonical_ids: { step_id: id, branch_id: branch }, seq, extra: { step_status: status } };
    });
  }

  applyProposalBatch(args: {
    campaign_id: string;
    producer_id: string;
    submission_id: string;
    run_id: string;
    operations: unknown;
    no_change_reason?: string;
    read_set?: ReadSetEntry[];
    /** Internal: the graph snapshot the Decide run actually saw (H). The model
     *  never sends this; the worker fills it from the context manifest. */
    reviewed_through_seq?: number;
  }): IdempotentResult {
    return this.submit(args.campaign_id, args.producer_id, args.submission_id, args, () => {
      const camp = this.getCampaign(args.campaign_id);
      if (args.read_set && args.read_set.length > 0) {
        const conflictEntry = this.readSetConflicts(args.campaign_id, args.read_set);
        if (conflictEntry) {
          throw conflict("read_set_conflict", "relevant entity revision changed", {
            table: conflictEntry.table,
            id: conflictEntry.id,
            expected_revision: conflictEntry.revision,
          });
        }
      }
      // Only confirm what the model could actually have read. Inputs that
      // arrived during the run (seq > H) stay unreviewed and retrigger Decide.
      const H = Math.max(camp.reviewed_seq, args.reviewed_through_seq ?? camp.event_head);
      const readSetJson = asJson(args.read_set ?? []);
      const ops = parseProposalOps(args.operations);
      if (ops.length === 0) {
        const seq = this.appendEvent(args.campaign_id, "decision.committed", { no_change: true }, { kind: "worker", id: args.run_id });
        this.store.db
          .prepare(
            "INSERT INTO decision_runs(id, campaign_id, run_id, read_set_json, operations_json, committed, reviewed_seq, reason, created_at) VALUES (?, ?, ?, ?, '[]', 1, ?, ?, ?)",
          )
          .run(newId("dec"), args.campaign_id, args.run_id, readSetJson, H, args.no_change_reason ?? "no_change", nowIso());
        // A no_change with a live frontier means "the plan still fits", not
        // "the search is idle" — only an empty frontier spends review budget.
        const frontierEmpty = this.counts(args.campaign_id).frontier === 0;
        this.store.db
          .prepare("UPDATE campaigns SET reviewed_seq = MAX(reviewed_seq, ?), empty_reviews = empty_reviews + ?, updated_at = ? WHERE id = ?")
          .run(H, frontierEmpty ? 1 : 0, nowIso(), args.campaign_id);
        return { status: "ok", canonical_ids: {}, seq, extra: { no_change: true } };
      }
      const ids: Record<string, string> = {};
      let seq = camp.event_head;
      let material = false;
      for (const op of ops) {
        seq = this.applyOneOp(args.campaign_id, args.run_id, args.submission_id, op, ids);
        if (op.op === "propose_step" || op.op === "retire_step" || op.op === "propose_subgoal" || op.op === "retire_subgoal") {
          material = true;
        }
      }
      this.store.db
        .prepare(
          "INSERT INTO decision_runs(id, campaign_id, run_id, read_set_json, operations_json, committed, reviewed_seq, reason, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?)",
        )
        .run(newId("dec"), args.campaign_id, args.run_id, readSetJson, asJson(ops), H, nowIso());
      if (material) {
        this.store.db
          .prepare("UPDATE campaigns SET reviewed_seq = MAX(reviewed_seq, ?), empty_reviews = 0, updated_at = ? WHERE id = ?")
          .run(H, nowIso(), args.campaign_id);
      } else {
        this.store.db
          .prepare("UPDATE campaigns SET reviewed_seq = MAX(reviewed_seq, ?), updated_at = ? WHERE id = ?")
          .run(H, nowIso(), args.campaign_id);
      }
      this.appendEvent(args.campaign_id, "decision.committed", { ops: ops.map((o) => o.op) }, { kind: "worker", id: args.run_id });
      return { status: "ok", canonical_ids: ids, seq };
    });
  }

  failDecision(campaignId: string, runId: string, reason: string): void {
    this.store.db
      .prepare(
        "INSERT INTO decision_runs(id, campaign_id, run_id, read_set_json, operations_json, committed, reviewed_seq, reason, created_at) VALUES (?, ?, ?, '[]', '[]', 0, NULL, ?, ?)",
      )
      .run(newId("dec"), campaignId, runId, reason, nowIso());
  }

  claimNextStep(campaignId: string, owner: string, fenceSeed: number, leaseMs = 60 * 60_000): { step_id: string; run_id: string; fence: number; kind: StepKind; question: string; attempt_no: number } | null {
    return this.store.transaction(() => {
      if (!this.admissionOpen(campaignId)) return null;
      const camp = this.getCampaign(campaignId);
      if (camp.state === "cancelled" || camp.state === "paused" || camp.state === "budget_paused" || camp.state === "completed") {
        return null;
      }
      const lock = this.store.db.prepare("SELECT execute_lock_owner FROM campaigns WHERE id = ?").get(campaignId) as
        | { execute_lock_owner: string | null }
        | undefined;
      if (lock?.execute_lock_owner) return null;
      this.recomputeStepReadiness(campaignId);
      const fairId = pickFairReadyStep(this, campaignId);
      const step = fairId
        ? (this.store.db
            .prepare("SELECT id, kind, question, attempt_count, revision FROM steps WHERE id = ?")
            .get(fairId) as { id: string; kind: StepKind; question: string; attempt_count: number; revision: number } | undefined)
        : (this.store.db
            .prepare(
              `SELECT id, kind, question, attempt_count, revision FROM steps
           WHERE campaign_id = ? AND status = 'ready'
           ORDER BY CASE kind WHEN 'verify' THEN 0 WHEN 'reconcile' THEN 1 WHEN 'acquire_prerequisite' THEN 2 ELSE 3 END,
                    priority ASC, ready_since ASC
           LIMIT 1`,
            )
            .get(campaignId) as { id: string; kind: StepKind; question: string; attempt_count: number; revision: number } | undefined);
      if (!step) return null;
      transitionStep("ready", "leased");
      const now = nowIso();
      const attempt = step.attempt_count + 1;
      this.store.db
        .prepare("UPDATE steps SET status = 'leased', attempt_count = ?, last_served_at = ?, revision = revision + 1, updated_seq = updated_seq WHERE id = ?")
        .run(attempt, now, step.id);
      const runId = newId("run");
      const fence = fenceSeed + attempt;
      this.store.db
        .prepare(
          `INSERT INTO task_runs(id, campaign_id, step_id, mode, kind, attempt_no, lease_owner, fence, deadline_ms, state, continuation_of, finish_requested, env_admission, created_at, updated_at)
           VALUES (?, ?, ?, 'execute', ?, ?, ?, ?, ?, 'claimed', NULL, 0, 1, ?, ?)`,
        )
        .run(runId, campaignId, step.id, step.kind, attempt, owner, fence, Date.now() + leaseMs, now, now);
      this.store.db
        .prepare("UPDATE campaigns SET execute_lock_owner = ?, execute_run_id = ?, updated_at = ? WHERE id = ?")
        .run(owner, runId, now, campaignId);
      this.appendEvent(campaignId, "run.claimed", { run_id: runId, step_id: step.id }, { kind: "controller", id: owner }, runId);
      this.store.db.prepare("UPDATE steps SET status = 'running', active_run_id = ?, revision = revision + 1 WHERE id = ?").run(runId, step.id);
      this.store.db.prepare("UPDATE task_runs SET state = 'running', updated_at = ? WHERE id = ?").run(now, runId);
      return { step_id: step.id, run_id: runId, fence, kind: step.kind, question: step.question, attempt_no: attempt };
    });
  }

  claimDecide(campaignId: string, owner: string, leaseMs = 60 * 60_000): { run_id: string; fence: number } | null {
    return this.store.transaction(() => {
      const camp = this.getCampaign(campaignId);
      if (camp.state === "cancelled" || camp.state === "paused" || camp.state === "completed") return null;
      const row = this.store.db.prepare("SELECT decide_lock_owner, requested_seq, reviewed_seq FROM campaigns WHERE id = ?").get(campaignId) as
        | { decide_lock_owner: string | null; requested_seq: number; reviewed_seq: number }
        | undefined;
      if (!row) return null;
      if (row.decide_lock_owner) return null;
      if (row.requested_seq <= row.reviewed_seq && camp.state !== "created" && camp.state !== "active") {
        // still allow first decide
      }
      const runId = newId("run");
      const now = nowIso();
      this.store.db.prepare("UPDATE campaigns SET decide_lock_owner = ?, updated_at = ? WHERE id = ?").run(owner, now, campaignId);
      this.store.db
        .prepare(
          `INSERT INTO task_runs(id, campaign_id, step_id, mode, kind, attempt_no, lease_owner, fence, deadline_ms, state, continuation_of, finish_requested, env_admission, created_at, updated_at)
           VALUES (?, ?, NULL, 'decide', 'decide', 1, ?, 1, ?, 'running', NULL, 0, 0, ?, ?)`,
        )
        .run(runId, campaignId, owner, Date.now() + leaseMs, now, now);
      this.appendEvent(campaignId, "run.claimed", { run_id: runId, mode: "decide" }, { kind: "controller", id: owner }, runId);
      return { run_id: runId, fence: 1 };
    });
  }

  finishRun(campaignId: string, runId: string, outcome: TaskOutcome): { applied: boolean } {
    return this.store.transaction(() => {
      const run = this.store.db.prepare("SELECT * FROM task_runs WHERE id = ? AND campaign_id = ?").get(runId, campaignId) as
        | Record<string, unknown>
        | undefined;
      if (!run) throw invalidInput("run_not_found", "run not found");
      if (String(run.state) === "finished") return { applied: false };
      let appliedOutcome = outcome;
      if (run.finish_payload_json && run.mode === "execute") {
        appliedOutcome = this.outcomeFromFinishPayload(run, String(run.finish_payload_json));
      }
      const now = nowIso();
      const cas = this.store.db
        .prepare(
          `UPDATE task_runs SET state = 'finished', end_reason = ?, outcome_json = ?, updated_at = ?
           WHERE id = ? AND campaign_id = ? AND fence = ? AND state IN ('claimed', 'running')`,
        )
        .run(appliedOutcome.reason, asJson(appliedOutcome), now, runId, campaignId, Number(run.fence));
      if (Number(cas.changes) === 0) return { applied: false };
      if (run.mode === "decide") {
        this.store.db.prepare("UPDATE campaigns SET decide_lock_owner = NULL, updated_at = ? WHERE id = ?").run(now, campaignId);
      } else {
        this.store.db
          .prepare(
            "UPDATE campaigns SET execute_lock_owner = NULL, execute_run_id = NULL, updated_at = ? WHERE id = ? AND (execute_run_id = ? OR execute_run_id IS NULL)",
          )
          .run(now, campaignId, runId);
        const stepId = run.step_id as string | null;
        if (stepId) {
          const next = outcomeToStepStatus(appliedOutcome.reason);
          const step = this.store.db.prepare("SELECT status, active_run_id FROM steps WHERE id = ?").get(stepId) as {
            status: StepStatus;
            active_run_id: string | null;
          };
          const owns = !step.active_run_id || String(step.active_run_id) === runId;
          if (owns && (step.status === "running" || step.status === "leased")) {
            transitionStep(step.status === "leased" ? "running" : "running", next);
            const park =
              next === "deferred" || next === "blocked"
                ? asJson(appliedOutcome.reopen_rule ?? parkRuleForReason(appliedOutcome.reason))
                : null;
            const nextAction = appliedOutcome.reason === "deferred" || appliedOutcome.reason === "blocked"
              ? this.nextActionFromOutcome(appliedOutcome)
              : null;
            this.store.db
              .prepare(
                `UPDATE steps SET status = ?, blocked_reason = ?, last_failure = ?,
                  reopen_rule_json = COALESCE(?, reopen_rule_json),
                  next_action = COALESCE(?, next_action),
                  active_run_id = NULL,
                  ready_since = CASE WHEN ? = 'ready' THEN ? ELSE ready_since END,
                  revision = revision + 1 WHERE id = ? AND (active_run_id = ? OR active_run_id IS NULL)`,
              )
              .run(
                next,
                appliedOutcome.blocked_on,
                appliedOutcome.summary,
                park,
                nextAction,
                next,
                now,
                stepId,
                runId,
              );
            if (nextAction) {
              this.saveCheckpoint({
                campaign_id: campaignId,
                run_id: runId,
                note: nextAction,
                next: nextAction,
                payload: { step_id: stepId, source: "finish_next_action" },
              });
            }
            if (next === "ready") {
              this.appendEvent(campaignId, "step.ready", { step_id: stepId }, { kind: "controller", id: "scheduler" }, stepId);
            }
          }
        }
      }
      this.appendEvent(campaignId, "run.finished", { run_id: runId, outcome: appliedOutcome }, { kind: "controller", id: "engine" }, runId);
      if (run.mode !== "decide") {
        this.markRequested(campaignId, this.getCampaign(campaignId).event_head);
      }
      this.projectExecuteOutcome(campaignId, run, appliedOutcome);
      return { applied: true };
    });
  }

  private nextActionFromOutcome(outcome: TaskOutcome): string | null {
    const extra = outcome as TaskOutcome & { next_action?: string };
    if (typeof extra.next_action === "string" && extra.next_action.length > 0) return extra.next_action;
    return null;
  }

  projectExecuteOutcome(campaignId: string, run: Record<string, unknown>, outcome: TaskOutcome): void {
    if (run.mode !== "execute") return;
    if (String(run.kind) === "verify" && outcome.reason === "resolved") {
      // A verify run only affects the finding/finding-candidate it explicitly
      // names, and only through an explicit model verdict. "Run resolved" plus
      // "some artifact exists" no longer confirms anything.
      const vr = outcome.verification_result;
      if (vr) this.applyTargetedVerification(campaignId, run, vr);
    }
    // Coverage moves only through explicit per-obligation results, never by
    // "this step resolved and the campaign has artifacts".
    if (outcome.coverage_result && outcome.coverage_result.length > 0) {
      this.applyCoverageResults(campaignId, run, outcome.coverage_result);
    }
  }

  /** Explicit per-obligation test results from an assessment run's finish. */
  private applyCoverageResults(
    campaignId: string,
    run: Record<string, unknown>,
    results: { coverage_id: string; outcome: string; evidence_refs: string[]; note: string }[],
  ): void {
    const reject = (coverageId: string, reason: string): void => {
      this.appendEvent(
        campaignId,
        "coverage.result_rejected",
        { run_id: String(run.id), coverage_id: coverageId, reason },
        { kind: "controller", id: "coverage" },
        coverageId,
      );
    };
    if (this.getCampaign(campaignId).spec.mode !== "assessment") {
      for (const r of results) reject(r.coverage_id, "not_assessment");
      return;
    }
    for (const r of results.slice(0, 8)) {
      const item = this.store.db
        .prepare("SELECT id, obligation FROM coverage_items WHERE id = ? AND campaign_id = ?")
        .get(r.coverage_id, campaignId) as { id: string; obligation: string } | undefined;
      if (!item) {
        reject(r.coverage_id, "unknown_coverage_id");
        continue;
      }
      let refsOk = false;
      try {
        refsOk = r.evidence_refs.length > 0 && this.refsExist(campaignId, r.evidence_refs);
      } catch {
        refsOk = false;
      }
      if (!refsOk) {
        reject(r.coverage_id, "missing_evidence");
        continue;
      }
      const outcome = r.outcome as "no_issue_observed" | "suspected" | "confirmed" | "inconclusive";
      this.updateCoverageById(campaignId, item.id, {
        execution_state: "tested",
        outcome,
        evidence_state: "current",
      });
      this.appendEvent(
        campaignId,
        "coverage.result_applied",
        { run_id: String(run.id), coverage_id: item.id, obligation: item.obligation, outcome, note: r.note.slice(0, 400) },
        { kind: "controller", id: "coverage" },
        item.id,
      );
    }
  }

  /**
   * Apply an explicit verdict to its named target. Necessary conditions only:
   * the target is this step's declared target, the evidence exists, belongs to
   * this campaign, is fresh for the current env, and a confirm verdict needs at
   * least one evidence item produced by this very verify run (independent
   * reproduction, not re-citing the original claim's evidence). Rejections are
   * events, never thrown: a bogus verdict must not roll back the run's finish.
   */
  private applyTargetedVerification(
    campaignId: string,
    run: Record<string, unknown>,
    vr: { target_id: string; verdict: "confirmed" | "refuted" | "inconclusive"; evidence_refs: string[]; rationale: string },
  ): void {
    const reject = (reason: string): void => {
      this.appendEvent(
        campaignId,
        "verification.rejected",
        { run_id: String(run.id), target_id: vr.target_id, verdict: vr.verdict, reason },
        { kind: "controller", id: "verify" },
        String(run.step_id ?? ""),
      );
    };
    const stepId = run.step_id ? String(run.step_id) : null;
    const step = stepId
      ? (this.store.db.prepare("SELECT input_refs_json, question FROM steps WHERE id = ? AND campaign_id = ?").get(stepId, campaignId) as
          | { input_refs_json: string; question: string }
          | undefined)
      : undefined;
    let inputRefs: { id: string }[] = [];
    try {
      const parsed = JSON.parse(step?.input_refs_json ?? "[]") as unknown;
      if (Array.isArray(parsed)) inputRefs = parsed.filter((x): x is { id: string } => Boolean(x && typeof (x as { id?: unknown }).id === "string"));
    } catch {
      inputRefs = [];
    }
    // Legacy verify steps predate input_refs; fall back to the framed question
    // "verify <target> via <method>" and still require a same-campaign target.
    const legacyMatch = step?.question.match(/^verify (\S+) via /);
    const declared = new Set(inputRefs.map((r) => r.id));
    if (legacyMatch && declared.size === 0) declared.add(legacyMatch[1]!);
    if (!declared.has(vr.target_id)) {
      reject("target_not_declared");
      return;
    }
    if (vr.evidence_refs.length === 0) {
      reject("missing_evidence");
      return;
    }
    let refsOk: boolean;
    try {
      refsOk = this.refsExist(campaignId, vr.evidence_refs);
    } catch {
      reject("cross_campaign_evidence");
      return;
    }
    if (!refsOk) {
      reject("missing_evidence");
      return;
    }
    if (vr.verdict === "confirmed") {
      const env = String(
        (this.getWorld<{ env_rev?: string }>(campaignId, { env_rev: this.getCampaign(campaignId).spec.environment_revision }) as {
          env_rev?: string;
        }).env_rev ?? this.getCampaign(campaignId).spec.environment_revision,
      );
      for (const ref of vr.evidence_refs) {
        const obs = this.store.db.prepare("SELECT env_rev FROM observations WHERE id = ?").get(ref) as { env_rev: string } | undefined;
        if (obs && obs.env_rev !== env) {
          reject("stale_evidence");
          return;
        }
      }
      const fromThisRun = vr.evidence_refs.some((ref) => {
        const obs = this.store.db.prepare("SELECT source_run_id FROM observations WHERE id = ?").get(ref) as
          | { source_run_id: string | null }
          | undefined;
        if (obs?.source_run_id === String(run.id)) return true;
        const art = this.store.db.prepare("SELECT producer_attempt FROM artifacts WHERE id = ?").get(ref) as
          | { producer_attempt: string | null }
          | undefined;
        return art?.producer_attempt === String(run.id);
      });
      if (!fromThisRun) {
        reject("not_independent");
        return;
      }
    }
    const applied = applyVerification(this, campaignId, vr.target_id, vr.verdict);
    this.appendEvent(
      campaignId,
      "verification.applied",
      {
        run_id: String(run.id),
        target_id: vr.target_id,
        verdict: vr.verdict,
        resulting_status: applied,
        rationale: vr.rationale.slice(0, 400),
        evidence_refs: vr.evidence_refs,
      },
      { kind: "controller", id: "verify" },
      vr.target_id,
    );
  }

  markFinishRequested(campaignId: string, runId: string, fence: number): void {
    const run = this.store.db.prepare("SELECT fence FROM task_runs WHERE id = ? AND campaign_id = ?").get(runId, campaignId) as
      | { fence: number }
      | undefined;
    if (!run || run.fence !== fence) {
      throw denied("stale_fence", "finish rejected due to stale fence");
    }
    this.store.db
      .prepare("UPDATE task_runs SET finish_requested = 1, env_admission = 0, updated_at = ? WHERE id = ?")
      .run(nowIso(), runId);
  }

  submitRunOutcome(args: SubmitRunOutcomeArgs): SubmitRunOutcomeResult {
    return this.store.transaction(() => {
      const run = this.store.db.prepare("SELECT * FROM task_runs WHERE id = ? AND campaign_id = ?").get(args.run_id, args.campaign_id) as
        | Record<string, unknown>
        | undefined;
      if (!run) throw invalidInput("run_not_found", "run not found");
      if (Number(run.fence) !== args.fence) {
        throw denied("stale_fence", "finish rejected due to stale fence");
      }
      const parsed = parseFinishInput(args.payload);
      if (!parsed.ok) {
        this.appendEvent(
          args.campaign_id,
          "run.finish_validation_error",
          { run_id: args.run_id, error: parsed.error, submission_id: args.submission_id },
          { kind: "worker", id: args.run_id },
          args.run_id,
          args.submission_id,
        );
        return { accepted: false, duplicate: false, conflict: false, outcome: null, error: parsed.error };
      }
      if (args.source === "finalizer" && (parsed.value.verification_result || (parsed.value.coverage_result?.length ?? 0) > 0)) {
        // Finalize ends a fragment; it never mints first-time verdicts or coverage conclusions.
        this.appendEvent(
          args.campaign_id,
          "verification.dropped_finalizer",
          {
            run_id: args.run_id,
            target_id: parsed.value.verification_result?.target_id ?? null,
            coverage_items: parsed.value.coverage_result?.length ?? 0,
          },
          { kind: "controller", id: "verify" },
          args.run_id,
          args.submission_id,
        );
        parsed.value.verification_result = undefined;
        parsed.value.coverage_result = undefined;
      }
      const evidenceErr = this.validateFinishEvidence(args.campaign_id, args.run_id, parsed.value);
      if (evidenceErr) {
        this.appendEvent(
          args.campaign_id,
          "run.finish_validation_error",
          { run_id: args.run_id, error: evidenceErr, submission_id: args.submission_id },
          { kind: "worker", id: args.run_id },
          args.run_id,
          args.submission_id,
        );
        return { accepted: false, duplicate: false, conflict: false, outcome: null, error: evidenceErr };
      }
      const stored = run.finish_payload_json ? (fromJson<FinishPayload>(String(run.finish_payload_json), null as unknown as FinishPayload) as FinishPayload | null) : null;
      if (stored) {
        const same = canonicalizeFinishPayload(stored) === canonicalizeFinishPayload(parsed.value);
        if (same) {
          const outcome = this.outcomeFromFinishPayload(run, String(run.finish_payload_json));
          return { accepted: true, duplicate: true, conflict: false, outcome };
        }
        this.appendEvent(
          args.campaign_id,
          "run.finish_conflict",
          { run_id: args.run_id, submission_id: args.submission_id },
          { kind: "worker", id: args.run_id },
          args.run_id,
          args.submission_id,
        );
        return {
          accepted: false,
          duplicate: false,
          conflict: true,
          outcome: this.outcomeFromFinishPayload(run, String(run.finish_payload_json)),
          error: "finish_conflict",
        };
      }
      if (String(run.state) !== "running" && String(run.state) !== "claimed") {
        return { accepted: false, duplicate: false, conflict: false, outcome: null, error: "run_not_running" };
      }
      const payload: FinishPayload = {
        ...parsed.value,
        submission_id: args.submission_id,
        observation_ids: args.observation_ids,
        fact_ids: args.fact_ids,
        finding_ids: args.finding_ids,
        source: args.source,
      };
      const now = nowIso();
      this.store.db
        .prepare(
          "UPDATE task_runs SET finish_requested = 1, env_admission = 0, finish_submission_id = ?, finish_payload_json = ?, finish_submitted_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(args.submission_id, asJson(payload), now, now, args.run_id);
      this.appendEvent(
        args.campaign_id,
        "run.finish_submitted",
        {
          run_id: args.run_id,
          step_id: run.step_id,
          trigger: args.source,
          submission_id: args.submission_id,
          disposition: parsed.value.disposition,
        },
        { kind: "worker", id: args.run_id },
        args.run_id,
        args.submission_id,
      );
      if (parsed.usedLegacyReason) {
        this.appendEvent(
          args.campaign_id,
          "run.finish_reason_alias",
          { run_id: args.run_id, submission_id: args.submission_id },
          { kind: "worker", id: args.run_id },
          args.run_id,
        );
      }
      const outcome = this.outcomeFromFinishPayload(this.getRun(args.run_id), asJson(payload));
      return { accepted: true, duplicate: false, conflict: false, outcome };
    });
  }

  recordPrimaryStop(
    campaignId: string,
    runId: string,
    trigger: PrimaryStopTrigger,
    stepId: string | null,
    lastError: string | null = null,
  ): void {
    this.store.db
      .prepare("UPDATE task_runs SET primary_stop_trigger = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ?")
      .run(trigger, lastError, nowIso(), runId);
    this.appendEvent(
      campaignId,
      "run.primary_stopped",
      { run_id: runId, step_id: stepId, trigger, last_error: lastError },
      { kind: "worker", id: runId },
      runId,
    );
  }

  beginFinalization(campaignId: string, runId: string, trigger: PrimaryStopTrigger, stepId: string | null): void {
    this.store.db
      .prepare("UPDATE task_runs SET finalize_attempted = 1, primary_stop_trigger = ?, updated_at = ? WHERE id = ?")
      .run(trigger, nowIso(), runId);
    this.appendEvent(
      campaignId,
      "run.finalization_started",
      { run_id: runId, step_id: stepId, trigger },
      { kind: "controller", id: "engine" },
      runId,
    );
  }

  markFinalizationFailed(campaignId: string, runId: string, error: string, stepId: string | null): void {
    this.appendEvent(
      campaignId,
      "run.finalization_failed",
      { run_id: runId, step_id: stepId, error },
      { kind: "controller", id: "engine" },
      runId,
    );
  }

  evidenceExists(campaignId: string, id: string): { ok: boolean; error?: string } {
    const tables = ["observations", "facts", "findings", "artifacts"] as const;
    for (const t of tables) {
      const row = this.store.db.prepare(`SELECT campaign_id FROM ${t} WHERE id = ?`).get(id) as { campaign_id: string } | undefined;
      if (row) {
        if (row.campaign_id !== campaignId) return { ok: false, error: "cross_campaign_evidence" };
        return { ok: true };
      }
    }
    return { ok: false, error: "unknown_evidence" };
  }

  finalizationStats(campaignId: string): FinalizationStats {
    const execute_runs_total = Number(
      (this.store.db.prepare("SELECT COUNT(*) AS c FROM task_runs WHERE campaign_id = ? AND mode = 'execute'").get(campaignId) as { c: number }).c,
    );
    const finish_primary_total = this.countEvents(campaignId, "run.finish_submitted", (p) => p.trigger === "primary");
    const finalizer_started_total = this.countEvents(campaignId, "run.finalization_started");
    const finalizer_committed_total = this.countEvents(campaignId, "run.finish_submitted", (p) => p.trigger === "finalizer");
    const finalizer_failed_total = this.countEvents(campaignId, "run.finalization_failed");
    const incomplete_protocol_total = Number(
      (this.store.db
        .prepare("SELECT COUNT(*) AS c FROM task_runs WHERE campaign_id = ? AND mode = 'execute' AND end_reason = 'incomplete_protocol'")
        .get(campaignId) as { c: number }).c,
    );
    const finish_conflict_total = this.countEvents(campaignId, "run.finish_conflict");
    const finish_validation_error_total = this.countEvents(campaignId, "run.finish_validation_error");
    const div = (a: number, b: number): number | null => (b === 0 ? null : a / b);
    return {
      execute_runs_total,
      finish_primary_total,
      finalizer_started_total,
      finalizer_committed_total,
      finalizer_failed_total,
      incomplete_protocol_total,
      finish_conflict_total,
      finish_validation_error_total,
      primary_finish_rate: div(finish_primary_total, execute_runs_total),
      finalizer_success_rate: div(finalizer_committed_total, finalizer_started_total),
      protocol_complete_rate: div(finish_primary_total + finalizer_committed_total, execute_runs_total),
    };
  }

  private countEvents(campaignId: string, type: string, pred?: (p: Record<string, unknown>) => boolean): number {
    const rows = this.store.db
      .prepare("SELECT payload_json FROM events WHERE campaign_id = ? AND type = ?")
      .all(campaignId, type) as { payload_json: string }[];
    if (!pred) return rows.length;
    return rows.filter((r) => pred(fromJson(r.payload_json, {}))).length;
  }

  private validateFinishEvidence(campaignId: string, runId: string, input: { disposition: string; evidence_refs: string[] }): string | null {
    const run = this.getRun(runId);
    const stepId = run.step_id ? String(run.step_id) : null;
    let requires = true;
    if (stepId) {
      const step = this.store.db
        .prepare("SELECT completion_criteria, expected_observations_json FROM steps WHERE id = ?")
        .get(stepId) as { completion_criteria: string; expected_observations_json: string } | undefined;
      if (step) {
        requires = stepRequiresEvidence(step.completion_criteria, fromJson(step.expected_observations_json, []));
      }
    }
    if (input.disposition === "resolved" && requires && input.evidence_refs.length === 0) {
      return "resolved_requires_evidence";
    }
    for (const id of input.evidence_refs) {
      const hit = this.evidenceExists(campaignId, id);
      if (!hit.ok) return hit.error ?? "unknown_evidence";
    }
    return null;
  }

  private outcomeFromFinishPayload(run: Record<string, unknown>, payloadJson: string): TaskOutcome {
    const payload = fromJson<FinishPayload>(payloadJson, {
      disposition: "deferred",
      summary: "invalid payload",
      evidence_refs: [],
      submission_id: "",
      observation_ids: [],
      fact_ids: [],
      finding_ids: [],
      source: "primary",
    });
    const reason = isSemanticDisposition(payload.disposition) ? payload.disposition : "incomplete_protocol";
    return {
      run_id: String(run.id),
      step_id: run.step_id ? String(run.step_id) : null,
      mode: run.mode === "decide" ? "decide" : "execute",
      reason,
      summary: payload.summary,
      observation_ids: payload.observation_ids ?? [],
      fact_ids: payload.fact_ids ?? [],
      finding_ids: payload.finding_ids ?? [],
      blocked_on: payload.blocked_on ?? null,
      reopen_rule: payload.reopen_rule ?? (reason === "incomplete_protocol" ? incompleteReopenRule() : null),
      next_action: payload.next_action ?? null,
      finish_requested: true,
      protocol_error: null,
      verification_result: payload.verification_result ?? null,
      coverage_result: payload.coverage_result ?? null,
    };
  }

  private frameworkRunOutcome(run: Record<string, unknown>, reason: TaskOutcome["reason"], summary: string): TaskOutcome {
    return {
      run_id: String(run.id),
      step_id: run.step_id ? String(run.step_id) : null,
      mode: run.mode === "decide" ? "decide" : "execute",
      reason,
      summary,
      observation_ids: [],
      fact_ids: [],
      finding_ids: [],
      blocked_on: null,
      reopen_rule: reason === "incomplete_protocol" ? incompleteReopenRule() : null,
      finish_requested: Number(run.finish_requested) === 1,
      protocol_error: reason === "protocol_error" || reason === "incomplete_protocol" ? summary : null,
    };
  }

  envAdmissionOpen(runId: string): boolean {
    const row = this.store.db.prepare("SELECT env_admission, finish_requested FROM task_runs WHERE id = ?").get(runId) as
      | { env_admission: number; finish_requested: number }
      | undefined;
    return !!row && row.env_admission === 1 && row.finish_requested === 0;
  }

  getRun(runId: string): Record<string, unknown> {
    const row = this.store.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row) throw invalidInput("run_not_found", "run not found");
    return row;
  }

  saveManifest(runId: string, manifest: unknown): void {
    this.store.db.prepare("UPDATE task_runs SET context_manifest_json = ?, updated_at = ? WHERE id = ?").run(asJson(manifest), nowIso(), runId);
  }

  saveCheckpoint(args: { campaign_id: string; run_id: string; note: string; next?: string; payload?: unknown }): { id: string } {
    const id = newId("ckpt");
    this.store.db
      .prepare(
        "INSERT INTO checkpoints(id, campaign_id, run_id, note, next, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, args.campaign_id, args.run_id, args.note, args.next ?? null, asJson(args.payload ?? {}), nowIso());
    return { id };
  }

  latestCheckpoint(
    campaignId: string,
    filter: { runId?: string | null; stepId?: string | null } = {},
  ): Record<string, unknown> | null {
    if (filter.runId) {
      const row = this.store.db
        .prepare("SELECT * FROM checkpoints WHERE campaign_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(campaignId, filter.runId) as Record<string, unknown> | undefined;
      if (row) return row;
    }
    if (filter.stepId) {
      const row = this.store.db
        .prepare(
          `SELECT c.* FROM checkpoints c
           JOIN task_runs r ON r.id = c.run_id
           WHERE c.campaign_id = ? AND r.step_id = ?
           ORDER BY c.created_at DESC LIMIT 1`,
        )
        .get(campaignId, filter.stepId) as Record<string, unknown> | undefined;
      if (row) return row;
    }
    return null;
  }

  listHints(campaignId: string, limit = 8): { seq: number; text: string }[] {
    const rows = this.store.db
      .prepare("SELECT seq, payload_json FROM events WHERE campaign_id = ? AND type = 'control.changed' ORDER BY seq DESC LIMIT 40")
      .all(campaignId) as { seq: number; payload_json: string }[];
    const hints: { seq: number; text: string }[] = [];
    for (const row of rows) {
      const payload = fromJson<Record<string, unknown>>(row.payload_json, {});
      if (payload.command === "hint" && typeof payload.text === "string") {
        hints.push({ seq: row.seq, text: payload.text });
      }
      if (hints.length >= limit) break;
    }
    return hints.reverse();
  }

  consumeReviewedEvents(campaignId: string): number {
    const camp = this.getCampaign(campaignId);
    const result = this.store.db
      .prepare("UPDATE events SET consumed = 1 WHERE campaign_id = ? AND consumed = 0 AND seq <= ?")
      .run(campaignId, camp.reviewed_seq);
    return Number(result.changes ?? 0);
  }

  recomputeStepReadiness(campaignId: string): void {
    const steps = this.store.db
      .prepare("SELECT id, status, preconditions_json, reopen_rule_json, attempt_count FROM steps WHERE campaign_id = ? AND status IN ('proposed','blocked','deferred','ready')")
      .all(campaignId) as {
      id: string;
      status: StepStatus;
      preconditions_json: string;
      reopen_rule_json: string;
      attempt_count: number;
    }[];
    const now = nowIso();
    for (const s of steps) {
      const pred = fromJson<PredicateExpr>(s.preconditions_json, { op: "all", of: [] });
      const value = this.preconditionValue(campaignId, pred);
      const rule = fromJson<WakeCondition>(s.reopen_rule_json, { kind: "never" });
      if (s.status === "ready" && value !== "true") {
        this.store.db
          .prepare("UPDATE steps SET status = 'blocked', blocked_reason = ?, revision = revision + 1 WHERE id = ?")
          .run(value === "unknown" ? "unknown_precondition" : "precondition_false", s.id);
        this.appendEvent(campaignId, "step.blocked", { step_id: s.id, reason: value }, { kind: "controller", id: "scheduler" }, s.id);
        continue;
      }
      if (value !== "true") continue;
      if (s.status === "proposed") {
        this.store.db
          .prepare("UPDATE steps SET status = 'ready', blocked_reason = NULL, ready_since = ?, revision = revision + 1 WHERE id = ?")
          .run(now, s.id);
        this.appendEvent(campaignId, "step.ready", { step_id: s.id, from: s.status }, { kind: "controller", id: "scheduler" }, s.id);
        continue;
      }
      if (
        (s.status === "blocked" || s.status === "deferred") &&
        this.reopenSatisfied(campaignId, rule, s.attempt_count)
      ) {
        this.store.db
          .prepare("UPDATE steps SET status = 'ready', blocked_reason = NULL, ready_since = ?, revision = revision + 1 WHERE id = ?")
          .run(now, s.id);
        this.appendEvent(campaignId, "step.ready", { step_id: s.id, from: s.status }, { kind: "controller", id: "scheduler" }, s.id);
      }
    }
  }

  /**
   * Re-ready steps that a framework stop parked (provider/network failure or a
   * deadline), so one bad minute at the provider cannot permanently empty the
   * frontier. Complements the park-time rule: this also rescues rows parked
   * before that rule existed. Bounded by MAX_STEP_ATTEMPTS; returns how many
   * steps were requeued.
   */
  requeueTransientSteps(campaignId: string): number {
    const rows = this.store.db
      .prepare(
        `SELECT id, attempt_count FROM steps
         WHERE campaign_id = ? AND status = 'deferred' AND attempt_count < ?
           AND (last_failure LIKE 'primary_stop:model_error%'
             OR last_failure LIKE 'primary_stop:runtime_error%'
             OR last_failure LIKE 'primary_stop:deadline%')`,
      )
      .all(campaignId, MAX_STEP_ATTEMPTS) as { id: string; attempt_count: number }[];
    if (rows.length === 0) return 0;
    const now = nowIso();
    for (const row of rows) {
      this.store.db
        .prepare("UPDATE steps SET status = 'ready', blocked_reason = NULL, ready_since = ?, revision = revision + 1 WHERE id = ?")
        .run(now, row.id);
      this.appendEvent(
        campaignId,
        "step.ready",
        { step_id: row.id, from: "deferred", reason: "transient_requeue" },
        { kind: "controller", id: "scheduler" },
        row.id,
      );
    }
    return rows.length;
  }

  private reopenSatisfied(campaignId: string, rule: WakeCondition, attemptCount: number): boolean {
    if (attemptCount >= MAX_STEP_ATTEMPTS) return false;
    if (rule.kind === "never") return false;
    if (rule.kind === "always") return true;
    if (rule.kind === "env_revision") {
      const camp = this.getCampaign(campaignId);
      const world = this.getWorld<{ env_rev?: string }>(campaignId, { env_rev: camp.spec.environment_revision });
      const latest = this.store.db
        .prepare("SELECT env_rev FROM observations WHERE campaign_id = ? ORDER BY created_seq DESC LIMIT 1")
        .get(campaignId) as { env_rev: string } | undefined;
      const current = String(latest?.env_rev ?? world.env_rev ?? camp.spec.environment_revision);
      return Boolean(rule.env_revision) && current === rule.env_revision;
    }
    if (rule.kind === "fact_key" && rule.key) {
      return this.preconditionValue(campaignId, { op: "atom", key: rule.key }) === "true";
    }
    if (rule.kind === "observation_subject" && rule.subject) {
      const row = this.store.db
        .prepare("SELECT id FROM observations WHERE campaign_id = ? AND subject = ? LIMIT 1")
        .get(campaignId, rule.subject);
      return Boolean(row);
    }
    return false;
  }

  graphQuery(campaignId: string, args: { entity: string; limit?: number; offset?: number; q?: string; depth?: number; order?: "asc" | "desc"; ids?: string[] }): {
    items: unknown[];
    truncated: boolean;
    omitted: number;
    snapshot_seq: number;
  } {
    const limit = Math.min(args.limit ?? 20, 50);
    const offset = args.offset ?? 0;
    const dir = args.order === "desc" ? "DESC" : "ASC";
    const camp = this.getCampaign(campaignId);
    // Detail reads by id, for entities the overview omitted. Always scoped to
    // this campaign; ids from another campaign simply match nothing.
    if (args.ids && args.ids.length > 0) {
      const table = graphEntityTable(args.entity);
      const ids = [...new Set(args.ids)].slice(0, 50);
      const marks = ids.map(() => "?").join(",");
      const rows = this.store.db
        .prepare(`SELECT * FROM ${table} WHERE campaign_id = ? AND id IN (${marks})`)
        .all(campaignId, ...ids);
      return { items: rows, truncated: false, omitted: 0, snapshot_seq: camp.event_head };
    }
    let rows: unknown[] = [];
    switch (args.entity) {
      case "facts":
        rows = this.store.db
          .prepare(
            `SELECT id, revision, proposition, fact_key, epistemic_status, source_grade, validity, support_refs_json, counter_refs_json, conditions_json FROM facts WHERE campaign_id = ? ORDER BY created_seq ${dir} LIMIT ? OFFSET ?`,
          )
          .all(campaignId, limit + 1, offset);
        break;
      case "steps":
        rows = this.store.db
          .prepare(
            `SELECT id, revision, kind, question, status, priority, blocked_reason, last_failure, fingerprint, attempt_count, branch_id, preconditions_json FROM steps WHERE campaign_id = ? ORDER BY created_seq ${dir} LIMIT ? OFFSET ?`,
          )
          .all(campaignId, limit + 1, offset);
        break;
      case "goals":
        rows = this.store.db
          .prepare(`SELECT id, revision, statement, is_root, status, parent_id FROM goals WHERE campaign_id = ? ORDER BY created_seq ${dir} LIMIT ? OFFSET ?`)
          .all(campaignId, limit + 1, offset);
        break;
      case "findings":
        rows = this.store.db
          .prepare(`SELECT id, claim, status, evidence_refs_json, dedup_key FROM findings WHERE campaign_id = ? ORDER BY created_seq ${dir} LIMIT ? OFFSET ?`)
          .all(campaignId, limit + 1, offset);
        break;
      case "coverage":
        rows = this.store.db
          .prepare("SELECT id, obligation, applicability, execution_state, outcome, evidence_state, mandatory FROM coverage_items WHERE campaign_id = ? LIMIT ? OFFSET ?")
          .all(campaignId, limit + 1, offset);
        break;
      case "observations":
        rows = this.store.db
          .prepare(`SELECT id, subject, body_json, env_rev, observed_at FROM observations WHERE campaign_id = ? ORDER BY created_seq ${dir} LIMIT ? OFFSET ?`)
          .all(campaignId, limit + 1, offset);
        break;
      default:
        throw invalidInput("unknown_entity", `graph_query entity ${args.entity} not allowed`);
    }
    const truncated = rows.length > limit;
    const items = truncated ? rows.slice(0, limit) : rows;
    return { items, truncated, omitted: truncated ? 1 : 0, snapshot_seq: camp.event_head };
  }

  recentInvocations(
    campaignId: string,
    limit = 6,
  ): {
    created_at: string;
    updated_at: string;
    kind: string;
    purpose: string | null;
    state: string;
    actual_tokens: number;
    status: string | null;
    error_json: string | null;
  }[] {
    return this.store.db
      .prepare(
        "SELECT created_at, updated_at, kind, purpose, state, actual_tokens, status, error_json FROM invocations WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(campaignId, limit) as {
      created_at: string;
      updated_at: string;
      kind: string;
      purpose: string | null;
      state: string;
      actual_tokens: number;
      status: string | null;
      error_json: string | null;
    }[];
  }

  list(table: string, campaignId: string): Record<string, unknown>[] {
    const allowed = new Set(["steps", "facts", "findings", "events", "observations", "coverage_items", "task_runs", "invocations", "goals", "artifacts"]);
    if (!allowed.has(table)) throw denied("table_not_allowed", table);
    return this.store.db.prepare(`SELECT * FROM ${table} WHERE campaign_id = ? ORDER BY rowid`).all(campaignId) as Record<
      string,
      unknown
    >[];
  }

  consumeEvents(campaignId: string): DomainEvent[] {
    const rows = this.store.db
      .prepare("SELECT * FROM events WHERE campaign_id = ? AND consumed = 0 ORDER BY seq")
      .all(campaignId) as Record<string, unknown>[];
    this.store.db.prepare("UPDATE events SET consumed = 1 WHERE campaign_id = ? AND consumed = 0").run(campaignId);
    return rows.map(rowToEvent);
  }

  unconsumedCount(campaignId: string): number {
    const row = this.store.db
      .prepare(
        `SELECT COUNT(*) AS c FROM events WHERE campaign_id = ? AND consumed = 0
         AND type IN ('observation.recorded','fact.accepted','finding.proposed','control.changed','step.ready','coverage.updated')`,
      )
      .get(campaignId) as {
      c: number;
    };
    return Number(row.c);
  }

  counts(campaignId: string): {
    ready: number;
    blocked: number;
    deferred: number;
    running: number;
    frontier: number;
  } {
    const ready = (this.store.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE campaign_id = ? AND status = 'ready'").get(campaignId) as { c: number }).c;
    const blocked = (this.store.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE campaign_id = ? AND status = 'blocked'").get(campaignId) as { c: number }).c;
    const deferred = (this.store.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE campaign_id = ? AND status = 'deferred'").get(campaignId) as { c: number }).c;
    const running = (this.store.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE campaign_id = ? AND status IN ('leased','running')").get(campaignId) as { c: number }).c;
    return { ready: Number(ready), blocked: Number(blocked), deferred: Number(deferred), running: Number(running), frontier: Number(ready) + Number(blocked) + Number(deferred) + Number(running) };
  }

  /** Same patch semantics as updateCoverage but keyed by coverage item id. */
  updateCoverageById(
    campaignId: string,
    coverageId: string,
    patch: Partial<{
      execution_state: CoverageExecutionState;
      outcome: CoverageOutcome;
      evidence_state: CoverageEvidenceState;
      applicability: CoverageApplicability;
    }>,
  ): void {
    const row = this.store.db
      .prepare("SELECT id, obligation FROM coverage_items WHERE id = ? AND campaign_id = ?")
      .get(coverageId, campaignId) as { id: string; obligation: string } | undefined;
    if (!row) return;
    this.updateCoverage(campaignId, row.obligation, patch);
  }

  updateCoverage(
    campaignId: string,
    obligation: string,
    patch: Partial<{
      execution_state: CoverageExecutionState;
      outcome: CoverageOutcome;
      evidence_state: CoverageEvidenceState;
      applicability: CoverageApplicability;
    }>,
  ): void {
    const row = this.store.db
      .prepare("SELECT id, execution_state FROM coverage_items WHERE campaign_id = ? AND obligation = ?")
      .get(campaignId, obligation) as { id: string; execution_state: string } | undefined;
    if (!row) return;
    this.store.db
      .prepare(
        `UPDATE coverage_items SET
          execution_state = COALESCE(?, execution_state),
          outcome = COALESCE(?, outcome),
          evidence_state = COALESCE(?, evidence_state),
          applicability = COALESCE(?, applicability),
          revision = revision + 1
         WHERE id = ?`,
      )
      .run(patch.execution_state ?? null, patch.outcome ?? null, patch.evidence_state ?? null, patch.applicability ?? null, row.id);
    this.appendEvent(campaignId, "coverage.updated", { obligation, patch }, { kind: "controller", id: "engine" }, row.id);
  }

  saveWorld(campaignId: string, world: unknown): void {
    this.store.db
      .prepare("INSERT INTO world_state(campaign_id, json) VALUES (?, ?) ON CONFLICT(campaign_id) DO UPDATE SET json = excluded.json")
      .run(campaignId, asJson(world));
  }

  getWorld<T>(campaignId: string, fallback: T): T {
    const row = this.store.db.prepare("SELECT json FROM world_state WHERE campaign_id = ?").get(campaignId) as { json: string } | undefined;
    return row ? fromJson<T>(row.json, fallback) : fallback;
  }

  saveReport(campaignId: string, report: unknown): string {
    const id = newId("snap");
    const seq = this.getCampaign(campaignId).event_head;
    this.store.db
      .prepare("INSERT INTO report_snapshots(id, campaign_id, seq, json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, campaignId, seq, asJson(report), nowIso());
    return id;
  }

  latestReport(campaignId: string): unknown | null {
    const row = this.store.db
      .prepare("SELECT json FROM report_snapshots WHERE campaign_id = ? ORDER BY seq DESC LIMIT 1")
      .get(campaignId) as { json: string } | undefined;
    return row ? fromJson(row.json, null) : null;
  }

  incrementEmptyReviews(campaignId: string): number {
    this.store.db.prepare("UPDATE campaigns SET empty_reviews = empty_reviews + 1, updated_at = ? WHERE id = ?").run(nowIso(), campaignId);
    return this.getCampaign(campaignId).empty_reviews;
  }

  resetEmptyReviews(campaignId: string): void {
    this.store.db.prepare("UPDATE campaigns SET empty_reviews = 0, updated_at = ? WHERE id = ?").run(nowIso(), campaignId);
  }

  bumpProgress(campaignId: string): void {
    this.store.db
      .prepare("UPDATE campaigns SET progress_epoch = progress_epoch + 1, empty_reviews = 0, updated_at = ? WHERE id = ?")
      .run(nowIso(), campaignId);
  }

  markRequested(campaignId: string, seq: number): void {
    this.store.db.prepare("UPDATE campaigns SET requested_seq = MAX(requested_seq, ?), updated_at = ? WHERE id = ?").run(seq, nowIso(), campaignId);
  }

  appendEvent(campaignId: string, type: string, payload: unknown, actor: Actor, entityId?: string, submissionId?: string): number {
    const camp = this.store.db.prepare("SELECT event_head FROM campaigns WHERE id = ?").get(campaignId) as { event_head: number };
    const seq = camp.event_head + 1;
    const eventId = newId("evt");
    const now = nowIso();
    this.store.db.prepare("UPDATE campaigns SET event_head = ?, updated_at = ? WHERE id = ?").run(seq, now, campaignId);
    this.store.db
      .prepare(
        `INSERT INTO events(event_id, campaign_id, seq, schema_version, type, actor_json, entity_id, correlation_id, submission_id, recorded_at, payload_json, consumed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        eventId,
        campaignId,
        seq,
        SCHEMA_VERSION,
        type,
        asJson(actor),
        entityId ?? null,
        newCorrelationId(),
        submissionId ?? null,
        now,
        asJson(payload),
      );
    this.store.db.prepare("INSERT INTO outbox(campaign_id, event_seq, created_at, processed) VALUES (?, ?, ?, 0)").run(campaignId, seq, now);
    return seq;
  }

  private applyOneOp(campaignId: string, runId: string, submissionId: string, op: ProposalOp, ids: Record<string, string>): number {
    const camp = this.getCampaign(campaignId);
    const root = this.store.db.prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1").get(campaignId) as { id: string };
    switch (op.op) {
      case "propose_step": {
        const step = op.step;
        if (!step.question || !step.kind || !step.methodFamily) {
          throw invalidInput("step_incomplete", "propose_step missing fields");
        }
        const already = Number(
          (this.store.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE campaign_id = ? AND source_run_id = ?").get(campaignId, runId) as { c: number }).c,
        );
        if (already >= 8) return camp.event_head;
        const fp = this.stepFingerprintResolve(campaignId, {
          kind: step.kind,
          methodFamily: step.methodFamily,
          question: step.question,
          goalRefs: step.goalRefs,
          inputRefs: step.inputRefs,
          preconditions: step.preconditions,
          explicit: step.fingerprint,
        });
        const result = this.proposeStepDirect({
          campaign_id: campaignId,
          producer_id: `inner-${runId}`,
          submission_id: `${submissionId}:${fp}`,
          run_id: runId,
          question: step.question,
          kind: step.kind,
          goal_refs: step.goalRefs?.length ? step.goalRefs : [root.id],
          preconditions: step.preconditions ?? { op: "all", of: [] },
          method_family: step.methodFamily,
          expected_observations: step.expectedObservations ?? [],
          completion_criteria: step.completionCriteria ?? "observe",
          fingerprint: fp,
          reopen_rule: step.reopenRule ?? { kind: "never" },
          branch_id: step.branchId,
          input_refs: step.inputRefs,
        });
        Object.assign(ids, result.canonical_ids);
        return result.seq;
      }
      case "revise_step_priority": {
        if (typeof op.expected_revision !== "number") {
          throw invalidInput("revision_required", "revise_step_priority requires expected_revision (read the step first)");
        }
        const row = this.store.db.prepare("SELECT revision FROM steps WHERE id = ? AND campaign_id = ?").get(op.step_id, campaignId) as
          | { revision: number }
          | undefined;
        if (!row) throw invalidInput("step_not_found", "step not found");
        if (row.revision !== op.expected_revision) throw conflict("revision_conflict", "step revision mismatch");
        this.store.db.prepare("UPDATE steps SET priority = ?, revision = revision + 1 WHERE id = ?").run(op.priority, op.step_id);
        return camp.event_head;
      }
      case "retire_step": {
        if (typeof op.expected_revision !== "number") {
          throw invalidInput("revision_required", "retire_step requires expected_revision (read the step first)");
        }
        const row = this.store.db.prepare("SELECT revision, status FROM steps WHERE id = ? AND campaign_id = ?").get(op.step_id, campaignId) as
          | { revision: number; status: StepStatus }
          | undefined;
        if (!row) throw invalidInput("step_not_found", "step not found");
        if (row.revision !== op.expected_revision) throw conflict("revision_conflict", "step revision mismatch");
        this.store.db.prepare("UPDATE steps SET status = 'retired', revision = revision + 1, blocked_reason = ? WHERE id = ?").run(op.reason, op.step_id);
        return this.appendEvent(campaignId, "step.retired", { step_id: op.step_id, reason: op.reason }, { kind: "worker", id: runId }, op.step_id);
      }
      case "propose_subgoal": {
        this.assertEntityCampaign(campaignId, op.parent_id);
        const parent = this.store.db.prepare("SELECT is_root, id FROM goals WHERE id = ? AND campaign_id = ?").get(op.parent_id, campaignId) as
          | { is_root: number; id: string }
          | undefined;
        if (!parent) throw invalidInput("parent_missing", "parent goal not in campaign");
        const id = newId("goal");
        const seq = this.appendEvent(campaignId, "goal.created", { goal_id: id, parent: op.parent_id }, { kind: "worker", id: runId }, id);
        this.store.db
          .prepare(
            `INSERT INTO goals(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, statement, parent_id, is_root, success_predicate_ref, mandatory, status, evidence_refs_json)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, 0, 'active', '[]')`,
          )
          .run(id, campaignId, SCHEMA_VERSION, nowIso(), seq, seq, op.statement, op.parent_id, op.success_predicate_ref ?? "none");
        ids[id] = id;
        return seq;
      }
      case "retire_subgoal": {
        const g = this.store.db.prepare("SELECT is_root, revision FROM goals WHERE id = ? AND campaign_id = ?").get(op.goal_id, campaignId) as
          | { is_root: number; revision: number }
          | undefined;
        if (!g) throw invalidInput("goal_not_found", "goal not found");
        if (g.is_root) throw denied("root_goal_protected", "root goal cannot be retired by worker");
        this.store.db
          .prepare("UPDATE goals SET status = 'retired', retired_reason = ?, revision = revision + 1 WHERE id = ?")
          .run(op.reason, op.goal_id);
        return this.appendEvent(campaignId, "goal.retired", { goal_id: op.goal_id, reason: op.reason }, { kind: "worker", id: runId }, op.goal_id);
      }
      case "propose_hypothesis": {
        return this.submitFact({
          campaign_id: campaignId,
          producer_id: `hyp-${runId}`,
          submission_id: `${submissionId}:hyp:${hashJson(op.proposition)}`,
          run_id: runId,
          proposition: op.proposition,
          support_refs: op.support_refs,
          conditions: op.conditions,
          source_grade: "derived",
        }).seq;
      }
      case "request_verification": {
        // The verify step names its target up front: a verdict later applies to
        // that target only, never to every pending finding at once.
        const target = this.store.db
          .prepare("SELECT revision FROM findings WHERE id = ? AND campaign_id = ?")
          .get(op.finding_or_fact_id, campaignId) as { revision: number } | undefined;
        const targetFact = target
          ? undefined
          : (this.store.db.prepare("SELECT revision FROM facts WHERE id = ? AND campaign_id = ?").get(op.finding_or_fact_id, campaignId) as
              | { revision: number }
              | undefined);
        const revision = (target ?? targetFact)?.revision;
        if (revision === undefined) {
          throw invalidInput("verification_target_missing", `verification target ${op.finding_or_fact_id} not in campaign`);
        }
        const result = this.proposeStepDirect({
          campaign_id: campaignId,
          producer_id: `ver-${runId}`,
          submission_id: `${submissionId}:ver:${op.finding_or_fact_id}`,
          run_id: runId,
          question: `verify ${op.finding_or_fact_id} via ${op.method}`,
          kind: "verify",
          goal_refs: [root.id],
          preconditions: { op: "all", of: [] },
          method_family: op.method,
          expected_observations: ["verification"],
          completion_criteria: "verdict",
          fingerprint: createHash("sha256").update(`verify|${op.finding_or_fact_id}|${op.method}`).digest("hex").slice(0, 32),
          reopen_rule: { kind: "never" },
          priority: 10,
          input_refs: [{ id: op.finding_or_fact_id, revision }],
        });
        Object.assign(ids, result.canonical_ids);
        return result.seq;
      }
      case "propose_coverage_item": {
        const id = newId("cov");
        const seq = this.appendEvent(campaignId, "coverage.updated", { obligation: op.obligation }, { kind: "worker", id: runId }, id);
        this.store.db
          .prepare(
            `INSERT INTO coverage_items(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, obligation, dimensions_json, applicability, execution_state, outcome, evidence_state, mandatory)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'applicable', 'untested', 'none', 'missing', ?)`,
          )
          .run(id, campaignId, SCHEMA_VERSION, nowIso(), seq, seq, op.obligation, asJson(op.dimensions), op.mandatory ? 1 : 0);
        ids[id] = id;
        return seq;
      }
      case "recommend_state":
        this.appendEvent(campaignId, "control.changed", { recommend_state: op.state, reason: op.reason }, { kind: "worker", id: runId });
        return this.getCampaign(campaignId).event_head;
    }
  }

  private preconditionValue(campaignId: string, expr: PredicateExpr): ReturnType<FactLookup> {
    const lookup: FactLookup = ({ fact_id, key }) => {
      if (fact_id) {
        const row = this.store.db
          .prepare("SELECT epistemic_status, validity, campaign_id FROM facts WHERE id = ?")
          .get(fact_id) as { epistemic_status: string; validity: string; campaign_id: string } | undefined;
        if (!row) return "unknown";
        if (row.campaign_id !== campaignId) throw denied("cross_campaign_ref", "fact belongs to another campaign");
        if (row.validity !== "current") return "unknown";
        if (row.epistemic_status === "accepted") return "true";
        if (row.epistemic_status === "disputed" || row.epistemic_status === "retracted" || row.epistemic_status === "stale") {
          return "unknown";
        }
        return "unknown";
      }
      if (key) {
        const row = this.store.db
          .prepare(
            "SELECT epistemic_status, validity FROM facts WHERE campaign_id = ? AND fact_key = ? AND epistemic_status IN ('accepted','disputed') ORDER BY created_seq DESC LIMIT 1",
          )
          .get(campaignId, key) as { epistemic_status: string; validity: string } | undefined;
        if (!row) return "unknown";
        if (row.validity !== "current") return "unknown";
        if (row.epistemic_status === "accepted") return "true";
        return "unknown";
      }
      return "true";
    };
    return evalPredicate(expr, lookup);
  }

  private assertRun(campaignId: string, runId: string): void {
    const run = this.store.db.prepare("SELECT campaign_id FROM task_runs WHERE id = ?").get(runId) as { campaign_id: string } | undefined;
    if (!run) throw invalidInput("unknown_run", "execution id does not exist");
    if (run.campaign_id !== campaignId) throw denied("cross_campaign_ref", "run belongs to another campaign");
  }

  private refsExist(campaignId: string, ids: string[]): boolean {
    for (const id of ids) {
      const obs = this.store.db.prepare("SELECT campaign_id FROM observations WHERE id = ?").get(id) as { campaign_id: string } | undefined;
      const art = this.store.db
        .prepare("SELECT campaign_id, path, hash, integrity_state, truncated FROM artifacts WHERE id = ?")
        .get(id) as
        | { campaign_id: string; path: string; hash: string; integrity_state: string; truncated: number }
        | undefined;
      const fact = this.store.db.prepare("SELECT campaign_id FROM facts WHERE id = ?").get(id) as { campaign_id: string } | undefined;
      if (art) {
        if (art.campaign_id !== campaignId) throw denied("cross_campaign_ref", "reference belongs to another campaign");
        if (art.integrity_state !== "complete" || art.truncated) return false;
        if (!this.artifacts.verify(art.path, art.hash)) return false;
        continue;
      }
      const hit = obs ?? fact;
      if (!hit) return false;
      if (hit.campaign_id !== campaignId) throw denied("cross_campaign_ref", "reference belongs to another campaign");
    }
    return true;
  }

  private assertRefsSameCampaign(campaignId: string, ids: string[]): void {
    for (const id of ids) this.assertEntityCampaign(campaignId, id);
  }

  private assertEntityCampaign(campaignId: string, id: string): void {
    const tables = ["facts", "goals", "steps", "observations", "findings", "coverage_items", "artifacts"];
    for (const t of tables) {
      const row = this.store.db.prepare(`SELECT campaign_id FROM ${t} WHERE id = ?`).get(id) as { campaign_id: string } | undefined;
      if (row) {
        if (row.campaign_id !== campaignId) throw denied("cross_campaign_ref", `${t} ${id} belongs to another campaign`);
        return;
      }
    }
    throw invalidInput("unknown_ref", `unknown reference ${id}`);
  }

  private findOpposite(campaignId: string, proposition: string, factKey?: string): string | undefined {
    if (factKey) {
      const row = this.store.db
        .prepare("SELECT id, proposition FROM facts WHERE campaign_id = ? AND fact_key = ? AND epistemic_status = 'accepted'")
        .get(campaignId, factKey) as { id: string; proposition: string } | undefined;
      if (row && normalizeProp(row.proposition) !== normalizeProp(proposition)) return row.id;
    }
    const notForm = proposition.startsWith("NOT ") ? proposition.slice(4) : `NOT ${proposition}`;
    const row = this.store.db
      .prepare("SELECT id FROM facts WHERE campaign_id = ? AND proposition = ?")
      .get(campaignId, notForm) as { id: string } | undefined;
    return row?.id;
  }
}

function normalizeProp(s: string): string {
  return s.trim().toLowerCase();
}

function outcomeToStepStatus(reason: TaskOutcome["reason"]): StepStatus {
  switch (reason) {
    case "resolved":
      return "resolved";
    case "deferred":
    case "budget":
    case "context_limit":
    case "protocol_error":
    case "incomplete_protocol":
      return "deferred";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "retired";
    default:
      return "deferred";
  }
}

function rowToEvent(row: Record<string, unknown>): DomainEvent {
  return {
    eventId: String(row.event_id),
    campaignId: String(row.campaign_id),
    seq: Number(row.seq),
    schemaVersion: Number(row.schema_version),
    type: String(row.type),
    actor: fromJson(String(row.actor_json), { kind: "controller", id: "?" }),
    entityId: row.entity_id ? String(row.entity_id) : undefined,
    correlationId: String(row.correlation_id),
    submissionId: row.submission_id ? String(row.submission_id) : undefined,
    recordedAt: String(row.recorded_at),
    payload: fromJson(String(row.payload_json), {}),
  };
}
