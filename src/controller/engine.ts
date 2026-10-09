import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "../contracts/config.ts";
import { configFingerprint, makeRuntimeConfig, printStartupBanner, validateStartupInput } from "../contracts/config.ts";
import { buildContextPack } from "../context/builder.ts";
import { evaluateCompletion, goalFactCanSatisfy, requiresIndependentGoalVerification, type CompletionSnapshot, type CoverageRow } from "../domain/completion.ts";
import { DomainError } from "../domain/errors.ts";
import type { CampaignSpec, CampaignState, RunLease, TaskOutcome } from "../domain/types.ts";
import { decideChooser, executeChooser } from "../eval/demo-policy.ts";
import { commitCompletion, enterClosing } from "./close.ts";
import { BudgetLedger } from "../gateway/budget-ledger.ts";
import { DispatchGate } from "../gateway/dispatch.ts";
import { ModelGateway, ToolGateway } from "../gateway/gateways.ts";
import { InvocationBook } from "../gateway/invocation.ts";
import { ProviderCatalog } from "../provider/catalog.ts";
import { resolveSlot } from "../provider/router.ts";
import { createCataloguedProviderStream } from "../provider/stream.ts";
import { STREAM_TIMEOUT_DEFAULT_MS } from "../provider/types.ts";
import { PiWorkerFactory, type PiWorker } from "../runtime/pi/factory.ts";
import type { TurnChooser } from "../runtime/pi/scripted-stream.ts";
import type { DockerCli } from "../tools/docker-cli.ts";
import { FileEffectAdapter, type EffectAdapter } from "../tools/effect-adapter.ts";
import type { ResolveFn } from "../tools/egress.ts";
import { KaliEffectAdapter, RoutingEffectAdapter } from "../tools/kali-adapter.ts";
import { resolveToolCapabilities } from "../tools/kali-profile.ts";
import { KaliRuntime, containerName, type KaliStartOpts } from "../tools/kali-runtime.ts";
import { ArtifactStore } from "../storage/artifacts.ts";
import { backupStore, restoreStore, type BackupReport, type RestoreReport } from "../storage/backup.ts";
import { Store } from "../storage/db.ts";
import { StorageService } from "../storage/service.ts";

import { freshWorld, oracleGoalSatisfied, type LabWorld } from "../tools/synthetic.ts";
import { SCHEMA_VERSION } from "../version.ts";

export interface EngineOptions {
  chooseDecide?: TurnChooser;
  chooseExecute?: TurnChooser;
  maxCycles?: number;
  silent?: boolean;
  effectAdapter?: EffectAdapter;
  dockerCli?: DockerCli;
  kaliResolve?: ResolveFn;
  /** Contest mode: all campaigns of this engine share one Kali container
   *  (mounts the workspace parent; per-campaign container root /workspace/<id>). */
  kaliShared?: { name: string; mountHost: string };
  pollWaitMs?: number;
}

export class Engine {
  readonly storage: StorageService;
  readonly budget: BudgetLedger;
  readonly invocations: InvocationBook;
  readonly factory: PiWorkerFactory;
  readonly config: RuntimeConfig;
  readonly dispatchGate: DispatchGate;
  readonly kali: KaliRuntime;
  readonly logs: string[] = [];
  lastWorker: PiWorker | null = null;
  modelSends = 0;
  toolSends = 0;
  envSends = 0;
  private readonly modelReserveTokens: number;
  private liveSessionId: string;

