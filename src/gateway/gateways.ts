import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { DomainError, denied } from "../domain/errors.ts";
import { hashJson } from "../domain/fingerprint.ts";
import type { EffectClass, RunLease } from "../domain/types.ts";
import { createScriptedErrorStream } from "../runtime/pi/scripted-stream.ts";
import type { StorageService } from "../storage/service.ts";
import { BudgetLedger } from "./budget-ledger.ts";
import { runWithOuterDeadline } from "./deadline.ts";
import { QueueDeadlineError, type Permit, type Semaphore } from "./semaphore.ts";
import type { DispatchGate } from "./dispatch.ts";
import { InvocationBook, type InvocationRecord } from "./invocation.ts";
import { assertSafeToolPath, isPolicyInjectionText } from "./sandbox.ts";
import { join } from "node:path";

export function guardToolArgs(storage: StorageService, campaignId: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const path = obj.path ?? obj.file ?? obj.target_path;
  if (typeof path !== "string") return null;
  const camp = storage.getCampaign(campaignId);
  const dataDir = storage.store.path === ":memory:" ? process.cwd() : join(storage.store.path, "..");
  try {
    assertSafeToolPath(
      {
        workspace: join(dataDir, "workspace", campaignId),
        db_path: storage.store.path,
        secrets_path: join(dataDir, "provider-secrets.json"),
        artifact_root: join(dataDir, "artifacts"),
      },
      path,
    );
  } catch (err) {
    return err instanceof Error ? err.message : "path_denied";
  }
  void camp;
  return null;
}

export function ingestToolOutputAsData(storage: StorageService, campaignId: string, runId: string, text: string): void {
  if (!isPolicyInjectionText(text)) return;
  storage.recordObservation({
    campaign_id: campaignId,
    producer_id: runId,
    submission_id: `inj-${Date.now()}`,
    run_id: runId,
    attempt_id: runId,
    subject: "untrusted_tool_text",
    body: { text, treated_as: "data" },
    artifact_refs: [],
    conditions: {},
    env_rev: storage.getCampaign(campaignId).spec.environment_revision,
  });
}

export interface ToolInvokeRequest {
  name: string;
  args: unknown;
  lease: RunLease;
  effect: EffectClass;
  envTool: boolean;
  /** Worker cancellation: aborts only this invocation's process. */
  signal?: AbortSignal;
  controlPlane?: "terminal";
}

export interface ToolInvokeResult {
  invocation_id: string;
  blocked: boolean;
  reason?: string;
  allowed: boolean;
}

export interface ModelCallRecord {
  purpose: string;
  reserved_tokens: number;
  max_tokens: number;
  thinking_level: string;
  force_tool: string | null;
}

export class ModelGateway {
  modelSends = 0;
  lastError: string | null = null;
  closed = false;
  phase: "primary" | "finalizing" = "primary";
  lastCall: ModelCallRecord | null = null;
  private readonly finalizeMaxTokens: number;

  constructor(
    private readonly storage: StorageService,
    private readonly budget: BudgetLedger,
    private readonly invocations: InvocationBook,
    private readonly inner: StreamFn,
    private readonly lease: RunLease,
    private readonly modelId: string,
    private readonly providerName = "scripted",
    private readonly reserveTokens = 16,
    extra: { finalizeMaxTokens?: number; semaphore?: Semaphore } = {},
  ) {
    this.finalizeMaxTokens = Math.max(1, extra.finalizeMaxTokens ?? 12800);
    this.sem = extra.semaphore ?? null;
  }

  private readonly sem: Semaphore | null;

  closeAdmission(): void {
    this.closed = true;
  }


  setPhase(phase: "primary" | "finalizing"): void {
    this.phase = phase;
  }

  /**
   * Re-check admission against the database after a queued wait, right before
   * the provider call. A campaign paused/cancelled or a run reclaimed while we
   * queued must release the slot without ever sending (spec H01 §3.4).
   */
  private revalidateBeforeSend(): string | null {
    let camp;
    try {
      camp = this.storage.getCampaign(this.lease.campaign_id);
    } catch {
      return "campaign_not_found";
    }
    if (camp.cancel_epoch > this.lease.cancel_epoch || camp.state === "cancelled") return "campaign cancelled";
    // Paused or hard-stopped while queueing: release the slot, never send.
    if (camp.state === "paused" || camp.state === "budget_paused") return "campaign_not_active";
    if (this.lease.mode === "execute" && !this.storage.admissionOpen(this.lease.campaign_id)) return "admission closed";
    let run;
    try {
      run = this.storage.getRun(this.lease.run_id);
    } catch {
      return "run_not_live";
    }
    if (String(run.state) !== "claimed" && String(run.state) !== "running") return "run_not_live";
    if (Number(run.fence) !== this.lease.fence) return "stale_fence";
    if (run.controller_generation != null) {
      // L09: the claiming controller generation must still hold the lock.
      const lock = this.storage.store.db
        .prepare("SELECT 1 FROM controller_locks WHERE campaign_id = ? AND generation = ? AND lease_until > ?")
        .get(this.lease.campaign_id, Number(run.controller_generation), Date.now());
      if (!lock) return "controller_lost";
    }
    // Fresh DB deadline, not the snapshot taken when the lease was created.
    if (Date.now() > Number(run.deadline_ms)) return "lease_expired";
    return null;
  }

