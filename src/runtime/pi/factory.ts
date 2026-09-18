import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { loadPrompt } from "../../context/builder.ts";
import type { FinalizationConfig } from "../../contracts/finalization.ts";
import {
  frameworkReason,
  isSemanticDisposition,
  needsFinalizer,
  parseFinishInput,
  type FinalizeContext,
  type PrimaryStopTrigger,
  type WorkerPhase,
} from "../../contracts/finalization.ts";
import type { ContextPack, WorkerFactory, WorkerRuntime } from "../../contracts/worker-runtime.ts";
import { DomainError } from "../../domain/errors.ts";
import { newId } from "../../domain/ids.ts";
import type { RunLease, TaskOutcome, WorkerMode } from "../../domain/types.ts";
import type { BudgetLedger } from "../../gateway/budget-ledger.ts";
import { ingestToolOutputAsData, type ModelGateway, type ToolGateway } from "../../gateway/gateways.ts";
import type { StorageService } from "../../storage/service.ts";
import { isKaliProfile } from "../../tools/kali-profile.ts";
import {
  KALI_RUN_DESCRIPTION,
  KALI_RUN_PARAMETERS,
  KALI_WRITE_DESCRIPTION,
  KALI_WRITE_PARAMETERS,
  PLAYWRIGHT_DESCRIPTION,
  PLAYWRIGHT_PARAMETERS,
} from "../../tools/kali-schemas.ts";
import type { KaliRuntime } from "../../tools/kali-runtime.ts";
import { actWorld, inspectWorld, type LabWorld } from "../../tools/synthetic.ts";
import type { StreamFn as PiStreamFn } from "@earendil-works/pi-agent-core";
import { SCRIPTED_MODEL, type TurnChooser, createScriptedStreamFn } from "./scripted-stream.ts";

export const TOOL_STDOUT_PREVIEW = 50_000;
export const TOOL_STDERR_PREVIEW = 2000;
export const ARTIFACT_SLICE_MAX = 50_000;

export interface FactoryDeps {
  storage: StorageService;
  modelGatewayFor: (lease: RunLease, inner: PiStreamFn) => ModelGateway;
  toolGatewayFor: (lease: RunLease) => ToolGateway;
  chooseDecide: TurnChooser;
  chooseExecute: TurnChooser;
  getMaxTurns: () => { decide: number; execute: number; tools?: number };
  getFinalization: () => FinalizationConfig;
  budget: BudgetLedger;
  kali?: KaliRuntime;
  liveStream?: PiStreamFn;
}

export class PiWorkerFactory implements WorkerFactory {
  constructor(private readonly deps: FactoryDeps) {}

  create(mode: WorkerMode, run_id: string): WorkerRuntime {
    return new PiWorker(mode, run_id, this.deps);
  }
}

export class PiWorker implements WorkerRuntime {
  readonly mode: WorkerMode;
  readonly run_id: string;
  private abortCtrl: AbortController | null = null;
  private outcome: TaskOutcome | null = null;
  private settled: Promise<TaskOutcome> | null = null;
  agent: Agent | null = null;
  readonly submittedObservations: string[] = [];
  readonly submittedFacts: string[] = [];
  readonly submittedFindings: string[] = [];
  events: AgentEvent[] = [];
  toolExecution: "sequential" | "parallel" = "sequential";
  finishThenBlocked = 0;
  modelGateway: ModelGateway | null = null;
  toolGateway: ToolGateway | null = null;
  phase: WorkerPhase = "primary";
  primaryStop: PrimaryStopTrigger | null = null;
  finalizerModelSends = 0;
  private stopAfterTurnReason: "turn_cap" | "tool_cap" | "finish" | null = null;
  private activeLease: RunLease | null = null;
  private activeContext: ContextPack | null = null;

  constructor(
    mode: WorkerMode,
    run_id: string,
    private readonly deps: FactoryDeps,
  ) {
    this.mode = mode;
    this.run_id = run_id;
  }

  abort(): void {
    this.abortCtrl?.abort();
    this.agent?.abort();
    this.agent?.clearAllQueues();
  }

  async start(lease: RunLease, context: ContextPack, signal: AbortSignal): Promise<void> {
    this.abortCtrl = new AbortController();
    signal.addEventListener("abort", () => this.abort());
    this.activeLease = lease;
    this.activeContext = context;
    const chooser = this.mode === "decide" ? this.deps.chooseDecide : this.deps.chooseExecute;
    const inner = this.deps.liveStream ?? createScriptedStreamFn(chooser);
    this.modelGateway = this.deps.modelGatewayFor(lease, inner);
    this.toolGateway = this.deps.toolGatewayFor(lease);
    this.settled = this.mode === "decide" ? this.runDecide(lease, context) : this.runExecute(lease, context);
    void this.settled;
  }

