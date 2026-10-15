import { DomainError } from "../domain/errors.ts";
import { newId } from "../domain/ids.ts";
import type { EffectClass, InvocationState, RunLease } from "../domain/types.ts";
import { defaultDescriptor, type EffectAdapter, type ExecutionEvidence } from "../tools/effect-adapter.ts";
import { isKaliPayload } from "../tools/kali-adapter.ts";
import { isLoopbackHost, parseDestination } from "../tools/egress.ts";
import type { BudgetLedger } from "./budget-ledger.ts";
import type { InvocationBook } from "./invocation.ts";
import type { StorageService } from "../storage/service.ts";

export function envLockKeys(campaignId: string, payload: unknown, runId?: string): string[] {
  const keys = new Set<string>();
  if (isKaliPayload(payload)) {
    // Run-private workspace: no campaign-wide serialization (C4). The shared
    // input/ tree is read-only; results hand off through artifacts.
    keys.add(`workspace:${campaignId}:${runId ?? "legacy"}`);
    const url = (payload as { url?: string }).url;
    if (typeof url === "string" && url) {
      try {
        const dest = parseDestination(url);
        if (!isLoopbackHost(dest.host)) keys.add(`target:${dest.host}`);
      } catch {
        // malformed dest is denied later at egress
      }
    }
  } else {
    keys.add(`world:${campaignId}`);
  }
  return [...keys];
}

export interface DispatchRequest {
  lease: RunLease;
  purpose: string;
  payload: unknown;
  effect: EffectClass;
  envTool: boolean;
  /** Worker cancellation: killing this signal kills only this invocation's process. */
  signal?: AbortSignal;
}

export interface DispatchResult {
  status: "sent" | "rejected" | "in_flight";
  reason?: string;
  invocation_id: string;
  execution_id?: string;
  pending?: boolean;
}

export class DispatchGate {
  constructor(
    private readonly storage: StorageService,
    private readonly budget: BudgetLedger,
    private readonly invocations: InvocationBook,
    private readonly adapter: EffectAdapter,
  ) {}

  dispatch(req: DispatchRequest): DispatchResult {
    const permit = this.permit(req);
    if (!permit.ok) {
      return { status: "rejected", reason: permit.reason, invocation_id: permit.invocation_id };
    }
    try {
      return this.afterSend(req, permit.invocation_id, this.adapter.send(permit.invocation_id, req.payload));
    } catch (err) {
      return this.sendFailed(req, permit.invocation_id, err);
    }
  }

  /**
   * Async dispatch for worker paths. The permit (budget, locks, invocation) is
   * still written in one short transaction; the actual send awaits outside it,
   * and the settle writes afterwards. The event loop stays free during sends.
   */
  async dispatchAsync(req: DispatchRequest): Promise<DispatchResult> {
    const permit = this.permit(req);
    if (!permit.ok) {
      return { status: "rejected", reason: permit.reason, invocation_id: permit.invocation_id };
    }
    try {
      const sent = await this.adapter.sendAsync(permit.invocation_id, req.payload, req.signal);
      return this.afterSend(req, permit.invocation_id, sent);
    } catch (err) {
      return this.sendFailed(req, permit.invocation_id, err);
    }
  }