  constructor(
    readonly configIn: RuntimeConfig,
    private readonly options: EngineOptions = {},
  ) {
    this.config = configIn;
    this.liveSessionId = configIn.instance_id;
    mkdirSync(configIn.artifact_root, { recursive: true });
    const store = new Store(configIn.db_path);
    const artifacts = new ArtifactStore(configIn.artifact_root);
    this.storage = new StorageService(store, artifacts);
    this.budget = new BudgetLedger(this.storage);
    this.invocations = new InvocationBook(this.storage);
    const fileAdapter = options.effectAdapter ?? new FileEffectAdapter(join(configIn.artifact_root, "effects"));
    this.kali = new KaliRuntime(options.dockerCli);
    const kaliAdapter = new KaliEffectAdapter(this.kali, (invocationId) => this.kaliOptsForInvocation(invocationId));
    const adapter = new RoutingEffectAdapter(fileAdapter, kaliAdapter);
    this.dispatchGate = new DispatchGate(this.storage, this.budget, this.invocations, adapter);
    const live =
      options.chooseDecide || options.chooseExecute
        ? null
        : tryLiveCatalog(configIn.data_dir, () => this.liveSessionId);
    this.modelReserveTokens = live?.reserveTokens ?? 16;
    this.factory = new PiWorkerFactory({
      storage: this.storage,
      modelGatewayFor: (lease, inner) =>
        new ModelGateway(
          this.storage,
          this.budget,
          this.invocations,
          inner,
          lease,
          live?.modelName ?? "scripted",
          live?.providerId ?? "scripted",
          live?.reserveTokens ?? 16,
          { finalizeMaxTokens: this.config.finalization.max_output_tokens },
        ),
      toolGatewayFor: (lease) =>
        new ToolGateway(this.storage, this.budget, this.invocations, lease, this.dispatchGate, this.config.max_tool_calls_per_run),
      chooseDecide: options.chooseDecide ?? decideChooser(),
      chooseExecute: options.chooseExecute ?? executeChooser(),
      getMaxTurns: () => ({
        decide: this.config.max_decide_turns,
        execute: this.config.max_execute_turns_per_run,
        tools: this.config.max_tool_calls_per_run,
      }),
      getFinalization: () => this.config.finalization,
      budget: this.budget,
      kali: this.kali,
      liveStream: live?.stream,
    });
  }

  log(msg: string): void {
    this.logs.push(msg);
    if (!this.options.silent) console.log(msg);
  }

  banner(): Record<string, unknown> {
    printStartupBanner(this.config, (s) => this.log(s));
    return configFingerprint(this.config);
  }

  listCampaigns(): {
    id: string;
    state: CampaignState;
    updated_at: string;
    pending_goal_claim: { id: string; proposition: string; fact_key: string } | null;
  }[] {
    return this.storage.listCampaigns().map((row) => ({
      ...row,
      pending_goal_claim: this.storage.pendingGoalClaim(row.id),
    }));
  }

  createCampaign(specInput: unknown): { id: string; state: CampaignState } {
    const spec = validateStartupInput(specInput, this.config);
    const existing = this.storage.store.db.prepare("SELECT id FROM campaigns WHERE id = ?").get(spec.campaign_id);
    if (existing) throw new DomainError("campaign_exists", "campaign already exists", "conflict");
    const rec = this.storage.createCampaign(spec);
    this.storage.saveWorld(spec.campaign_id, freshWorld());
    this.log(`created campaign ${rec.id} state=${rec.state}`);
    return { id: rec.id, state: rec.state };
  }

  async start(campaignId: string): Promise<void> {
    this.liveSessionId = campaignId;
    this.banner();
    // Short controller lease, renewed on a timer for as long as this process
    // is driving the campaign. A crashed supervisor therefore frees its
    // campaigns within ~run_lease_ms instead of holding them for an hour.
    const controllerLease = this.config.run_lease_ms;
    this.storage.acquireControllerLock(campaignId, this.config.instance_id, controllerLease);
    const lockHeartbeat = setInterval(() => {
      try {
        this.storage.heartbeatControllerLock(campaignId, this.config.instance_id, controllerLease);
      } catch {
        // DB closing; the run path surfaces real errors.
      }
    }, this.config.heartbeat_ms);
    lockHeartbeat.unref();
    try {
      await this.startLocked(campaignId);
    } finally {
      clearInterval(lockHeartbeat);
    }
  }

  private async startLocked(campaignId: string): Promise<void> {
    this.storage.recoverStaleRuns(campaignId);
    const camp0 = this.storage.getCampaign(campaignId);
    if (camp0.state === "created") {
      this.storage.setCampaignState(campaignId, "active", { kind: "user", id: "cli" });
    }
    if (camp0.state === "cancelled") return;
    if (camp0.state === "awaiting_verify") {
      this.log(`campaign ${campaignId} is awaiting_verify; use verify-goal --accept or --reject`);
      return;
    }
    await this.pollOperations(campaignId);
    await this.runLoop(campaignId);
  }

  cancel(campaignId: string): number {
    const epoch = this.storage.persistCancel(campaignId, { kind: "user", id: "cli" });
    this.kali.kill(campaignId);
    this.storage.releaseCampaignResourceLocks(campaignId);
    this.log(`cancelled campaign ${campaignId} cancel_epoch=${epoch}; campaign container stopped; packets already sent are not retracted`);
    return epoch;
  }

