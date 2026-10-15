import { newId } from "../domain/ids.ts";
import type { EffectClass, InvocationKind, InvocationState } from "../domain/types.ts";
import { nowIso } from "../storage/db.ts";
import type { StorageService } from "../storage/service.ts";

export interface InvocationRecord {
  id: string;
  campaign_id: string;
  run_id: string;
  kind: InvocationKind;
  state: InvocationState;
  fence: number;
  cancel_epoch: number;
  effect_class: EffectClass | null;
  reserved_calls: number;
  reserved_tokens: number;
  reserved_cost: number;
}

export class InvocationBook {
  constructor(private readonly storage: StorageService) {}

  prepare(args: {
    campaign_id: string;
    run_id: string;
    kind: InvocationKind;
    purpose: string;
    fence: number;
    cancel_epoch: number;
    effect_class?: EffectClass;
    idempotency_key?: string;
    prompt_hash?: string;
    requested_model?: string;
    provider?: string;
    reserved_calls?: number;
    reserved_tokens?: number;
    reserved_cost?: number;
    /** Pre-send execution identity (H04): persisted with the permit. */
    execution_handle?: string;
    /** Caller-chosen id (the permit needs the id to describe the handle). */
    id?: string;
  }): InvocationRecord {
    const id = args.id ?? newId("inv");
    const now = nowIso();
    this.storage.store.db
      .prepare(
        `INSERT INTO invocations(id, campaign_id, run_id, kind, purpose, idempotency_key, state, dispatch_epoch, fence, cancel_epoch, effect_class, reserved_cost, reserved_tokens, reserved_calls, prompt_hash, requested_model, provider, execution_handle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'prepared', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.campaign_id,
        args.run_id,
        args.kind,
        args.purpose,
        args.idempotency_key ?? null,
        args.fence,
        args.cancel_epoch,
        args.effect_class ?? null,
        args.reserved_cost ?? 0,
        args.reserved_tokens ?? 0,
        args.reserved_calls ?? 0,
        args.prompt_hash ?? null,
        args.requested_model ?? null,
        args.provider ?? null,
        args.execution_handle ?? null,
        now,
        now,
      );
    this.storage.appendEvent(args.campaign_id, "invocation.prepared", { invocation_id: id, kind: args.kind }, { kind: "adapter", id: "gateway" }, id);
    return {
      id,
      campaign_id: args.campaign_id,
      run_id: args.run_id,
      kind: args.kind,
      state: "prepared",
      fence: args.fence,
      cancel_epoch: args.cancel_epoch,
      effect_class: args.effect_class ?? null,
      reserved_calls: args.reserved_calls ?? 0,
      reserved_tokens: args.reserved_tokens ?? 0,
      reserved_cost: args.reserved_cost ?? 0,
    };
  }

  mark(id: string, state: InvocationState, extra?: Record<string, unknown>): void {
    const actualTokens = typeof extra?.actual_tokens === "number" ? extra.actual_tokens : null;
    const actualCost = typeof extra?.actual_cost === "number" ? extra.actual_cost : null;
    this.storage.store.db
      .prepare("UPDATE invocations SET state = ?, status = ?, error_json = ?, actual_tokens = COALESCE(?, actual_tokens), actual_cost = COALESCE(?, actual_cost), updated_at = ? WHERE id = ?")
      .run(
        state,
        String(extra?.status ?? state),
        extra?.error ? JSON.stringify(extra.error) : null,
        actualTokens,
        actualCost,
        nowIso(),
        id,
      );
    if (state === "dispatching") {
      const row = this.storage.store.db.prepare("SELECT campaign_id FROM invocations WHERE id = ?").get(id) as { campaign_id: string };
      this.storage.appendEvent(row.campaign_id, "invocation.dispatched", { invocation_id: id }, { kind: "adapter", id: "gateway" }, id);
    }
  }

  /**
   * Compare-and-set: apply the transition only when the invocation is still in
   * one of `fromStates`. A terminal state reached by anyone else wins — a late
   * callback or a stale recovery query can never roll it back (P1-03/P1-04).
   */
  markCas(id: string, fromStates: readonly InvocationState[], toState: InvocationState, extra?: Record<string, unknown>): boolean {
    const actualTokens = typeof extra?.actual_tokens === "number" ? extra.actual_tokens : null;
    const actualCost = typeof extra?.actual_cost === "number" ? extra.actual_cost : null;
    const placeholders = fromStates.map(() => "?").join(",");
    const row = this.storage.store.db
      .prepare(
        `UPDATE invocations SET state = ?, status = ?, error_json = ?, actual_tokens = COALESCE(?, actual_tokens), actual_cost = COALESCE(?, actual_cost), updated_at = ?
         WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(
        toState,
        String(extra?.status ?? toState),
        extra?.error ? JSON.stringify(extra.error) : null,
        actualTokens,
        actualCost,
        nowIso(),
        id,
        ...fromStates,
      );
    return Number(row.changes) > 0;
  }

  setExternalId(id: string, executionId: string): void {
    this.storage.store.db.prepare("UPDATE invocations SET external_id = ?, updated_at = ? WHERE id = ?").run(executionId, nowIso(), id);
  }

  get(id: string): Record<string, unknown> {
    const row = this.storage.store.db.prepare("SELECT * FROM invocations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`invocation ${id} missing`);
    return row;
  }

  nonTerminal(campaignId: string): Record<string, unknown>[] {
    return this.storage.store.db
      .prepare("SELECT * FROM invocations WHERE campaign_id = ? AND state IN ('prepared','dispatching','running','uncertain')")
      .all(campaignId) as Record<string, unknown>[];
  }
}