  /** Linearization point: dispatching is written in the same transaction that
   *  grants the send permit. Adapter send happens after that commit. */
  private permit(req: DispatchRequest): { ok: true; invocation_id: string } | { ok: false; reason: string; invocation_id: string } {
    return this.storage.store.transaction(() => {
      const camp = this.storage.getCampaign(req.lease.campaign_id);
      if (camp.cancel_epoch > req.lease.cancel_epoch || camp.state === "cancelled") {
        return { ok: false as const, reason: "cancel_epoch", invocation_id: "none" };
      }
      if (!this.storage.admissionOpen(req.lease.campaign_id) && req.envTool) {
        return { ok: false as const, reason: "admission_closed", invocation_id: "none" };
      }
      const run = this.storage.getRun(req.lease.run_id);
      if (String(run.state) !== "claimed" && String(run.state) !== "running") {
        // A run reclaimed or settled elsewhere must not emit more side effects.
        return { ok: false as const, reason: "run_not_live", invocation_id: "none" };
      }
      if (Number(run.fence) !== req.lease.fence) {
        return { ok: false as const, reason: "stale_fence", invocation_id: "none" };
      }
      // A run whose real lease lapsed cannot send, even before recovery marks it.
      if (Date.now() >= Number(run.deadline_ms)) {
        return { ok: false as const, reason: "lease_expired", invocation_id: "none" };
      }
      if (run.controller_generation != null) {
        // L09: the controller generation that claimed this run must still hold
        // the lock; a taken-over or lapsed controller fences off its runs.
        const lock = this.storage.store.db
          .prepare("SELECT 1 FROM controller_locks WHERE campaign_id = ? AND generation = ? AND lease_until > ?")
          .get(req.lease.campaign_id, Number(run.controller_generation), Date.now());
        if (!lock) return { ok: false as const, reason: "controller_lost", invocation_id: "none" };
      }
      if (req.envTool && !this.storage.envAdmissionOpen(req.lease.run_id)) {
        return { ok: false as const, reason: "finish_closed_env", invocation_id: "none" };
      }
      if (!this.budget.canAdmit(req.lease.campaign_id, 1, 0, 0)) {
        throw new DomainError("budget_exhausted", "dispatch blocked", "budget");
      }
      // The execution handle is computed and persisted BEFORE the send — after
      // a crash the recovery path can query by handle even without a receipt.
      const invId = newId("inv");
      const desc = this.adapter.describe?.(invId, req.payload) ?? defaultDescriptor(invId);
      const inv = this.invocations.prepare({
        id: invId,
        campaign_id: req.lease.campaign_id,
        run_id: req.lease.run_id,
        kind: "tool",
        purpose: req.purpose,
        fence: req.lease.fence,
        cancel_epoch: req.lease.cancel_epoch,
        effect_class: req.effect,
        reserved_calls: 1,
        execution_handle: desc.handle,
      });
      if (req.envTool) {
        for (const key of envLockKeys(req.lease.campaign_id, req.payload, req.lease.run_id)) {
          if (!this.storage.acquireResourceLock(req.lease.campaign_id, key, inv.id, false)) {
            throw new DomainError("resource_locked", `resource lock held: ${key}`, "denied");
          }
        }
      }
      this.budget.reserve(req.lease.campaign_id, inv.id, 1, 0, 0);
      this.invocations.mark(inv.id, "dispatching");
      return { ok: true as const, invocation_id: inv.id };
    });
  }