  private async runDecide(lease: RunLease, context: ContextPack): Promise<TaskOutcome> {
    const tools = this.buildTools(lease, context);
    await this.runAgentLoop(lease, context, tools, this.deps.getMaxTurns().decide, "primary");
    if (!this.outcome) {
      this.outcome = this.makeOutcome(lease, "incomplete_protocol", "missing finish tool", false);
    }
    this.phase = "settled";
    return this.outcome;
  }

  private async runExecute(lease: RunLease, context: ContextPack): Promise<TaskOutcome> {
    this.phase = "primary";
    const tools = this.buildTools(lease, context);
    const maxTurns = this.deps.getMaxTurns().execute;
    await this.runAgentLoop(lease, context, tools, maxTurns, "primary");
    const trigger = this.classifyPrimaryExit(lease);
    this.primaryStop = trigger;
    // Keep the provider's own words: a dead run without the reason ("http_500",
    // a timeout, a connection reset) can only be diagnosed by guessing.
    const failureDetail = lastAssistant(this.agent?.state.messages ?? [])?.errorMessage ?? null;
    this.deps.storage.recordPrimaryStop(lease.campaign_id, lease.run_id, trigger, lease.step_id, failureDetail);
    if (this.outcome && isSemanticDisposition(this.outcome.reason) && this.outcome.finish_requested) {
      this.phase = "settled";
      return this.outcome;
    }
    if (
      needsFinalizer(trigger) &&
      this.canAffordFinalizer(lease, trigger) &&
      (trigger === "natural_stop" || trigger === "turn_cap" || trigger === "tool_cap")
    ) {
      const repaired = await this.runFinalizer(lease, context, trigger);
      if (repaired) {
        this.phase = "settled";
        return repaired;
      }
    }
    if (!this.outcome || !isSemanticDisposition(this.outcome.reason) || !this.outcome.finish_requested) {
      const reason = this.frameworkOutcomeReason(lease, trigger);
      this.outcome = this.makeOutcome(
        lease,
        reason,
        this.outcome?.summary ?? `primary_stop:${trigger}`,
        Boolean(this.outcome?.finish_requested),
        this.outcome?.blocked_on ?? undefined,
      );
    }
    this.phase = "settled";
    return this.outcome;
  }

  private async runFinalizer(
    lease: RunLease,
    context: ContextPack,
    trigger: "natural_stop" | "turn_cap" | "tool_cap",
  ): Promise<TaskOutcome | null> {
    this.phase = "finalizing";
    this.deps.storage.beginFinalization(lease.campaign_id, lease.run_id, trigger, lease.step_id);
    const before = this.modelGateway?.modelSends ?? 0;
    const tools = [this.finishStepTool(lease, "finalizer")];
    const pack: ContextPack = {
      ...context,
      system_prompt: loadPrompt("finalize"),
      user_payload: this.buildFinalizeContext(lease, context, trigger),
      tool_names: ["finish_step"],
    };
    this.stopAfterTurnReason = null;
    try {
      await this.runAgentLoop(lease, pack, tools, 1, "finalizing");
    } catch (err) {
      this.finalizerModelSends = (this.modelGateway?.modelSends ?? 0) - before;
      this.deps.storage.markFinalizationFailed(lease.campaign_id, lease.run_id, String(err), lease.step_id);
      return null;
    }
    this.finalizerModelSends = (this.modelGateway?.modelSends ?? 0) - before;
    if (this.outcome && isSemanticDisposition(this.outcome.reason) && this.outcome.finish_requested) {
      return this.outcome;
    }
    this.deps.storage.markFinalizationFailed(lease.campaign_id, lease.run_id, "no_legal_finish", lease.step_id);
    return null;
  }

