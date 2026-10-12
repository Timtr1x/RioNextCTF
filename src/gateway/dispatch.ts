import { DomainError } from "../domain/errors.ts";
import type { EffectClass, InvocationState, RunLease } from "../domain/types.ts";
import type { EffectAdapter } from "../tools/effect-adapter.ts";
import { isKaliPayload } from "../tools/kali-adapter.ts";
import { isLoopbackHost, parseDestination } from "../tools/egress.ts";
import type { BudgetLedger } from "./budget-ledger.ts";
import type { InvocationBook } from "./invocation.ts";
import type { StorageService } from "../storage/service.ts";

export function envLockKeys(campaignId: string, payload: unknown): string[] {
  const keys = new Set<string>();
  if (isKaliPayload(payload)) {
    keys.add(`workspace:${campaignId}`);
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
      const sent = await this.adapter.sendAsync(permit.invocation_id, req.payload);
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
      if (Number(run.fence) !== req.lease.fence) {
        return { ok: false as const, reason: "stale_fence", invocation_id: "none" };
      }
      if (req.envTool && !this.storage.envAdmissionOpen(req.lease.run_id)) {
        return { ok: false as const, reason: "finish_closed_env", invocation_id: "none" };
      }
      if (!this.budget.canAdmit(req.lease.campaign_id, 1, 0, 0)) {
        throw new DomainError("budget_exhausted", "dispatch blocked", "budget");
      }
      const inv = this.invocations.prepare({
        campaign_id: req.lease.campaign_id,
        run_id: req.lease.run_id,
        kind: "tool",
        purpose: req.purpose,
        fence: req.lease.fence,
        cancel_epoch: req.lease.cancel_epoch,
        effect_class: req.effect,
        reserved_calls: 1,
      });
      if (req.envTool) {
        for (const key of envLockKeys(req.lease.campaign_id, req.payload)) {
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
      const inv = this.invocations.prepare({
        campaign_id: req.lease.campaign_id,
        run_id: req.lease.run_id,
        kind: "tool",
        purpose: req.purpose,
        fence: req.lease.fence,
        cancel_epoch: req.lease.cancel_epoch,
        effect_class: req.effect,
        reserved_calls: 1,
      });
      this.budget.reserve(req.lease.campaign_id, inv.id, 1, 0, 0);
      this.invocations.mark(inv.id, "dispatching");
      return inv.id;
    });
    return r;
  }

  recover(
    campaignId: string,
    invocationId?: string,
  ): { prepared_released: number; marked_uncertain: number; reconciled: number; still_running: number } {
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
      if (state === "prepared") {
        this.invocations.mark(id, "failed_known", { error: "never_sent" });
        this.budget.releasePrepared(campaignId, id, reserved, Number(row.reserved_tokens ?? 0), Number(row.reserved_cost ?? 0));
        prepared_released += 1;
      } else if (state === "dispatching" || state === "running") {
        const tokens = Number(row.reserved_tokens ?? 0);
        const cost = Number(row.reserved_cost ?? 0);
        this.budget.markLiability(campaignId, id, reserved, tokens, cost);
        const ext = row.external_id ? String(row.external_id) : null;
        const q = ext ? this.adapter.query(ext) : "unknown";
        if (ext && q === "completed") {
          this.invocations.mark(id, "reconciled");
          this.budget.reconcileLiability(campaignId, `rec:${id}`, reserved, reserved, tokens, tokens, cost, cost);
          this.storage.releaseResourceLocksForInvocation(campaignId, id);
          this.storage.updateOperationState(ext, "completed");
          reconciled += 1;
        } else if (ext && q === "failed") {
          this.invocations.mark(id, "failed_known");
          this.budget.reconcileLiability(campaignId, `rec:${id}`, 0, reserved, 0, tokens, 0, cost);
          this.storage.releaseResourceLocksForInvocation(campaignId, id);
          this.storage.updateOperationState(ext, "failed");
          reconciled += 1;
        } else if (state === "running" && ext) {
          this.storage.updateOperationState(ext, "running", new Date(Date.now() + 2_000).toISOString());
          still_running += 1;
        } else {
          this.invocations.mark(id, "uncertain");
          if (ext) this.storage.updateOperationState(ext, "unknown");
          marked_uncertain += 1;
        }
      } else if (state === "uncertain") {
        const ext = row.external_id ? String(row.external_id) : null;
        const reservedCalls = Number(row.reserved_calls ?? 0);
        if (!ext) {
          this.invocations.mark(id, "failed_known", { error: "never_sent" });
          this.budget.reconcileLiability(campaignId, `rec:${id}`, reservedCalls, reservedCalls);
          this.storage.releaseResourceLocksForInvocation(campaignId, id);
          reconciled += 1;
        } else if (ext && this.adapter.query(ext) === "completed") {
          this.invocations.mark(id, "reconciled");
          this.budget.reconcileLiability(campaignId, `rec:${id}`, reservedCalls, reservedCalls);
          this.storage.releaseResourceLocksForInvocation(campaignId, id);
          this.storage.updateOperationState(ext, "completed");
          reconciled += 1;
        } else if (ext && this.adapter.query(ext) === "failed") {
          this.invocations.mark(id, "failed_known");
          this.budget.reconcileLiability(campaignId, `rec:${id}`, 0, reservedCalls, 0, 0, 0, 0);
          this.storage.releaseResourceLocksForInvocation(campaignId, id);
          this.storage.updateOperationState(ext, "failed");
          reconciled += 1;
        }
      }
    }
    return { prepared_released, marked_uncertain, reconciled, still_running };
  }

  archiveLateResult(campaignId: string, invocationId: string, body: unknown): void {
    const inv = this.invocations.get(invocationId);
    if (String(inv.campaign_id) !== campaignId) throw new DomainError("cross_campaign_ref", "late result campaign mismatch", "denied");
    this.storage.store.db
      .prepare("UPDATE invocations SET error_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify({ late_archive: body, observed_at: new Date().toISOString() }), invocationId);
  }
}