  /**
   * Queue for a provider slot, revalidate, send, and observe termination.
   * The permit is held until the underlying stream actually finishes — an
   * abort signal alone does not prove the provider connection is gone (S15).
   */
  private async sendGated(
    callModel: Model<string>,
    context: Context,
    callOpts: unknown,
    inv: InvocationRecord,
    settle: SettleOnce,
  ): Promise<AssistantMessageEventStream> {
    let permit: Permit | null = null;
    if (this.sem) {
      try {
        permit = await this.sem.acquire({ deadlineAt: this.lease.deadline_ms });
      } catch (err) {
        // Never granted => provably never sent: release the reservation.
        settle.neverSent(err instanceof QueueDeadlineError ? "lease_expired" : "queue_aborted");
        return errorStream(callModel, err instanceof QueueDeadlineError ? "lease_expired" : "queue_aborted");
      }
    }
    // Whether or not a queue exists, revalidate against the database right
    // before sending (H01 §3.4 step 4): a campaign paused/cancelled or a run
    // reclaimed while we prepared/queued must never reach the provider.
    const deny = this.revalidateBeforeSend();
    if (deny) {
      permit?.release();
      settle.neverSent(deny);
      return errorStream(callModel, deny);
    }
    this.invocations.mark(inv.id, "dispatching");
    this.invocations.mark(inv.id, "running");
    this.modelSends += 1;
    let raw: AssistantMessageEventStream;
    try {
      raw = await this.inner(callModel, context, callOpts as never);
    } catch (err) {
      // The provider never produced a stream: nothing was sent.
      permit?.release();
      settle.neverSent(String(err instanceof Error ? err.message : err));
      return errorStream(callModel, err instanceof Error ? err.message : String(err));
    }
    // Terminal observation independent of the consumer: budget and slot settle
    // exactly once when the stream truly ends, even if nobody calls result().
    const orig = raw.result.bind(raw) as () => Promise<SettleMessage>;
    const terminal = orig();
    void terminal.then(
      (msg) => {
        try {
          settle.ok(msg);
        } finally {
          permit?.release();
        }
      },
      (err) => {
        try {
          settle.err(err);
        } finally {
          permit?.release();
        }
      },
    );
    // Every consumer shares the one underlying promise: no double settle, and
    // errors still propagate to whoever awaits result().
    (raw as unknown as { result: () => Promise<unknown> }).result = () => terminal;
    return raw;
  }


  finalizeReserveTokens(): number {
    return this.finalizeMaxTokens;
  }

  stream: StreamFn = (model: Model<string>, context: Context, options) => {
    if (this.closed) {
      return errorStream(model, "gateway admission closed");
    }
    const camp = this.storage.getCampaign(this.lease.campaign_id);
    if (camp.cancel_epoch > this.lease.cancel_epoch || camp.state === "cancelled") {
      return errorStream(model, "campaign cancelled");
    }
    if (!this.storage.admissionOpen(this.lease.campaign_id) && this.lease.mode === "execute") {
      return errorStream(model, "admission closed");
    }
    const deadlineDeny = admissionDeadline(this.storage, this.lease);
    if (deadlineDeny) {
      this.lastError = deadlineDeny;
      return errorStream(model, deadlineDeny);
    }
    const finalizing = this.phase === "finalizing";
    const reserveTokens = Math.max(1, finalizing ? this.finalizeMaxTokens : this.reserveTokens);
    const purpose = finalizing ? "execute_finalize" : this.lease.mode;
    const forceTool = finalizing ? "finish_step" : null;
    const thinkingLevel = finalizing ? "low" : String(options?.reasoning ?? camp.spec.model_policy.thinking_level);
    this.lastCall = {
      purpose,
      reserved_tokens: reserveTokens,
      max_tokens: reserveTokens,
      thinking_level: thinkingLevel,
      force_tool: forceTool,
    };
    if (!this.budget.canAdmit(this.lease.campaign_id, 1, reserveTokens, 0)) {
      this.lastError = "budget_exhausted";
      return errorStream(model, "budget_exhausted");
    }
    const inv = this.invocations.prepare({
      campaign_id: this.lease.campaign_id,
      run_id: this.lease.run_id,
      kind: "model",
      purpose,
      fence: this.lease.fence,
      cancel_epoch: this.lease.cancel_epoch,
      prompt_hash: hashJson({ system: context.systemPrompt, n: context.messages.length }),
      requested_model: this.modelId,
      provider: this.providerName,
      reserved_calls: 1,
      reserved_tokens: reserveTokens,
    });
    this.budget.reserve(this.lease.campaign_id, inv.id, 1, reserveTokens, 0);
    // One settle for every terminal path — success, provider error, queue
    // denial, or a thrown send. Repeat settlement is a no-op (S13).
    const settle = new SettleOnce(this.invocations, this.budget, this.lease.campaign_id, inv);
    const callModel = { ...model, maxTokens: reserveTokens };
    const callOpts = {
      ...options,
      maxTokens: reserveTokens,
      reasoning: finalizing ? ("low" as const) : options?.reasoning,
    };
    // Provider concurrency cap: the stream waits for a free slot before the
    // provider call starts; the slot frees when the stream settles. The
    // (possibly queued) stream still settles the invocation and the budget
    // reserve through `settle` on its real termination.
    return this.sendGated(callModel, context, callOpts, inv, settle);
  };
}