  kaliOpts(campaignId: string): KaliStartOpts {
    const camp = this.storage.getCampaign(campaignId);
    const allow = camp.spec.scope.assets;
    // Admission follows what the task actually carries (attachments, configured
    // entries, validated web_url), not the challenge classification. Each
    // campaign resolves its own set, shared container or not.
    const opts: KaliStartOpts = {
      campaignId,
      workspaceHost: join(this.config.data_dir, "workspace", campaignId),
      dbPath: this.config.db_path,
      secretsPath: join(this.config.data_dir, "provider-secrets.json"),
      artifactRoot: this.config.artifact_root,
      dataDir: this.config.data_dir,
      allowAssets: allow,
      network: allow.length ? "allowlist" : "none",
      resolve: this.options.kaliResolve,
      capabilities: resolveToolCapabilities(camp.spec).capabilities,
    };
    if (this.options.kaliShared) {
      // Contest mode: exec into the shared container; this campaign's
      // container-side root is /workspace/<campaignId>. Host paths unchanged.
      opts.shared = {
        name: this.options.kaliShared.name,
        mountHost: this.options.kaliShared.mountHost,
        containerRoot: `/workspace/${campaignId}`,
      };
    }
    return opts;
  }

  private kaliOptsForInvocation(invocationId: string): KaliStartOpts {
    const inv = this.invocations.get(invocationId);
    return this.kaliOpts(String(inv.campaign_id));
  }

  pause(campaignId: string): void {
    this.storage.persistPause(campaignId, { kind: "user", id: "cli" }, "paused");
  }

  resume(campaignId: string): void {
    this.storage.persistResume(campaignId, { kind: "user", id: "cli" });
  }

  hint(campaignId: string, text: string): number {
    return this.storage.persistHint(campaignId, text, { kind: "user", id: "cli" });
  }

  verifyGoal(
    campaignId: string,
    verdict: { accept: boolean; text?: string; factId?: string },
  ): { state: string; fact_id?: string; proposition?: string; epoch: number } {
    const actor = { kind: "user" as const, id: "cli" };
    const pending = this.storage.pendingGoalClaim(campaignId);
    const factId = verdict.factId ?? pending?.id;
    if (verdict.accept) {
      if (!factId) throw new DomainError("no_goal_claim", "no pending success-predicate fact to accept", "invalid_input");
      this.storage.acceptGoalClaim(campaignId, factId, actor);
      const snap = this.snapshot(campaignId);
      const decision = evaluateCompletion(snap);
      if (decision.canClose) {
        const { H } = enterClosing(this, campaignId);
        const committed = commitCompletion(this, campaignId, H);
        if (!committed.ok) {
          this.storage.setCampaignState(campaignId, "active", { kind: "controller", id: "engine" });
        }
      }
      const camp = this.storage.getCampaign(campaignId);
      return { state: camp.state, fact_id: factId, proposition: pending?.proposition, epoch: camp.epoch };
    }
    const rejected = this.storage.rejectGoalClaim(campaignId, verdict.text ?? "", actor, factId);
    const after = this.storage.getCampaign(campaignId);
    return { state: after.state, fact_id: factId, proposition: rejected.proposition, epoch: after.epoch };
  }

  reviseBudget(campaignId: string, patch: { max_calls?: number; max_tokens?: number; max_cost_micro?: number }): number {
    return this.storage.persistReviseBudget(campaignId, patch, { kind: "user", id: "cli" });
  }

  reviseScope(campaignId: string, scope_version: string): number {
    return this.storage.persistReviseScope(campaignId, scope_version, { kind: "user", id: "cli" });
  }

  explainStep(campaignId: string, stepId: string): Record<string, unknown> {
    return this.storage.explainStep(campaignId, stepId);
  }

  listOperations(campaignId: string): Record<string, unknown>[] {
    return this.storage.listOperations(campaignId).map((row) => ({
      ...row,
      container: String(row.execution_id ?? "").startsWith("kali_") ? containerName(campaignId) : null,
    }));
  }

  reconcile(
    campaignId: string,
    invocationId?: string,
  ): Promise<{ prepared_released: number; marked_uncertain: number; reconciled: number; still_running: number }> {
    return this.pollOperations(campaignId, invocationId);
  }