  private async runAgentLoop(
    lease: RunLease,
    context: ContextPack,
    tools: AgentTool[],
    maxTurns: number,
    phase: WorkerPhase,
  ): Promise<void> {
    const cfg = this.deps.getFinalization();
    const thinkingLevel =
      phase === "finalizing" ? "low" : this.deps.storage.getCampaign(lease.campaign_id).spec.model_policy.thinking_level;
    this.modelGateway?.setPhase(phase === "finalizing" ? "finalizing" : "primary");
    let turns = 0;
    const forceStop = phase === "finalizing";
    const agentModel =
      phase === "finalizing" ? { ...SCRIPTED_MODEL, maxTokens: cfg.max_output_tokens } : SCRIPTED_MODEL;
    const agent = new Agent({
      initialState: {
        systemPrompt: context.system_prompt,
        model: agentModel,
        thinkingLevel,
        tools,
      },
      streamFn: this.modelGateway!.stream,
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall }) => {
        const env = isEnvTool(toolCall.name);
        if (this.mode === "decide" && env) {
          return { block: true, reason: "decide_has_no_env_tools" };
        }
        if (phase === "finalizing" && env) {
          return { block: true, reason: "finalizer_no_env_tools" };
        }
        const terminal = toolCall.name === "finish_step" || toolCall.name === "finish_decision";
        const admitted = await this.toolGateway!.admit({
          name: toolCall.name,
          args: toolCall.arguments,
          lease,
          effect: env ? "unknown" : "pure",
          envTool: env,
          controlPlane: terminal ? "terminal" : undefined,
        });
        if (!admitted.allowed) {
          if (admitted.reason === "finish_closed_env") this.finishThenBlocked += 1;
          return { block: true, reason: admitted.reason, terminate: admitted.reason === "finish_closed_env" };
        }
        return undefined;
      },
      afterToolCall: async ({ toolCall, result }) => {
        const text = (result.content ?? [])
          .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
          .join("");
        const raw = text + JSON.stringify(result.details ?? {});
        ingestToolOutputAsData(this.deps.storage, lease.campaign_id, lease.run_id, raw);
        const art = await this.deps.storage.putArtifact(lease.campaign_id, raw.slice(0, 200_000), "application/json", lease.run_id);
        if (isEnvTool(toolCall.name)) {
          this.deps.storage.recordObservation({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            attempt_id: lease.run_id,
            subject: `tool_raw:${toolCall.name}`,
            body: { name: toolCall.name, arguments: toolCall.arguments, preview: text.slice(0, TOOL_STDOUT_PREVIEW) },
            artifact_refs: [art.id],
            conditions: {},
            env_rev: String(
              (this.deps.storage.getWorld<LabWorld>(lease.campaign_id, { env_rev: "env-1" } as LabWorld) as LabWorld).env_rev ?? "env-1",
            ),
            skip_progress: true,
          });
        }
        if (
          (toolCall.name === "finish_step" || toolCall.name === "finish_decision") &&
          this.outcome &&
          isSemanticDisposition(this.outcome.reason)
        ) {
          return { terminate: true, details: result.details };
        }
        return undefined;
      },
      shouldStopAfterTurn: async () => {
        turns += 1;
        if (forceStop) return true;
        if (this.outcome && isSemanticDisposition(this.outcome.reason) && this.outcome.finish_requested) {
          this.stopAfterTurnReason = "finish";
          return true;
        }
        if (turns >= maxTurns) {
          this.stopAfterTurnReason = "turn_cap";
          return true;
        }
        const toolCap = this.deps.getMaxTurns().tools ?? 24;
        if ((this.toolGateway?.toolSends ?? 0) >= toolCap) {
          this.stopAfterTurnReason = "tool_cap";
          return true;
        }
        return false;
      },
    });
    this.toolExecution = agent.toolExecution;
    this.agent = agent;
    agent.subscribe((event) => {
      this.events.push(event);
    });
    try {
      await agent.prompt(JSON.stringify(context.user_payload));
      await agent.waitForIdle();
    } catch (err) {
      this.outcome = this.makeOutcome(lease, "protocol_error", String(err), Boolean(this.outcome?.finish_requested));
      this.primaryStop = this.primaryStop ?? "runtime_error";
    }
  }

  private classifyPrimaryExit(lease: RunLease): PrimaryStopTrigger {
    if (this.outcome && isSemanticDisposition(this.outcome.reason) && this.outcome.finish_requested) {
      return "finish_committed";
    }
    if (this.abortCtrl?.signal.aborted) return "cancelled";
    const last = lastAssistant(this.agent?.state.messages ?? []);
    if (last?.stopReason === "error") return "model_error";
    if (last?.stopReason === "aborted") return this.abortCtrl?.signal.aborted ? "cancelled" : "aborted";
    if (this.outcome?.reason === "protocol_error") return "model_error";
    const camp = this.deps.storage.getCampaign(lease.campaign_id);
    if (Date.now() > lease.deadline_ms) return "deadline";
    if (camp.spec.budget.deadline_ms != null && Date.now() > camp.spec.budget.deadline_ms) return "deadline";
    if (this.stopAfterTurnReason === "turn_cap") return "turn_cap";
    if (this.stopAfterTurnReason === "tool_cap") return "tool_cap";
    if (last && last.stopReason !== "toolUse") return "natural_stop";
    if (!last) return "natural_stop";
    return "runtime_error";
  }

  private canAffordFinalizer(lease: RunLease, trigger: PrimaryStopTrigger): boolean {
    const cfg = this.deps.getFinalization();
    if (!cfg.enabled) return false;
    if (cfg.max_attempts !== 1) return false;
    if (!needsFinalizer(trigger)) return false;
    const camp = this.deps.storage.getCampaign(lease.campaign_id);
    if (camp.state === "cancelled" || camp.cancel_epoch > lease.cancel_epoch) return false;
    if (Date.now() > lease.deadline_ms) return false;
    if (camp.spec.budget.deadline_ms != null && Date.now() > camp.spec.budget.deadline_ms) return false;
    const tokens = this.modelGateway?.finalizeReserveTokens() ?? cfg.max_output_tokens;
    if (!this.deps.budget.canAdmit(lease.campaign_id, 1, tokens, 0)) return false;
    const uncertain = Number(
      (
        this.deps.storage.store.db
          .prepare("SELECT COUNT(*) AS c FROM invocations WHERE run_id = ? AND state = 'uncertain'")
          .get(lease.run_id) as { c: number }
      ).c,
    );
    if (uncertain > 0) return false;
    const run = this.deps.storage.getRun(lease.run_id);
    if (Number(run.finalize_attempted) >= 1 && !run.finish_payload_json) return false;
    return true;
  }

  private frameworkOutcomeReason(lease: RunLease, trigger: PrimaryStopTrigger): TaskOutcome["reason"] {
    if (needsFinalizer(trigger)) {
      if (!this.deps.getFinalization().enabled) return "incomplete_protocol";
      const camp = this.deps.storage.getCampaign(lease.campaign_id);
      if (Date.now() > lease.deadline_ms) return "budget";
      if (camp.spec.budget.deadline_ms != null && Date.now() > camp.spec.budget.deadline_ms) return "budget";
      const tokens = this.modelGateway?.finalizeReserveTokens() ?? this.deps.getFinalization().max_output_tokens;
      if (!this.deps.budget.canAdmit(lease.campaign_id, 1, tokens, 0)) return "budget";
      const uncertain = Number(
        (
          this.deps.storage.store.db
            .prepare("SELECT COUNT(*) AS c FROM invocations WHERE run_id = ? AND state = 'uncertain'")
            .get(lease.run_id) as { c: number }
        ).c,
      );
      if (uncertain > 0) return "protocol_error";
      return "incomplete_protocol";
    }
    return frameworkReason(trigger);
  }

  private buildFinalizeContext(lease: RunLease, context: ContextPack, trigger: "natural_stop" | "turn_cap" | "tool_cap"): FinalizeContext {
    const cfg = this.deps.getFinalization();
    const stepRow = lease.step_id
      ? (this.deps.storage.store.db
          .prepare("SELECT question, completion_criteria, expected_observations_json FROM steps WHERE id = ?")
          .get(lease.step_id) as
          | { question: string; completion_criteria: string; expected_observations_json: string }
          | undefined)
      : undefined;
    const ckpt = this.deps.storage.latestCheckpoint(lease.campaign_id, { runId: lease.run_id, stepId: lease.step_id });
    const arts = this.deps.storage.store.db
      .prepare("SELECT id FROM artifacts WHERE campaign_id = ? AND producer_attempt = ?")
      .all(lease.campaign_id, lease.run_id) as { id: string }[];
    const messages = this.agent?.state.messages ?? [];
    return {
      run_id: lease.run_id,
      step_id: lease.step_id ?? "",
      stop_trigger: trigger,
      step: {
        question: stepRow?.question ?? "",
        completion_criteria: stepRow?.completion_criteria ?? "",
        expected_observations: stepRow ? (JSON.parse(stepRow.expected_observations_json) as string[]) : [],
      },
      submitted: {
        observation_ids: [...this.submittedObservations],
        fact_ids: [...this.submittedFacts],
        finding_ids: [...this.submittedFindings],
        artifact_ids: arts.map((a) => a.id),
      },
      last_checkpoint: ckpt ? { note: String(ckpt.note ?? ""), next: ckpt.next ? String(ckpt.next) : null } : null,
      last_assistant_text: lastAssistantText(messages).slice(0, cfg.transcript_tail_chars),
      last_tool_results: lastToolPreviews(messages, cfg.tool_result_tail_count),
    };
  }

  private finishStepTool(lease: RunLease, source: "primary" | "finalizer"): AgentTool {
    return tool(
      "finish_step",
      "Required: end this execute fragment and free the slot. Call after progress, failure, truncated output, or cap. Checkpoint alone does not finish.",
      Type.Object(
        {
          disposition: Type.Optional(
            Type.Union([Type.Literal("resolved"), Type.Literal("deferred"), Type.Literal("blocked")]),
          ),
          reason: Type.Optional(Type.String()),
          summary: Type.String({ minLength: 1, maxLength: 8000 }),
          evidence_refs: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
          blocked_on: Type.Optional(Type.String()),
          reopen_condition: Type.Optional(Type.String()),
          reopen_rule: Type.Optional(
            Type.Object({
              kind: Type.Union(
                [
                  Type.Literal("always"),
                  Type.Literal("never"),
                  Type.Literal("fact_key"),
                  Type.Literal("env_revision"),
                  Type.Literal("observation_subject"),
                ],
                {
                  description:
                    "always: a concrete next attempt is ready now; never: no executable follow-up; fact_key: wait for a fact; env_revision: wait for an environment revision; observation_subject: wait for an observation of that subject",
                },
              ),
              key: Type.Optional(Type.String()),
              env_revision: Type.Optional(Type.String()),
              subject: Type.Optional(Type.String()),
            }),
          ),
          next_action: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async (callId, params) => {
        const parsed = parseFinishInput(params);
        if (!parsed.ok) {
          this.deps.storage.appendEvent(
            lease.campaign_id,
            "run.finish_validation_error",
            { run_id: lease.run_id, error: parsed.error, submission_id: callId },
            { kind: "worker", id: lease.run_id },
            lease.run_id,
            callId,
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: parsed.error, finish: false }) }],
            details: { error: parsed.error },
            isError: true,
          };
        }
        try {
          const result = this.deps.storage.submitRunOutcome({
            campaign_id: lease.campaign_id,
            run_id: lease.run_id,
            fence: lease.fence,
            submission_id: callId,
            payload: parsed.value,
            observation_ids: [...this.submittedObservations],
            fact_ids: [...this.submittedFacts],
            finding_ids: [...this.submittedFindings],
            source,
          });
          if (result.conflict) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: "finish_conflict", finish: false }) }],
              details: { error: "finish_conflict", duplicate: false },
              isError: true,
            };
          }
          if (!result.accepted || !result.outcome) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: result.error ?? "finish_rejected", finish: false }) }],
              details: { error: result.error ?? "finish_rejected" },
              isError: true,
            };
          }
          this.outcome = result.outcome;
          return { ...ok({ finish: true, duplicate: result.duplicate, disposition: result.outcome.reason }), terminate: true };
        } catch (err) {
          const code = err instanceof DomainError ? err.code : "finish_error";
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: code, finish: false }) }],
            details: { error: code },
            isError: true,
          };
        }
      },
    );
  }

  async settle(): Promise<TaskOutcome> {
    if (!this.settled) throw new Error("worker not started");
    return this.settled;
  }

  private makeOutcome(
    lease: RunLease,
    reason: TaskOutcome["reason"],
    summary: string,
    finish_requested: boolean,
    blocked_on?: string,
  ): TaskOutcome {
    return baseOutcome(
      lease,
      reason,
      summary,
      [...this.submittedObservations],
      [...this.submittedFacts],
      [...this.submittedFindings],
      finish_requested,
      blocked_on,
    );
  }

  private recordSubmit(kind: "obs" | "fact" | "find", id: string | undefined): void {
    if (!id) return;
    if (kind === "obs" && !this.submittedObservations.includes(id)) this.submittedObservations.push(id);
    if (kind === "fact" && !this.submittedFacts.includes(id)) this.submittedFacts.push(id);
    if (kind === "find" && !this.submittedFindings.includes(id)) this.submittedFindings.push(id);
  }

  private buildTools(lease: RunLease, context: ContextPack): AgentTool[] {
    const s = this.deps.storage;
    const tools: AgentTool[] = [
      tool("graph_query", "Query graph. Default order is oldest first; raise offset to page. The context pack already injects the newest observations. Pass order=desc for newest first.", Type.Object({
        entity: Type.String({ description: "facts|steps|goals|findings|coverage|observations" }),
        limit: Type.Optional(Type.Number()),
        offset: Type.Optional(Type.Number()),
        order: Type.Optional(Type.String({ description: "asc (oldest first, default) or desc (newest first)" })),
      }), async (_id, params) => {
        const p = params as { entity: string; limit?: number; offset?: number; order?: string };
        const order = p.order === "desc" ? "desc" : "asc";
        const result = s.graphQuery(lease.campaign_id, { entity: p.entity, limit: p.limit, offset: p.offset, order });
        return ok(result);
      }),
      tool("artifact_read", "Read a byte slice of a saved original. If kali_run set truncated, pass artifact_id and next_offset to get the next chunk.", Type.Object({
        artifact_id: Type.String(),
        offset: Type.Optional(Type.Number()),
        length: Type.Optional(Type.Number()),
      }), async (_id, params) => {
        const p = params as { artifact_id: string; offset?: number; length?: number };
        const row = s.store.db.prepare("SELECT * FROM artifacts WHERE id = ? AND campaign_id = ?").get(p.artifact_id, lease.campaign_id) as
          | { path: string; hash: string; size: number }
          | undefined;
        if (!row) throw new Error("artifact not in campaign");
        const offset = Math.max(0, p.offset ?? 0);
        const want = Math.min(ARTIFACT_SLICE_MAX, Math.max(1, p.length ?? ARTIFACT_SLICE_MAX));
        const buf = await s.artifacts.read(row.path, offset, want);
        return ok(artifactSlicePayload({
          text: buf.toString("utf8"),
          byte_length: buf.length,
          offset,
          total: Number(row.size),
          artifact_id: p.artifact_id,
          hash: row.hash,
        }));
      }),
      tool("checkpoint", "Save checkpoint", Type.Object({
        note: Type.String(),
        next: Type.Optional(Type.String()),
      }), async (_id, params) => {
        const p = params as { note: string; next?: string };
        const saved = s.saveCheckpoint({
          campaign_id: lease.campaign_id,
          run_id: lease.run_id,
          note: p.note,
          next: p.next,
          payload: { mode: this.mode, step_id: lease.step_id },
        });
        return ok({ saved: true, checkpoint_id: saved.id, note: p.note, next: p.next ?? null });
      }),
    ];
    if (this.mode === "decide") {
      tools.push(
        tool("propose_plan", "Submit typed plan. Decide cannot fetch URLs. Use propose_step so Execute can kali_run/playwright. Example: {\"operations\":[{\"op\":\"propose_step\",\"question\":\"GET the challenge homepage and record the HTML\",\"kind\":\"explore\",\"methodFamily\":\"http-probe\"}]}", Type.Object({
          operations: Type.Array(Type.Unknown()),
          no_change_reason: Type.Optional(Type.String()),
        }), async (_id, params) => {
          const p = params as { operations: unknown[]; no_change_reason?: string };
          try {
            const result = s.applyProposalBatch({
              campaign_id: lease.campaign_id,
              producer_id: lease.run_id,
              submission_id: newId("sub"),
              run_id: lease.run_id,
              operations: p.operations,
              no_change_reason: p.no_change_reason,
              read_set: context.manifest.selected_entity_revisions,
            });
            return ok(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: message, allowed_ops: ["propose_step"], hint: "Do not invent HTTP ops. propose_step then finish_decision." }) }],
              details: { error: message },
              isError: true,
            };
          }
        }),
        tool("finish_decision", "Finish decide run", Type.Object({
          summary: Type.String(),
          reviewed_note: Type.Optional(Type.String()),
        }), async (_id, params) => {
          s.markFinishRequested(lease.campaign_id, lease.run_id, lease.fence);
          const p = params as { summary: string };
          this.outcome = this.makeOutcome(lease, "resolved", p.summary, true);
          return { ...ok({ finish: true }), terminate: true };
        }),
      );
    } else {
      tools.push(
        tool("submit_observation", "Submit observation", Type.Object({
          subject: Type.String(),
          body: Type.Unknown(),
          artifact_text: Type.Optional(Type.String()),
          conditions: Type.Optional(Type.Unknown()),
        }), async (_id, params) => {
          const p = params as { subject: string; body: unknown; artifact_text?: string; conditions?: Record<string, unknown> };
          const art = await s.putArtifact(lease.campaign_id, JSON.stringify(p.body), "application/json", lease.run_id);
          const result = s.recordObservation({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            attempt_id: lease.run_id,
            subject: p.subject,
            body: p.body,
            artifact_refs: [art.id],
            conditions: p.conditions ?? {},
            env_rev: String((s.getWorld<LabWorld>(lease.campaign_id, { env_rev: "env-1" } as LabWorld) as LabWorld).env_rev ?? "env-1"),
          });
          this.recordSubmit("obs", result.canonical_ids.observation_id);
          return ok(result);
        }),
        tool("submit_fact", "Submit a fact. A success-predicate fact (e.g. flag_recovered) is only a candidate until a human verifies it.", Type.Object({
          proposition: Type.String(),
          fact_key: Type.Optional(Type.String()),
          support_refs: Type.Array(Type.String()),
          conditions: Type.Optional(Type.Unknown()),
          source_grade: Type.Optional(Type.String()),
        }), async (_id, params) => {
          const p = params as { proposition: string; fact_key?: string; support_refs: string[]; conditions?: Record<string, unknown>; source_grade?: "observed" | "derived" };
          const result = s.submitFact({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            proposition: p.proposition,
            fact_key: p.fact_key,
            support_refs: p.support_refs,
            conditions: p.conditions ?? {},
            source_grade: p.source_grade,
          });
          this.recordSubmit("fact", result.canonical_ids.fact_id);
          return ok(result);
        }),
        tool("submit_finding", "Submit finding candidate", Type.Object({
          claim: Type.String(),
          evidence_refs: Type.Array(Type.String()),
          dedup_key: Type.String(),
          impact: Type.Optional(Type.String()),
          model_confidence: Type.Optional(Type.Number()),
        }), async (_id, params) => {
          const p = params as { claim: string; evidence_refs: string[]; dedup_key: string; impact?: string; model_confidence?: number };
          const result = s.submitFinding({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            claim: p.claim,
            evidence_refs: p.evidence_refs,
            dedup_key: p.dedup_key,
            impact: p.impact,
            model_confidence: p.model_confidence,
          });
          this.recordSubmit("find", result.canonical_ids.finding_id);
          return ok(result);
        }),
        tool("propose_step", "Suggest a step", Type.Object({
          question: Type.String(),
          kind: Type.String(),
          method_family: Type.String(),
          fingerprint: Type.String(),
          preconditions: Type.Optional(Type.Unknown()),
          retry_reason: Type.Optional(Type.String()),
        }), async (_id, params) => {
          const p = params as {
            question: string;
            kind: "explore" | "verify" | "acquire_prerequisite" | "reconcile";
            method_family: string;
            fingerprint: string;
            preconditions?: unknown;
            retry_reason?: string;
          };
          const root = s.store.db.prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1").get(lease.campaign_id) as { id: string };
          const result = s.proposeStepDirect({
            campaign_id: lease.campaign_id,
            producer_id: lease.run_id,
            submission_id: newId("sub"),
            run_id: lease.run_id,
            question: p.question,
            kind: p.kind,
            goal_refs: [root.id],
            preconditions: (p.preconditions as never) ?? { op: "all", of: [] },
            method_family: p.method_family,
            expected_observations: [],
            completion_criteria: "observe",
            fingerprint: p.fingerprint,
            reopen_rule: { kind: "never" },
            retry_reason: p.retry_reason,
          });
          return ok(result);
        }),
        tool("world_inspect", "Inspect synthetic world", Type.Object({
          target: Type.String(),
        }), async (_id, params) => {
          const world = s.getWorld<LabWorld>(lease.campaign_id, { env_rev: "env-1" } as LabWorld);
          const result = inspectWorld(world, (params as { target: string }).target);
          s.saveWorld(lease.campaign_id, result.world);
          return ok({ observation: result.observation, subject: result.subject });
        }),
        tool("world_act", "Act in synthetic world", Type.Object({
          action: Type.String(),
          arg: Type.Optional(Type.String()),
        }), async (_id, params) => {
          const world = s.getWorld<LabWorld>(lease.campaign_id, { env_rev: "env-1" } as LabWorld);
          const p = params as { action: string; arg?: string };
          const result = actWorld(world, p.action, p.arg);
          s.saveWorld(lease.campaign_id, result.world);
          return ok({ observation: result.observation, subject: result.subject, transient: result.transient ?? false });
        }),
        tool("kali_run", KALI_RUN_DESCRIPTION, KALI_RUN_PARAMETERS, async (_id, _params) => {
          return ok(await packKaliExec(s, lease, this.deps.kali?.takeLast(lease.campaign_id), "no_kali_result"));
        }),
        tool("kali_write", KALI_WRITE_DESCRIPTION, KALI_WRITE_PARAMETERS, async (_id, _params) => {
          return ok(await packKaliExec(s, lease, this.deps.kali?.takeLast(lease.campaign_id), "no_kali_write_result"));
        }),
        tool("playwright", PLAYWRIGHT_DESCRIPTION, PLAYWRIGHT_PARAMETERS, async (_id, _params) => {
          return ok(await packKaliExec(s, lease, this.deps.kali?.takeLast(lease.campaign_id), "no_playwright_result"));
        }),
        this.finishStepTool(lease, "primary"),
      );
    }
    const camp = s.getCampaign(lease.campaign_id);
    if (this.mode === "execute") {
      const drop = isKaliProfile(camp.spec.execution_profile)
        ? new Set(["world_inspect", "world_act"])
        : new Set(["kali_run", "kali_write", "playwright", "browser_fetch"]);
      for (let i = tools.length - 1; i >= 0; i--) {
        if (drop.has(tools[i]!.name)) tools.splice(i, 1);
      }
    }
    const allowed = new Set(context.tool_names);
    return tools.filter((t) => allowed.has(t.name));
  }
}