export class ToolGateway {
  toolSends = 0;
  envSends = 0;
  blockedAfterFinish = 0;
  closed = false;

  constructor(
    private readonly storage: StorageService,
    private readonly budget: BudgetLedger,
    private readonly invocations: InvocationBook,
    private readonly lease: RunLease,
    private readonly dispatchGate?: DispatchGate,
    private readonly maxToolCalls = 24,
  ) {}

  closeAdmission(): void {
    this.closed = true;
  }

  async admit(req: ToolInvokeRequest): Promise<ToolInvokeResult> {
    if (this.closed) {
      return { invocation_id: "none", blocked: true, reason: "gateway_closed", allowed: false };
    }
    const camp = this.storage.getCampaign(this.lease.campaign_id);
    if (camp.cancel_epoch !== this.lease.cancel_epoch && camp.cancel_epoch > this.lease.cancel_epoch) {
      return { invocation_id: "none", blocked: true, reason: "cancel_epoch", allowed: false };
    }
    const run = this.storage.getRun(this.lease.run_id);
    if (Number(run.fence) !== this.lease.fence) {
      return { invocation_id: "none", blocked: true, reason: "stale_fence", allowed: false };
    }
    const terminal = req.controlPlane === "terminal";
    if (!terminal) {
      const deadlineDeny = admissionDeadline(this.storage, this.lease);
      if (deadlineDeny) {
        return { invocation_id: "none", blocked: true, reason: deadlineDeny, allowed: false };
      }
    }
    const allow = this.storage.getCampaign(this.lease.campaign_id).spec.tool_allowlist;
    if (!terminal && allow.length > 0 && !allow.includes(req.name)) {
      return { invocation_id: "none", blocked: true, reason: "tool_not_allowlisted", allowed: false };
    }
    if (req.envTool && !this.storage.envAdmissionOpen(this.lease.run_id)) {
      this.blockedAfterFinish += 1;
      return { invocation_id: "none", blocked: true, reason: "finish_closed_env", allowed: false };
    }
    const pathDenied = guardToolArgs(this.storage, this.lease.campaign_id, req.args);
    if (pathDenied) {
      return { invocation_id: "none", blocked: true, reason: pathDenied, allowed: false };
    }
    if (!terminal) {
      const used = Number(
        (this.storage.store.db.prepare("SELECT COUNT(*) AS c FROM invocations WHERE run_id = ? AND kind = 'tool'").get(this.lease.run_id) as { c: number }).c,
      );
      if (used >= this.maxToolCalls) {
        return { invocation_id: "none", blocked: true, reason: "run_tool_cap", allowed: false };
      }
    } else {
      const runState = this.storage.getRun(this.lease.run_id);
      if (String(runState.state) === "finished" && !runState.finish_payload_json) {
        return { invocation_id: "none", blocked: true, reason: "run_finished", allowed: false };
      }
    }
    if (req.envTool) {
      if (!this.dispatchGate) {
        return { invocation_id: "none", blocked: true, reason: "no_dispatch_gate", allowed: false };
      }
      const ms = Math.max(1, this.lease.deadline_ms - Date.now());
      try {
        const timed = await runWithOuterDeadline(ms, (deadlineSignal) =>
          this.dispatchGate!.dispatchAsync({
            lease: this.lease,
            purpose: req.name,
            payload: req.args,
            effect: req.effect,
            envTool: true,
            // worker abort OR the outer deadline kills just this invocation's process
            signal: req.signal ? AbortSignal.any([req.signal, deadlineSignal]) : deadlineSignal,
          }),
        );
        if (!timed.ok || !timed.value) {
          return { invocation_id: "none", blocked: true, reason: timed.residual, allowed: false };
        }
        if (timed.value.status !== "sent") {
          if (timed.value.reason === "finish_closed_env") this.blockedAfterFinish += 1;
          return {
            invocation_id: timed.value.invocation_id,
            blocked: true,
            reason: timed.value.reason ?? timed.value.status,
            allowed: false,
          };
        }
        this.toolSends += 1;
        this.envSends += 1;
        ingestToolOutputAsData(this.storage, this.lease.campaign_id, this.lease.run_id, JSON.stringify(req.args ?? {}));
        return { invocation_id: timed.value.invocation_id, blocked: false, allowed: true };
      } catch (err) {
        const reason = err instanceof DomainError ? err.code : String(err);
        return { invocation_id: "none", blocked: true, reason, allowed: false };
      }
    }
    if (terminal) {
      ingestToolOutputAsData(this.storage, this.lease.campaign_id, this.lease.run_id, JSON.stringify(req.args ?? {}));
      return { invocation_id: "terminal", blocked: false, allowed: true };
    }
    if (!this.budget.canAdmit(this.lease.campaign_id, 1, 0, 0)) {
      throw new DomainError("budget_exhausted", "tool call exceeds root cap", "budget");
    }
    // prepare+reserve must land together or not at all
    const inv = this.storage.store.transaction(() => {
      const i = this.invocations.prepare({
        campaign_id: this.lease.campaign_id,
        run_id: this.lease.run_id,
        kind: "tool",
        purpose: req.name,
        fence: this.lease.fence,
        cancel_epoch: this.lease.cancel_epoch,
        effect_class: req.effect,
        reserved_calls: 1,
      });
      this.budget.reserve(this.lease.campaign_id, i.id, 1, 0, 0);
      this.invocations.mark(i.id, "dispatching");
      return i;
    });
    this.invocations.mark(inv.id, "running");
    this.toolSends += 1;
    this.invocations.mark(inv.id, "completed");
    this.budget.settle(this.lease.campaign_id, inv.id, 1, 0, 0, 1, 0, 0);
    ingestToolOutputAsData(this.storage, this.lease.campaign_id, this.lease.run_id, JSON.stringify(req.args ?? {}));
    return { invocation_id: inv.id, blocked: false, allowed: true };
  }
}