  async pollOperations(
    campaignId: string,
    invocationId?: string,
  ): Promise<{ prepared_released: number; marked_uncertain: number; reconciled: number; still_running: number }> {
    const pending = this.storage
      .listOperations(campaignId)
      .filter((o) => ["running", "unknown"].includes(String(o.state)))
      .filter((o) => !invocationId || String(o.invocation_id) === invocationId);
    const rec = this.dispatchGate.recover(campaignId, invocationId);
    for (const op of pending) {
      const now = this.storage.getOperation(String(op.execution_id));
      if (!now) continue;
      const st = String(now.state);
      if (st === "completed" || st === "failed") {
        await this.ingestKaliOperation(campaignId, String(now.execution_id), String(now.invocation_id ?? ""));
      }
    }
    return rec;
  }

  private async ingestKaliOperation(campaignId: string, executionId: string, invocationId: string): Promise<void> {
    if (!executionId.startsWith("kali_")) return;
    try {
      const result = this.kali.collectBackground(this.kaliOpts(campaignId), executionId);
      const art = await this.storage.putArtifact(
        campaignId,
        `${result.stdout}\n${result.stderr}`.trim() || "(empty)",
        "text/plain",
        invocationId || campaignId,
      );
      let runId: string | undefined;
      try {
        if (invocationId) runId = String(this.invocations.get(invocationId).run_id);
      } catch {
        runId = undefined;
      }
      if (!runId) {
        const row = this.storage.store.db
          .prepare("SELECT id FROM task_runs WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1")
          .get(campaignId) as { id: string } | undefined;
        runId = row?.id;
      }
      if (!runId) return;
      this.storage.recordObservation({
        campaign_id: campaignId,
        producer_id: runId,
        submission_id: `op-${executionId}`,
        run_id: runId,
        attempt_id: runId,
        subject: `kali_op:${executionId}`,
        body: { code: result.code, truncated: result.truncated, timedOut: result.timedOut, stderr: result.stderr.slice(0, 4000) },
        artifact_refs: [art.id],
        conditions: {},
        env_rev: this.storage.getCampaign(campaignId).spec.environment_revision,
      });
    } catch {
      // missing files or finished run: leave the operations row as the record
    }
  }