function tool(
  name: string,
  description: string,
  parameters: AgentTool["parameters"],
  execute: AgentTool["execute"],
): AgentTool {
  return { name, label: name, description, parameters, execute };
}

function ok(details: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

async function packKaliExec(
  storage: StorageService,
  lease: RunLease,
  last: { stdout: string; stderr: string; code: number; timedOut: boolean; truncated: boolean; container: string } | undefined,
  empty: string,
): Promise<unknown> {
  if (!last) return { error: empty };
  const stored = await storage.putArtifact(lease.campaign_id, last.stdout ?? "", "text/plain", lease.run_id);
  return decodeExec(last, empty, { id: stored.id, size: stored.size });
}

export function decodeExec(
  result: { stdout: string; stderr: string; code: number; timedOut: boolean; truncated: boolean; container: string } | undefined,
  empty: string,
  art?: { id: string; size: number },
): unknown {
  if (!result) return { error: empty };
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const stdoutBuf = Buffer.from(stdout, "utf8");
  const stderrBuf = Buffer.from(stderr, "utf8");
  const previewCut = stdoutBuf.length > TOOL_STDOUT_PREVIEW;
  const stderrCut = stderrBuf.length > TOOL_STDERR_PREVIEW;
  const truncated = Boolean(result.truncated || previewCut || stderrCut);
  const shownBuf = stdoutBuf.subarray(0, TOOL_STDOUT_PREVIEW);
  const shown = shownBuf.toString("utf8");
  const out: Record<string, unknown> = {
    code: result.code,
    truncated,
    preview_truncated: previewCut,
    output_capped: Boolean(result.truncated),
    container: result.container,
    timedOut: result.timedOut,
    stdout_bytes: stdoutBuf.length,
    shown_bytes: shownBuf.length,
    stderr: stderrBuf.subarray(0, TOOL_STDERR_PREVIEW).toString("utf8"),
    result: shown,
  };
  if (art) {
    out.artifact_id = art.id;
    out.artifact_bytes = art.size;
  }
  if (truncated) {
    const next = previewCut ? shownBuf.length : null;
    out.next_offset = next;
    out.remaining_bytes = Math.max(0, (art?.size ?? stdoutBuf.length) - shownBuf.length);
    if (art && next != null) {
      out.read_next = `artifact_read artifact_id=${art.id} offset=${next} length=${TOOL_STDOUT_PREVIEW}`;
    }
  }
  return out;
}

export function artifactSlicePayload(args: {
  text: string;
  byte_length: number;
  offset: number;
  total: number;
  artifact_id: string;
  hash: string;
}): Record<string, unknown> {
  const more = args.offset + args.byte_length < args.total;
  return {
    text: args.text,
    artifact_id: args.artifact_id,
    hash: args.hash,
    derived: false,
    offset: args.offset,
    length: args.byte_length,
    total: args.total,
    truncated: more,
    next_offset: more ? args.offset + args.byte_length : null,
  };
}

function lastAssistant(messages: unknown[]): { role?: string; stopReason?: string; errorMessage?: string; content?: unknown } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string; content?: unknown };
    if (m.role === "assistant") return m;
  }
  return null;
}