  private afterSend(req: DispatchRequest, invocationId: string, sent: { execution_id: string; pending?: boolean }): DispatchResult {
    this.invocations.mark(invocationId, "running", { status: sent.execution_id });
    this.storage.store.db
      .prepare("UPDATE invocations SET external_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sent.execution_id, invocationId);
    if (sent.pending) {
      const next = new Date(Date.now() + 2_000).toISOString();
      this.storage.registerOperation(req.lease.campaign_id, invocationId, sent.execution_id, "running");
      this.storage.updateOperationState(sent.execution_id, "running", next);
      return {
        status: "sent",
        invocation_id: invocationId,
        execution_id: sent.execution_id,
        pending: true,
      };
    }
    this.storage.registerOperation(req.lease.campaign_id, invocationId, sent.execution_id, "completed");
    this.invocations.mark(invocationId, "completed");
    this.budget.settle(req.lease.campaign_id, invocationId, 1, 0, 0, 1, 0, 0);
    this.storage.releaseResourceLocksForInvocation(req.lease.campaign_id, invocationId);
    return { status: "sent", invocation_id: invocationId, execution_id: sent.execution_id };
  }

  private sendFailed(req: DispatchRequest, invocationId: string, err: unknown): DispatchResult {
    if (
      err instanceof DomainError &&
      (err.category === "denied" || err.category === "invalid_input" || err.category === "protocol_error")
    ) {
      this.invocations.mark(invocationId, "failed_known", { error: String(err) });
      this.budget.settle(req.lease.campaign_id, invocationId, 1, 0, 0, 1, 0, 0);
      this.storage.releaseResourceLocksForInvocation(req.lease.campaign_id, invocationId);
      return { status: "rejected", reason: `${err.code}:${err.message}`, invocation_id: invocationId };
    }
    this.invocations.mark(invocationId, "uncertain", { error: String(err) });
    this.budget.markLiability(req.lease.campaign_id, invocationId, 1, 0, 0);
    return { status: "in_flight", reason: String(err), invocation_id: invocationId };
  }

  /** Record dispatching without sending. Used to simulate crash after permit, before adapter. */
  markDispatchingOnly(req: DispatchRequest): string {
    const r = this.storage.store.transaction(() => {
      const invId = newId("inv");
      const desc = this.adapter.describe?.(invId, req.payload) ?? defaultDescriptor(invId);
      const inv = this.invocations.prepare({
        id: invId,
        campaign_id: req.lease.campaign_id,
        run_id: req.lease.run_id,
        kind: "tool",
        purpose: req.purpose,
        fence: req.lease.fence,
        cancel_epoch: req.lease.cancel_epoch,
        effect_class: req.effect,
        reserved_calls: 1,
        execution_handle: desc.handle,
      });
      this.budget.reserve(req.lease.campaign_id, inv.id, 1, 0, 0);
      this.invocations.mark(inv.id, "dispatching");
      return inv.id;
    });
    return r;
  }

  /**
   * Recovery decision table (H04 §6.7). The load-bearing rules:
   *  - prepared releases its reservation only when the owning run's send right
   *    is provably revoked (the run is no longer live); a live run keeps it.
   *  - dispatching/running/uncertain without a usable handle stays uncertain —
   *    "no receipt" is not proof of "never sent". Ever.
   *  - completed/failed/not_started reconcile exactly once per invocation key.
   *  - Nothing here re-sends; replay decisions belong to a new decide cycle.
   */
  async recover(
    campaignId: string,
    invocationId?: string,
    activeRunIds?: ReadonlySet<string>,
  ): Promise<{ prepared_released: number; marked_uncertain: number; reconciled: number; still_running: number }> {
    const rows = this.invocations
      .nonTerminal(campaignId)
      .filter((row) => !invocationId || String(row.id) === invocationId);
    let prepared_released = 0;
    let marked_uncertain = 0;
    let reconciled = 0;
    let still_running = 0;
    for (const row of rows) {
      const id = String(row.id);
      const state = String(row.state) as InvocationState;
      const reserved = Number(row.reserved_calls ?? 0);
      const runId = row.run_id ? String(row.run_id) : "";
      if (String(row.kind) === "model") {
        // Model invocations belong to the worker's stream lifecycle, not the
        // adapter. Only reconcile orphans whose run already settled; a live
        // run's in-flight stream is none of recover's business.
        const run = runId
          ? (this.storage.store.db.prepare("SELECT state FROM task_runs WHERE id = ?").get(runId) as
              | { state: string }
              | undefined)
          : undefined;
        if (!run || (String(run.state) !== "claimed" && String(run.state) !== "running")) {
          this.invocations.mark(id, "failed_known", { error: "run_settled" });
          // An orphaned model call whose run settled without settling the
          // stream: assume it was charged, reconcile the reserve honestly.
          const tokens = Number(row.reserved_tokens ?? 0);
          const cost = Number(row.reserved_cost ?? 0);
          this.budget.markLiability(campaignId, id, reserved, tokens, cost);
          this.budget.reconcileLiability(campaignId, `rec:${id}`, reserved, reserved, tokens, tokens, cost, cost);
        }
        continue;
      }
      // A dispatch still in flight on a run THIS process is driving is not
      // recover's business: its owner will settle it. Crashed runs (not driven
      // here) fall through to the normal liability/uncertain reconciliation.
      if (runId && activeRunIds?.has(runId)) {
        continue;
      }
      const runLive = this.runCurrentlyLive(runId);
      if (state === "prepared") {
        if (runLive) continue; // the owner may still send; never race it
        // The send right is revoked with the run: provably never sent.
        this.invocations.mark(id, "failed_known", { error: "not_dispatched" });
        this.budget.releasePrepared(campaignId, id, reserved, Number(row.reserved_tokens ?? 0), Number(row.reserved_cost ?? 0));
        prepared_released += 1;
        continue;
      }
      if (state !== "dispatching" && state !== "running" && state !== "uncertain") continue;
      const tokens = Number(row.reserved_tokens ?? 0);
      const cost = Number(row.reserved_cost ?? 0);
      this.budget.markLiability(campaignId, id, reserved, tokens, cost);
      const handle = row.execution_handle
        ? String(row.execution_handle)
        : row.external_id
          ? String(row.external_id)
          : null;
      if (!handle) {
        // No handle and no receipt: unknowable. Keep the locks and the slot.
        this.invocations.mark(id, "uncertain", { error: "unqueryable" });
        this.appendRecoveryEvent(campaignId, id, runId, null, "unqueryable");
        marked_uncertain += 1;
        continue;
      }
      const ev = await this.queryEvidence(handle);
      if (ev.status === "running") {
        this.storage.updateOperationState(handle, "running", new Date(Date.now() + 2_000).toISOString());
        still_running += 1;
      } else if (ev.status === "completed") {
        this.invocations.mark(id, "reconciled");
        this.budget.reconcileLiability(campaignId, `rec:${id}`, reserved, reserved, tokens, tokens, cost, cost);
        this.storage.releaseResourceLocksForInvocation(campaignId, id);
        this.storage.updateOperationState(handle, "completed");
        this.appendRecoveryEvent(campaignId, id, runId, ev.evidenceRef, "completed");
        reconciled += 1;
      } else if (ev.status === "failed") {
        // Execution failed; its earlier effects may exist (ev.effect). The
        // reserved budget converts to liability reconciled at zero proven
        // spend — never silently zero-cost.
        this.invocations.mark(id, "failed_known", { error: `evidence:${ev.evidenceRef} effect:${ev.effect}` });
        this.budget.reconcileLiability(campaignId, `rec:${id}`, 0, reserved, 0, tokens, 0, cost);
        this.storage.releaseResourceLocksForInvocation(campaignId, id);
        this.storage.updateOperationState(handle, "failed");
        this.appendRecoveryEvent(campaignId, id, runId, ev.evidenceRef, `failed:${ev.effect}`);
        reconciled += 1;
      } else if (ev.status === "not_started" && !runLive) {
        // Positive not-started proof AND the send right revoked with the run.
        this.invocations.mark(id, "failed_known", { error: "not_dispatched" });
        this.budget.reconcileLiability(campaignId, `rec:${id}`, 0, reserved, 0, tokens, 0, cost);
        this.storage.releaseResourceLocksForInvocation(campaignId, id);
        this.storage.updateOperationState(handle, "failed");
        this.appendRecoveryEvent(campaignId, id, runId, ev.evidenceRef, "not_started");
        reconciled += 1;
      } else {
        // unknown (or a not_started we cannot act on): keep everything.
        this.invocations.mark(id, "uncertain", { error: ev.status === "unknown" ? ev.reason : "not_started_unrevoked" });
        this.storage.updateOperationState(handle, "unknown");
        this.appendRecoveryEvent(campaignId, id, runId, null, ev.status === "unknown" ? ev.reason : "not_started_unrevoked");
        marked_uncertain += 1;
      }
    }
    return { prepared_released, marked_uncertain, reconciled, still_running };
  }

  private runCurrentlyLive(runId: string): boolean {
    if (!runId) return false;
    const run = this.storage.store.db
      .prepare("SELECT state, deadline_ms FROM task_runs WHERE id = ?")
      .get(runId) as { state: string; deadline_ms: number } | undefined;
    if (!run) return false;
    return (run.state === "claimed" || run.state === "running") && Number(run.deadline_ms) > Date.now();
  }

  private async queryEvidence(handle: string): Promise<ExecutionEvidence> {
    if (this.adapter.queryEvidence) {
      try {
        return await this.adapter.queryEvidence(handle);
      } catch (err) {
        return { status: "unknown", reason: `query_error:${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const q = this.adapter.queryAsync ? await this.adapter.queryAsync(handle) : this.adapter.query(handle);
    if (q === "completed") return { status: "completed", evidenceRef: "legacy_query" };
    if (q === "failed") return { status: "failed", evidenceRef: "legacy_query", effect: "possible" };
    return { status: "unknown", reason: "legacy_query_unknown" };
  }

  private appendRecoveryEvent(campaignId: string, invocationId: string, runId: string, evidenceRef: string | null, outcome: string): void {
    // Dedup: the same uncertainty outcome is recorded once per invocation.
    const last = this.storage.store.db
      .prepare(
        "SELECT payload_json FROM events WHERE campaign_id = ? AND entity_id = ? AND type = 'invocation.uncertain' ORDER BY seq DESC LIMIT 1",
      )
      .get(campaignId, invocationId) as { payload_json: string } | undefined;
    if (last) {
      try {
        const prev = JSON.parse(last.payload_json) as { outcome?: string };
        if (prev.outcome === outcome && (outcome === "unqueryable" || evidenceRef === null)) return;
      } catch {
        // fall through and record
      }
    }
    this.storage.appendEvent(
      campaignId,
      "invocation.uncertain",
      { invocation_id: invocationId, run_id: runId, handle: evidenceRef, outcome },
      { kind: "controller", id: "recover" },
      invocationId,
    );
  }

  /**
   * Trusted manual adjudication for an unresolvable unknown (H04 §6.8).
   * Records the actor, basis and original state; only "acknowledged_unknown"
   * keeps the invocation uncertain (it still blocks an ordinary close).
   * Idempotent per invocation: terminal states are returned unchanged.
   */
  adjudicate(
    campaignId: string,
    invocationId: string,
    verdict: "confirmed_not_sent" | "confirmed_completed" | "acknowledged_unknown",
    note: string,
    actor: { kind: "user" | "controller"; id: string } = { kind: "user", id: "manual" },
  ): { state: string } {
    return this.storage.store.transaction(() => {
      const inv = this.invocations.get(invocationId);
      if (String(inv.campaign_id) !== campaignId) {
        throw new DomainError("cross_campaign_ref", "invocation belongs to another campaign", "denied");
      }
      const state = String(inv.state);
      if (state !== "uncertain" && state !== "dispatching" && state !== "running" && state !== "prepared") {
        return { state }; // already terminal; adjudication is a no-op
      }
      const reservedCalls = Number(inv.reserved_calls ?? 0);
      const tokens = Number(inv.reserved_tokens ?? 0);
      const cost = Number(inv.reserved_cost ?? 0);
      if (verdict === "confirmed_not_sent") {
        this.invocations.mark(invocationId, "failed_known", { error: `adjudicated:not_sent ${note}`.slice(0, 400) });
        this.budget.markLiability(campaignId, invocationId, reservedCalls, tokens, cost);
        this.budget.reconcileLiability(campaignId, `rec:${invocationId}`, 0, reservedCalls, 0, tokens, 0, cost);
        this.storage.releaseResourceLocksForInvocation(campaignId, invocationId);
      } else if (verdict === "confirmed_completed") {
        this.invocations.mark(invocationId, "reconciled", { error: `adjudicated:completed ${note}`.slice(0, 400) });
        this.budget.markLiability(campaignId, invocationId, reservedCalls, tokens, cost);
        this.budget.reconcileLiability(campaignId, `rec:${invocationId}`, reservedCalls, reservedCalls, tokens, tokens, cost, cost);
        this.storage.releaseResourceLocksForInvocation(campaignId, invocationId);
      } else {
        // acknowledged_unknown stays uncertain: never rewritten as not-sent,
        // never evidence of success; the note is the audit trail.
        this.invocations.mark(invocationId, "uncertain", { error: `acknowledged_unknown ${note}`.slice(0, 400) });
      }
      this.storage.appendEvent(
        campaignId,
        "invocation.reconciled",
        { invocation_id: invocationId, verdict, note: note.slice(0, 400), previous_state: state },
        actor,
        invocationId,
      );
      return { state: String(this.invocations.get(invocationId).state) };
    });
  }

  archiveLateResult(campaignId: string, invocationId: string, body: unknown): void {
    const inv = this.invocations.get(invocationId);
    if (String(inv.campaign_id) !== campaignId) throw new DomainError("cross_campaign_ref", "late result campaign mismatch", "denied");
    this.storage.store.db
      .prepare("UPDATE invocations SET error_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify({ late_archive: body, observed_at: new Date().toISOString() }), invocationId);
  }
}