  async runLoop(campaignId: string): Promise<void> {
    const maxCycles = this.options.maxCycles ?? 1000;
    let decideAttemptedFor = -1;
    let lastDecideResolved = false;
    for (let i = 0; i < maxCycles; i++) {
      const camp = this.storage.getCampaign(campaignId);
      if (camp.state === "cancelled" || camp.state === "completed" || camp.state === "paused" || camp.state === "awaiting_verify") break;
      const polled = await this.pollOperations(campaignId);
      this.storage.heartbeatControllerLock(campaignId, this.config.instance_id, this.config.run_lease_ms);
      this.storage.consumeReviewedEvents(campaignId);
      this.storage.recomputeStepReadiness(campaignId);
      const worldEarly = this.storage.getWorld<LabWorld>(campaignId, freshWorld());
      if (this.storage.pendingGoalClaim(campaignId) && !rootGoalSatisfied(camp.spec, this.storage, campaignId, worldEarly)) {
        this.storage.persistPause(campaignId, { kind: "controller", id: "engine" }, "awaiting_verify");
        this.writeReport(campaignId, "awaiting_verify");
        break;
      }
      if (!this.budget.canAdmit(campaignId, 1, this.modelReserveTokens, 0)) {
        if (camp.state !== "budget_paused") {
          this.storage.persistPause(campaignId, { kind: "controller", id: "engine" }, "budget_paused");
        }
        break;
      }
      const counts = this.storage.counts(campaignId);
      // New input requests a review even while ready steps exist: Execute works
      // the current fragment, Decide re-plans at the next boundary.
      const needDecide = camp.requested_seq > camp.reviewed_seq || counts.ready + counts.blocked + counts.deferred === 0 || i === 0;
      const decideLock = this.storage.store.db.prepare("SELECT decide_lock_owner FROM campaigns WHERE id = ?").get(campaignId) as {
        decide_lock_owner: string | null;
      };
      const emptyFrontier = counts.ready + counts.blocked + counts.deferred === 0;
      const canRetryEmptyReview =
        lastDecideResolved &&
        emptyFrontier &&
        camp.empty_reviews < camp.spec.stop_policy.max_empty_reviews_per_progress_epoch;
      let ranDecide = false;
      if (
        needDecide &&
        !decideLock.decide_lock_owner &&
        camp.state !== "budget_paused" &&
        (camp.requested_seq > decideAttemptedFor || canRetryEmptyReview)
      ) {
        // Failure dedupe remembers the pre-run request watermark R: the same R
        // never retries immediately, new input (requested > R) re-enables it.
        // A commit advances reviewed_seq (to H); then the persisted seqs decide
        // what happens next, so inputs that arrived mid-run are never swallowed.
        const requestWatermark = camp.requested_seq;
        const reviewedBefore = camp.reviewed_seq;
        const decided = await this.runDecide(campaignId);
        ranDecide = Boolean(decided);
        lastDecideResolved = decided?.reason === "resolved";
        const after = this.storage.getCampaign(campaignId);
        const advanced = after.reviewed_seq > reviewedBefore || after.reviewed_seq >= after.requested_seq;
        decideAttemptedFor = advanced ? -1 : requestWatermark;
      }
      const afterDecide = this.storage.getCampaign(campaignId);
      if (afterDecide.state === "cancelled") break;
      let ranExecute = false;
      if (this.budget.canAdmit(campaignId, 1, this.modelReserveTokens, 0)) {
        ranExecute = Boolean(await this.runExecuteSlot(campaignId));
      }
      this.storage.consumeReviewedEvents(campaignId);
      this.storage.recomputeStepReadiness(campaignId);
      const snap = this.snapshot(campaignId);
      const decision = evaluateCompletion(snap);
      if (decision.suggestedState === "waiting" && polled.still_running > 0 && i < maxCycles - 1) {
        const wait = this.options.pollWaitMs ?? 2_000;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (decision.canClose) {
        const { H } = enterClosing(this, campaignId);
        this.storage.consumeReviewedEvents(campaignId);
        const committed = commitCompletion(this, campaignId, H);
        if (!committed.ok) {
          const now = this.storage.getCampaign(campaignId);
          if (now.state === "closing") {
            this.storage.setCampaignState(campaignId, "active", { kind: "controller", id: "engine" });
          }
          continue;
        }
        try {
          this.writeReportFile(join(this.config.data_dir, "reports", `${campaignId}.json`), this.storage.latestReport(campaignId));
        } catch {
          // snapshot already in DB
        }
        break;
      }
      if (decision.suggestedState === "plateau") {
        this.storage.setCampaignState(campaignId, "plateau", { kind: "controller", id: "engine" });
        this.writeReport(campaignId, "plateau");
        break;
      }
      if (decision.suggestedState === "blocked" && snap.ready_steps === 0) {
        const stillNeed = this.storage.getCampaign(campaignId);
        if (stillNeed.empty_reviews >= stillNeed.spec.stop_policy.max_empty_reviews_per_progress_epoch) {
          this.storage.setCampaignState(campaignId, "blocked", { kind: "controller", id: "engine" });
          this.writeReport(campaignId, "blocked");
          break;
        }
      }
      if (decision.suggestedState === "awaiting_verify") {
        const now = this.storage.getCampaign(campaignId);
        if (now.state !== "awaiting_verify") {
          this.storage.persistPause(campaignId, { kind: "controller", id: "engine" }, "awaiting_verify");
        }
        this.writeReport(campaignId, "awaiting_verify");
        break;
      }
      if (decision.suggestedState === "budget_paused") {
        this.storage.persistPause(campaignId, { kind: "controller", id: "engine" }, "budget_paused");
        this.writeReport(campaignId, "budget_paused");
        break;
      }
      if (!ranDecide && !ranExecute && polled.still_running === 0 && snap.ready_steps === 0) {
        // A provider outage can park every step at once. Give the transiently
        // parked ones one more chance before idling; attempt_count caps this,
        // so a genuinely dead step cannot spin the loop.
        if (this.storage.requeueTransientSteps(campaignId) > 0) {
          this.storage.recomputeStepReadiness(campaignId);
          continue;
        }
        break;
      }
    }
    const final = this.storage.getCampaign(campaignId);
    if (!this.storage.latestReport(campaignId)) {
      this.writeReport(campaignId, final.state);
    }
  }

  async runDecide(campaignId: string): Promise<TaskOutcome | null> {
    const claimed = this.storage.claimDecide(campaignId, this.config.instance_id, this.config.run_lease_ms);
    if (!claimed) return null;
    const camp = this.storage.getCampaign(campaignId);
    const lease: RunLease = {
      run_id: claimed.run_id,
      campaign_id: campaignId,
      step_id: null,
      mode: "decide",
      kind: "decide",
      attempt_no: 1,
      fence: claimed.fence,
      cancel_epoch: camp.cancel_epoch,
      deadline_ms: this.leaseDeadline(camp),
      lease_owner: this.config.instance_id,
      continuation_of: null,
    };
    return this.runWorker(lease);
  }

  async runExecuteSlot(campaignId: string): Promise<TaskOutcome | null> {
    const camp = this.storage.getCampaign(campaignId);
    const claimed = this.storage.claimNextStep(campaignId, this.config.instance_id, camp.epoch, this.config.run_lease_ms);
    if (!claimed) return null;
    const lease: RunLease = {
      run_id: claimed.run_id,
      campaign_id: campaignId,
      step_id: claimed.step_id,
      mode: "execute",
      kind: claimed.kind,
      attempt_no: claimed.attempt_no,
      fence: claimed.fence,
      cancel_epoch: camp.cancel_epoch,
      deadline_ms: this.leaseDeadline(camp),
      lease_owner: this.config.instance_id,
      continuation_of: null,
    };
    return this.runWorker(lease);
  }

  private leaseDeadline(camp: { spec: CampaignSpec }): number {
    const leaseEnd = Date.now() + this.config.run_lease_ms;
    const campaignEnd = camp.spec.budget.deadline_ms;
    if (campaignEnd != null && campaignEnd > 0) return Math.min(leaseEnd, campaignEnd);
    return leaseEnd;
  }

  async runWorker(lease: RunLease): Promise<TaskOutcome> {
    const worker = this.factory.create(lease.mode, lease.run_id) as unknown as PiWorker;
    this.lastWorker = worker;
    // Keep the short run lease alive while this process is actually working.
    // If the process dies the renewals stop, and recoverStaleRuns reclaims the
    // run within ~run_lease_ms instead of the full controller-lock TTL.
    const camp = this.storage.getCampaign(lease.campaign_id);
    const heartbeat = setInterval(() => {
      try {
        this.storage.heartbeatRun(lease.run_id, this.leaseDeadline(camp));
      } catch {
        // DB closing or run row gone; the settle path surfaces real errors.
      }
    }, this.config.heartbeat_ms);
    heartbeat.unref();
    try {
      const ctx = buildContextPack(this.storage, lease, { schema_version: SCHEMA_VERSION });
      const ctrl = new AbortController();
      await worker.start(lease, ctx, ctrl.signal);
      const outcome = await worker.settle();
      this.storage.finishRun(lease.campaign_id, lease.run_id, outcome);
      if (worker.modelGateway) this.modelSends += worker.modelGateway.modelSends;
      if (worker.toolGateway) {
        this.toolSends += worker.toolGateway.toolSends;
        this.envSends += worker.toolGateway.envSends;
      }
      return outcome;
    } finally {
      clearInterval(heartbeat);
    }
  }

  snapshot(campaignId: string): CompletionSnapshot {
    const camp = this.storage.getCampaign(campaignId);
    const counts = this.storage.counts(campaignId);
    const findings = this.storage.list("findings", campaignId).map((f) => ({ status: f.status as never }));
    const coverage = this.storage.list("coverage_items", campaignId).map(
      (c) =>
        ({
          id: String(c.id),
          mandatory: Boolean(c.mandatory),
          applicability: c.applicability,
          execution_state: c.execution_state,
          outcome: c.outcome,
          evidence_state: c.evidence_state,
        }) as CoverageRow,
    );
    const world = this.storage.getWorld<LabWorld>(campaignId, freshWorld());
    const inFlightRuns = Number(
      (this.storage.store.db.prepare("SELECT COUNT(*) AS c FROM task_runs WHERE campaign_id = ? AND state IN ('claimed','running')").get(campaignId) as { c: number }).c,
    );
    const inFlightInv = this.invocations.nonTerminal(campaignId).length;
    return {
      mode: camp.spec.mode,
      state: camp.state,
      cancel_epoch: camp.cancel_epoch,
      in_flight_runs: inFlightRuns,
      in_flight_invocations: inFlightInv,
      unconsumed_events: this.storage.unconsumedCount(campaignId),
      // Pending planner-relevant input, not audit noise: bookkeeping events
      // (decision.committed, run.finished, heartbeats) never set this.
      pending_decision: camp.requested_seq > camp.reviewed_seq,
      pending_important_proposals: pendingImportant(this.storage, campaignId),
      uncertain_invocations: this.invocations
        .nonTerminal(campaignId)
        .filter((i) => i.state === "uncertain").length,
      empty_reviews: camp.empty_reviews,
      max_empty_reviews: camp.spec.stop_policy.max_empty_reviews_per_progress_epoch,
      ready_steps: counts.ready,
      blocked_steps: counts.blocked,
      frontier_size: counts.frontier,
      new_observation_since_progress: this.storage.unconsumedCount(campaignId) > 0,
      findings,
      coverage,
      root_goal_satisfied: rootGoalSatisfied(camp.spec, this.storage, campaignId, world),
      pending_goal_claim: Boolean(this.storage.pendingGoalClaim(campaignId)),
    };
  }

  writeReport(campaignId: string, stopReason: string): Record<string, unknown> {
    const camp = this.storage.getCampaign(campaignId);
    const world = this.storage.getWorld<LabWorld>(campaignId, freshWorld());
    const budget = this.budget.snapshot(campaignId);
    const findings = this.storage.list("findings", campaignId);
    const coverage = this.storage.list("coverage_items", campaignId);
    const facts = this.storage.list("facts", campaignId);
    const steps = this.storage.list("steps", campaignId);
    const unresolved = steps.filter((s) => !["resolved", "retired"].includes(String(s.status)));
    const report = {
      campaign_id: campaignId,
      mode: camp.spec.mode,
      state: camp.state,
      scope: camp.spec.scope,
      scope_version: camp.spec.scope_version,
      goal_version: camp.spec.goal_version,
      policy_version: camp.spec.policy_version,
      environment_revision: world.env_rev,
      findings: findings.map((f) => ({
        id: f.id,
        claim: f.claim,
        status: f.status,
        evidence_refs: f.evidence_refs_json,
      })),
      coverage: coverage.map((c) => ({
        obligation: c.obligation,
        applicability: c.applicability,
        execution_state: c.execution_state,
        outcome: c.outcome,
        evidence_state: c.evidence_state,
        mandatory: c.mandatory,
      })),
      observations: this.storage.list("observations", campaignId).map((o) => ({
        id: o.id,
        subject: o.subject,
        env_rev: o.env_rev,
      })),
      facts: facts.map((f) => ({ id: f.id, proposition: f.proposition, status: f.epistemic_status, grade: f.source_grade })),
      cost: {
        calls_spent: budget.spent_calls,
        calls_free: budget.free_calls,
        tokens_spent: budget.spent_tokens,
        cost_spent_micro: budget.spent_cost,
        unknown_liability_calls: budget.liability_calls,
        unknown_cost: Number(budget.liability_cost) > 0 || camp.spec.budget.price_version === "unknown",
      },
      stop_reason: stopReason,
      unresolved: unresolved.map((s) => ({ id: s.id, question: s.question, status: s.status, blocked_reason: s.blocked_reason })),
      goal_completion: (() => {
        if (camp.spec.mode !== "goal_seeking") return "n/a";
        if (!rootGoalSatisfied(camp.spec, this.storage, campaignId, world)) return "not_satisfied";
        // honest wording: an observed-only policy completes on evidence, not on verification
        return requiresIndependentGoalVerification(camp.spec) ? "independently_verified" : "observed_only_not_independently_verified";
      })(),
      bounded_conclusion: boundedConclusion(camp.spec, world, coverage),
    };
    this.storage.saveReport(campaignId, report);
    return report;
  }

  writeReportFile(destPath: string, report: unknown): void {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, JSON.stringify(report, null, 2));
  }