function lastAssistantText(messages: unknown[]): string {
  const m = lastAssistant(messages);
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as { type?: string; text?: string }[])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

function lastToolPreviews(
  messages: unknown[],
  limit: number,
): Array<{ name: string; is_error: boolean; preview: string; artifact_id?: string }> {
  const out: Array<{ name: string; is_error: boolean; preview: string; artifact_id?: string }> = [];
  for (const raw of messages) {
    const m = raw as { role?: string; toolName?: string; isError?: boolean; content?: { type: string; text?: string }[] };
    if (m.role !== "toolResult") continue;
    const text = (m.content ?? []).map((c) => c.text ?? "").join("");
    out.push({
      name: String(m.toolName ?? ""),
      is_error: Boolean(m.isError),
      preview: text.slice(0, 2000),
    });
  }
  return out.slice(-Math.max(1, limit));
}

function isEnvTool(name: string): boolean {
  return (
    name === "world_inspect" ||
    name === "world_act" ||
    name === "bash" ||
    name === "write" ||
    name === "edit" ||
    name === "kali_run" ||
    name === "kali_write" ||
    name === "playwright" ||
    name === "browser_fetch"
  );
}

function baseOutcome(
  lease: RunLease,
  reason: TaskOutcome["reason"],
  summary: string,
  observation_ids: string[],
  fact_ids: string[],
  finding_ids: string[],
  finish_requested: boolean,
  blocked_on?: string,
): TaskOutcome {
  return {
    run_id: lease.run_id,
    step_id: lease.step_id,
    mode: lease.mode,
    reason,
    summary,
    observation_ids,
    fact_ids,
    finding_ids,
    blocked_on: blocked_on ?? null,
    reopen_rule: null,
    finish_requested,
    protocol_error: reason === "protocol_error" || reason === "incomplete_protocol" ? summary : null,
  };
}