function admissionDeadline(storage: StorageService, lease: RunLease): string | null {
  if (Date.now() > lease.deadline_ms) return "lease_expired";
  const camp = storage.getCampaign(lease.campaign_id);
  if (camp.spec.budget.deadline_ms != null && Date.now() > camp.spec.budget.deadline_ms) return "campaign_deadline";
  return null;
}

interface SettleMessage {
  usage?: { totalTokens?: number };
  stopReason?: string;
  errorMessage?: string | null;
}

/**
 * Exactly-once settlement of a model invocation and its budget reservation.
 * ok(): the stream finished — actual tokens are settled (0 for error/aborted
 * stops, which prove nothing about delivery but do about our own stream).
 * neverSent(): no provider request left this process — release the reservation.
 * err(): transport-level failure — settle to zero actuals, keep the reason.
 */
class SettleOnce {
  private done = false;

  constructor(
    private readonly invocations: InvocationBook,
    private readonly budget: BudgetLedger,
    private readonly campaignId: string,
    private readonly inv: InvocationRecord,
  ) {}

  ok(msg: SettleMessage): void {
    if (this.done) return;
    this.done = true;
    const failed = msg.stopReason === "error" || msg.stopReason === "aborted";
    const tokens = Number(msg.usage?.totalTokens ?? this.inv.reserved_tokens);
    this.invocations.mark(this.inv.id, failed ? "failed_known" : "completed", {
      actual_tokens: tokens,
      error: msg.errorMessage ?? undefined,
      status: msg.stopReason,
    });
    this.budget.settle(this.campaignId, this.inv.id, 1, tokens, 0, this.inv.reserved_calls, this.inv.reserved_tokens, this.inv.reserved_cost);
  }

  neverSent(reason: string): void {
    if (this.done) return;
    this.done = true;
    this.invocations.mark(this.inv.id, "failed_known", { error: `not_dispatched:${reason}` });
    this.budget.settle(this.campaignId, this.inv.id, 1, 0, 0, this.inv.reserved_calls, this.inv.reserved_tokens, this.inv.reserved_cost);
  }

  err(err: unknown): void {
    if (this.done) return;
    this.done = true;
    this.invocations.mark(this.inv.id, "failed_known", { error: String(err) });
    this.budget.settle(this.campaignId, this.inv.id, 1, 0, 0, this.inv.reserved_calls, this.inv.reserved_tokens, this.inv.reserved_cost);
  }
}

function errorStream(model: Model<string>, message: string): AssistantMessageEventStream {
  return createScriptedErrorStream(model, message);
}

export { denied };