  status(campaignId: string): Record<string, unknown> {
    const camp = this.storage.getCampaign(campaignId);
    const counts = this.storage.counts(campaignId);
    const budget = this.budget.snapshot(campaignId);
    const activeRun = this.storage.store.db
      .prepare("SELECT id, mode, state FROM task_runs WHERE campaign_id = ? AND state IN ('claimed','running') LIMIT 1")
      .get(campaignId);
    const openInv = this.invocations.nonTerminal(campaignId);
    const uncertain = openInv.map((row) => ({
      id: String(row.id),
      purpose: row.purpose ?? null,
      effect_class: row.effect_class ?? null,
      execution_id: row.external_id ?? null,
      state: row.state,
    }));
    const ops = this.storage.listOperations(campaignId);
    const opsOpen = ops.filter((o) => !["completed", "failed"].includes(String(o.state))).length;
    const residual = uncertain
      .filter((u) => String(u.execution_id ?? "").startsWith("kali_") || String(u.effect_class) === "unknown")
      .map((u) => ({
        execution_id: u.execution_id,
        invocation_id: u.id,
        killable: true,
        note: "cancel stops the campaign container; it does not retract packets already sent",
      }));
    return {
      campaign_id: campaignId,
      state: camp.state,
      active_run: activeRun ?? null,
      candidates_ready: counts.ready,
      blocked: counts.blocked,
      budget,
      progress_epoch: camp.progress_epoch,
      stop_reason: camp.state,
      schema_version: SCHEMA_VERSION,
      uncertain_invocations: uncertain,
      operations_open: opsOpen,
      residual,
      pending_goal_claim: this.storage.pendingGoalClaim(campaignId),
      root_goal_satisfied: rootGoalSatisfied(camp.spec, this.storage, campaignId, this.storage.getWorld<LabWorld>(campaignId, freshWorld())),
      finalization: this.storage.finalizationStats(campaignId),
    };
  }

