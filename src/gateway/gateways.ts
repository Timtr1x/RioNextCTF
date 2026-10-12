import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { DomainError, denied } from "../domain/errors.ts";
import { hashJson } from "../domain/fingerprint.ts";
import type { EffectClass, RunLease } from "../domain/types.ts";
import { createScriptedErrorStream } from "../runtime/pi/scripted-stream.ts";
import type { StorageService } from "../storage/service.ts";
import { BudgetLedger } from "./budget-ledger.ts";
import { runWithOuterDeadline } from "./deadline.ts";
import type { DispatchGate } from "./dispatch.ts";
import { InvocationBook } from "./invocation.ts";
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
    extra: { finalizeMaxTokens?: number } = {},
  ) {
    this.finalizeMaxTokens = Math.max(1, extra.finalizeMaxTokens ?? 12800);
  }

  closeAdmission(): void {
    this.closed = true;
  }

  setPhase(phase: "primary" | "finalizing"): void {
    this.phase = phase;
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
    this.invocations.mark(inv.id, "dispatching");
    this.invocations.mark(inv.id, "running");
    this.modelSends += 1;
    try {
      const callModel = { ...model, maxTokens: reserveTokens };
      const callOpts = {
        ...options,
        maxTokens: reserveTokens,
        reasoning: finalizing ? ("low" as const) : options?.reasoning,
      };
      const stream = this.inner(callModel, context, callOpts);
      return wrapSettle(stream, (msg) => {
        const tokens = Number(msg.usage?.totalTokens ?? reserveTokens);
        const failed = msg.stopReason === "error" || msg.stopReason === "aborted";
        this.invocations.mark(inv.id, failed ? "failed_known" : "completed", {
          actual_tokens: tokens,
          error: msg.errorMessage ?? undefined,
          status: msg.stopReason,
        });
        this.budget.settle(
          this.lease.campaign_id,
          inv.id,
          1,
          tokens,
          0,
          inv.reserved_calls,
          inv.reserved_tokens,
          inv.reserved_cost,
        );
      }, (err) => {
        this.invocations.mark(inv.id, "failed_known", { error: String(err) });
        this.budget.settle(this.lease.campaign_id, inv.id, 1, 0, 0, inv.reserved_calls, inv.reserved_tokens, inv.reserved_cost);
      });
    } catch (err) {
      this.invocations.mark(inv.id, "failed_known", { error: String(err) });
      this.budget.settle(this.lease.campaign_id, inv.id, 1, 0, 0, inv.reserved_calls, inv.reserved_tokens, inv.reserved_cost);
      return errorStream(model, err instanceof Error ? err.message : String(err));
    }
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
        const timed = await runWithOuterDeadline(ms, () =>
          this.dispatchGate!.dispatchAsync({
            lease: this.lease,
            purpose: req.name,
            payload: req.args,
            effect: req.effect,
            envTool: true,
            signal: req.signal,
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
    const inv = this.invocations.prepare({
      campaign_id: this.lease.campaign_id,
      run_id: this.lease.run_id,
      kind: "tool",
      purpose: req.name,
      fence: this.lease.fence,
      cancel_epoch: this.lease.cancel_epoch,
      effect_class: req.effect,
      reserved_calls: 1,
    });
    this.budget.reserve(this.lease.campaign_id, inv.id, 1, 0, 0);
    this.invocations.mark(inv.id, "dispatching");
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

function errorStream(model: Model<string>, message: string): AssistantMessageEventStream {
  return createScriptedErrorStream(model, message);
}

function wrapSettle(
  stream: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  onOk: (msg: { usage?: { totalTokens?: number }; stopReason?: string; errorMessage?: string | null }) => void,
  onErr: (e: unknown) => void,
): AssistantMessageEventStream | Promise<AssistantMessageEventStream> {
  if (stream && typeof (stream as Promise<AssistantMessageEventStream>).then === "function") {
    return (stream as Promise<AssistantMessageEventStream>).then((s) => wrapSettle(s, onOk, onErr) as AssistantMessageEventStream);
  }
  const s = stream as AssistantMessageEventStream;
  const orig = s.result.bind(s);
  (s as unknown as { result: () => Promise<unknown> }).result = async () => {
    try {
      const r = (await orig()) as { usage?: { totalTokens?: number }; stopReason?: string; errorMessage?: string | null };
      onOk(r);
      return r;
    } catch (e) {
      onErr(e);
      throw e;
    }
  };
  return s;
}

export { denied };