  async backupTo(destDir: string): Promise<BackupReport> {
    return backupStore({
      db: this.storage.store.db,
      dbPath: this.storage.store.path,
      artifactRoot: this.config.artifact_root,
      destDir,
    });
  }

  close(): void {
    try {
      this.storage.releaseAllControllerLocks(this.config.instance_id);
    } catch {
      // closing after a storage fault still shuts the handle
    }
    this.storage.close();
  }

}

function tryLiveCatalog(
  dataDir: string,
  getSessionId?: () => string,
): { stream: ReturnType<typeof createCataloguedProviderStream>["stream"]; modelName: string; providerId: string; reserveTokens: number } | null {
  const catalogPath = join(dataDir, "providers.json");
  if (!existsSync(catalogPath)) return null;
  try {
    const catalog = new ProviderCatalog(dataDir);
    const route = resolveSlot(catalog, "solver");
    if (!route.model.available) return null;
    const { stream } = createCataloguedProviderStream({
      catalog,
      providerId: route.provider.id,
      modelName: route.model.name,
      fetchFn: (url, init) => fetch(url, init),
      maxRetries: 2,
      timeoutMs: STREAM_TIMEOUT_DEFAULT_MS,
      sessionId: getSessionId,
    });
    return {
      stream,
      modelName: route.model.name,
      providerId: route.provider.id,
      reserveTokens: route.model.max_output_tokens,
    };
  } catch {
    return null;
  }
}

function pendingImportant(storage: StorageService, campaignId: string): number {
  const uncommitted = Number(
    (storage.store.db.prepare("SELECT COUNT(*) AS c FROM decision_runs WHERE campaign_id = ? AND committed = 0").get(campaignId) as { c: number }).c,
  );
  const pendingFindings = Number(
    (storage.store.db
      .prepare("SELECT COUNT(*) AS c FROM findings WHERE campaign_id = ? AND status IN ('suspected','validating')")
      .get(campaignId) as { c: number }).c,
  );
  return uncommitted + pendingFindings;
}

function rootGoalSatisfied(spec: CampaignSpec, storage: StorageService, campaignId: string, world: LabWorld): boolean {
  if (spec.mode !== "goal_seeking") return false;
  const ref = spec.root_goal.success_predicate_ref;
  if (ref === "sample_recovered") return oracleGoalSatisfied(world);
  const facts = storage.store.db
    .prepare("SELECT fact_key, epistemic_status, validity, source_grade FROM facts WHERE campaign_id = ? AND fact_key = ?")
    .all(campaignId, ref) as { fact_key: string; epistemic_status: string; validity: string; source_grade: string }[];
  return facts.some((f) => goalFactCanSatisfy(spec, f));
}

export function restoreEngineData(backupDir: string, destDir: string): RestoreReport {
  return restoreStore({ backupDir, destDir });
}

function boundedConclusion(spec: CampaignSpec, world: LabWorld, coverage: Record<string, unknown>[]): string {
  const untested = coverage.filter((c) => c.execution_state !== "tested" && c.mandatory);
  if (spec.mode === "assessment" && untested.length) {
    return `In scope ${spec.scope_version}, condition env=${world.env_rev}, version goal=${spec.goal_version}, completed checks that have current evidence; ${untested.length} mandatory coverage item(s) untested. This is not a safety claim.`;
  }
  if (world.cabinet_open) {
    return `In scope ${spec.scope.profile}, env ${world.env_rev}: recovered sample ${world.sample_id}. Remaining uncertainty: synthetic world only.`;
  }
  return `In scope ${spec.scope.profile}, env ${world.env_rev}: sample not recovered. No statement that the world is safe.`;
}

export function openEngine(dataDir: string, options?: EngineOptions): Engine {
  return new Engine(makeRuntimeConfig(dataDir, `local-${randomUUID().slice(0, 8)}`), options);
}
