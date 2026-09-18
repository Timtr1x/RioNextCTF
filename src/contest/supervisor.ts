/**
 * Contest supervisor: deterministic process that polls the platform board,
 * fills up to N slots with independent campaigns (one Engine each), submits
 * flags through a serialized rate-limit-aware queue, frees slots on accepted
 * flags, and resumes campaigns after rejected ones. It never asks an LLM which
 * question to pick and never lets the model touch process/docker lifecycle.
 */
import { existsSync, renameSync, writeFileSync } from "node:fs";
import type { ContestApi, ContestQuestion, SubmitVerdict } from "./api.ts";
import type { ManagerAdvice, ManagerInput } from "./manager.ts";
import {
  campaignIdFor,
  connectionKey,
  extractFlag,
  isMockQuestion,
  planFor,
  rankQuestions,
  scopeFor,
  type ContestMode,
} from "./plan.ts";
import type { CampaignHandle, RunnerFactory } from "./runner.ts";
import type { SharedKali } from "./shared-kali.ts";

export type SlotPhase = "starting" | "running" | "submitting" | "done" | "paused" | "stalled";

export interface SlotInfo {
  qid: string;
  title: string;
  category: string;
  campaignId: string;
  phase: SlotPhase;
  attempts: number;
  crashes: number;
  note?: string;
}

interface SlotEntry {
  info: SlotInfo;
  task: Promise<void>;
}

export interface SupervisorOptions {
  dir: string;
  mode: ContestMode;
  slots: number;
  api: ContestApi;
  factory: RunnerFactory;
  manager?: (input: ManagerInput) => Promise<ManagerAdvice | null>;
  sharedKali?: SharedKali;
  /** Wrong-answer submits tolerated per question before pausing it. */
  maxAttempts?: number;
  /** Engine crashes tolerated per question before quarantine. */
  maxCrashes?: number;
  submitIntervalMs?: number;
  rateLimitBackoffMs?: number;
  rateLimitRetries?: number;
  pollBoostMs?: number;
  pollBoostWindowMs?: number;
  pollSteadyMs?: number;
  pollMaxBackoffMs?: number;
  /** Test hook: stop polling after N ticks. */
  maxTicks?: number;
  stateFile?: string;
  stopFile?: string;
  onLog?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function isLivePhase(phase: SlotPhase): boolean {
  return phase === "starting" || phase === "running" || phase === "submitting";
}

export class ContestSupervisor {
  private readonly seen = new Map<string, ContestQuestion>();
  private readonly slots = new Map<string, SlotEntry>();
  private readonly finished = new Map<string, SlotInfo>();
  private readonly quarantined = new Map<string, string>();
  private readonly rejected = new Map<string, Set<string>>();
  private readonly solvedLocal = new Set<string>();
  private readonly prepFailures = new Map<string, number>();
  private readonly loggedBlocked = new Set<string>();
  private readonly externalSolved = new Set<string>();
  /** Questions whose campaign lifecycle already ran once (any terminal phase).
   *  Never re-picked, regardless of what the board keeps showing. */
  private readonly ranOnce = new Set<string>();
  private submitChain: Promise<unknown> = Promise.resolve();
  private lastSubmitAt = 0;
  private stopped = false;
  private ticks = 0;
  private readonly startedAt: string;
  private lastUnionKey: string | null = null;

  constructor(private readonly opts: SupervisorOptions) {
    this.startedAt = new Date().toISOString();
  }

  private log(line: string): void {
    (this.opts.onLog ?? (() => {}))(line);
  }

  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? ((d) => new Promise((r) => setTimeout(r, d))))(ms);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  requestStop(): void {
    this.stopped = true;
  }

  private stopRequested(): boolean {
    return this.stopped || Boolean(this.opts.stopFile && existsSync(this.opts.stopFile));
  }

  snapshot(): {
    active: SlotInfo[];
    finished: SlotInfo[];
    quarantined: Record<string, string>;
    solved: string[];
    seen: number;
  } {
    return {
      active: [...this.slots.values()].map((e) => ({ ...e.info })),
      finished: [...this.finished.values()].map((i) => ({ ...i })),
      quarantined: Object.fromEntries(this.quarantined),
      solved: [...this.solvedLocal],
      seen: this.seen.size,
    };
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.slots.values()].map((e) => e.task));
  }

  async run(): Promise<{ cancelled: string[] }> {
    const t0 = this.now();
    this.log(
      `contest supervisor start mode=${this.opts.mode} slots=${this.opts.slots} dir=${this.opts.dir}` +
        (this.opts.sharedKali ? " shared-kali=on" : ""),
    );
    if (this.opts.sharedKali) this.opts.sharedKali.ensure([]);
    // Publish pid/slots before the first poll: the board can stay "not started"
    // for a long while, and `contest status` must not read that as a dead
    // supervisor just because no successful listQuestions has happened yet.
    this.writeState();
    let errors = 0;
    while (!this.stopRequested()) {
      this.ticks++;
      try {
        const qs = await this.opts.api.listQuestions();
        errors = 0;
        this.ingest(qs);
        this.fill();
        this.refreshSharedAllowlist();
      } catch (err) {
        errors++;
        if (errors <= 3 || errors % 10 === 0) {
          this.log(`poll error #${errors}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Written on every tick, failed polls included, so `updated_at` and
      // `ticks` keep moving while the platform is still closed.
      this.writeState();
      if (this.ticks >= (this.opts.maxTicks ?? Number.POSITIVE_INFINITY)) break;
      await this.sleep(this.pollDelay(errors, this.now() - t0));
    }
    this.stopped = true;
    this.log("contest supervisor stopping; cancelling live campaigns");
    const cancelled = this.opts.factory.control().cancelAll();
    if (cancelled.length) this.log(`cancelled: ${cancelled.join(", ")}`);
    if (this.opts.sharedKali) {
      try {
        this.opts.sharedKali.kill();
        this.log(`shared kali container ${this.opts.sharedKali.name} removed`);
      } catch (err) {
        this.log(`shared kali cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await Promise.race([this.drain(), this.sleep(10_000)]);
    this.writeState();
    return { cancelled };
  }

  private pollDelay(errors: number, elapsedMs: number): number {
    if (errors > 0) return Math.min(2000 * 2 ** (errors - 1), this.opts.pollMaxBackoffMs ?? 30_000);
    if (elapsedMs < (this.opts.pollBoostWindowMs ?? 60_000)) return this.opts.pollBoostMs ?? 3_000;
    return this.opts.pollSteadyMs ?? 15_000;
  }

  /** Update the board snapshot; react to external solves and endpoint moves. */
  private ingest(qs: ContestQuestion[]): void {
    for (const q of qs) {
      const prev = this.seen.get(q.question_id);
      this.seen.set(q.question_id, q);
      const entry = this.slots.get(q.question_id);
      if (q.is_solved && !this.solvedLocal.has(q.question_id)) {
        if (!this.externalSolved.has(q.question_id)) {
          this.externalSolved.add(q.question_id);
          if (entry && isLivePhase(entry.info.phase)) {
            this.log(`${q.question_id} solved externally; cancelling local campaign`);
            this.opts.factory.control().cancel(entry.info.campaignId);
            entry.info.note = "solved externally";
          }
        }
        continue;
      }
      if (entry && prev && isLivePhase(entry.info.phase) && connectionKey(prev) !== connectionKey(q)) {
        this.applyConnectionChange(q, entry.info.campaignId);
      }
    }
  }

  private applyConnectionChange(q: ContestQuestion, campaignId: string): void {
    const { assets, entries } = scopeFor(q);
    const note =
      `Platform moved this challenge's endpoint. New connection: ${connectionKey(q)}. ` +
      `Scope assets updated; use the new entrypoint from now on.`;
    this.log(`${q.question_id} endpoint changed → ${connectionKey(q)}; updating scope`);
    const handle = this.opts.factory.open(campaignId);
    try {
      handle.updateConnection(assets, entries, note);
    } catch (err) {
      this.log(`scope update failed for ${q.question_id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      handle.close();
    }
  }

  private fill(): void {
    const live = [...this.slots.values()].filter((e) => isLivePhase(e.info.phase)).length;
    let free = this.opts.slots - live;
    if (free <= 0) return;
    const candidates = rankQuestions(
      [...this.seen.values()].filter((q) => {
        if (q.is_solved || this.solvedLocal.has(q.question_id)) return false;
        if (this.slots.has(q.question_id) || this.quarantined.has(q.question_id)) return false;
        if (this.ranOnce.has(q.question_id)) return false;
        if (this.opts.mode === "official" && isMockQuestion(q)) return false;
        if (planFor(q).type === "blocked") {
          if (!this.loggedBlocked.has(q.question_id)) {
            this.loggedBlocked.add(q.question_id);
            this.log(`${q.question_id} has no usable entrypoint yet (no url/attachment/endpoint); waiting`);
          }
          return false;
        }
        return true;
      }),
    );
    for (const q of candidates.slice(0, free)) this.startSlot(q);
  }

  private startSlot(q: ContestQuestion): void {
    const info: SlotInfo = {
      qid: q.question_id,
      title: q.title,
      category: q.category,
      campaignId: campaignIdFor(q),
      phase: "starting",
      attempts: 0,
      crashes: 0,
    };
    this.log(`slot start ${q.question_id} "${q.title}" (${q.category}, score ${q.real_score ?? q.score ?? "?"})`);
    const entry: SlotEntry = { info, task: Promise.resolve() };
    entry.task = this.slotTask(q, info);
    this.slots.set(q.question_id, entry);
  }

  private async slotTask(q: ContestQuestion, info: SlotInfo): Promise<void> {
    const qid = q.question_id;
    try {
      try {
        await this.opts.factory.prepare(q);
      } catch (err) {
        const n = (this.prepFailures.get(qid) ?? 0) + 1;
        this.prepFailures.set(qid, n);
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`prepare failed for ${qid} (${n}): ${msg}`);
        info.phase = "stalled";
        info.note = `prepare failed: ${msg.slice(0, 160)}`;
        if (n >= 3) this.quarantined.set(qid, `prepare failed x${n}`);
        return;
      }
      const maxAttempts = this.opts.maxAttempts ?? 3;
      const maxCrashes = this.opts.maxCrashes ?? 3;
      this.ranOnce.add(qid);
      while (!this.stopped) {
        info.phase = "running";
        const handle = this.opts.factory.open(info.campaignId);
        let state: string;
        try {
          await handle.start();
          state = handle.state();
        } catch (err) {
          info.crashes++;
          this.safeClose(handle);
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`engine crash on ${qid} (${info.crashes}/${maxCrashes}): ${msg}`);
          if (info.crashes >= maxCrashes) {
            this.quarantined.set(qid, `engine crashed x${info.crashes}`);
            info.phase = "stalled";
            info.note = "engine crashed";
            return;
          }
          await this.sleep(Math.min(2000 * info.crashes, 10_000));
          continue;
        }

        if (state === "awaiting_verify") {
          info.phase = "submitting";
          const action = await this.handleFlagClaim(q, info, handle, maxAttempts);
          this.safeClose(handle);
          if (action === "done") return;
          if (action === "retry") {
            await this.sleep(this.opts.rateLimitBackoffMs ?? 40_000);
            continue;
          }
          continue;
        }

        if (state === "completed") {
          try {
            handle.killKali();
          } catch {
            // workspace cleanup is best-effort
          }
          this.safeClose(handle);
          this.solvedLocal.add(qid);
          info.phase = "done";
          info.note = "completed";
          return;
        }
        this.safeClose(handle);
        if (state === "cancelled") {
          info.phase = "done";
          info.note = info.note ?? "cancelled";
          return;
        }
        this.quarantined.set(qid, `halted:${state}`);
        info.phase = "stalled";
        info.note = `halted:${state}`;
        this.log(`campaign for ${qid} halted at state ${state}; slot freed`);
        return;
      }
      info.note = info.note ?? "stopped";
    } finally {
      this.slots.delete(qid);
      this.finished.set(qid, info);
    }
  }

  /**
   * One awaiting_verify halt: extract, dedupe, submit, then accept/reject.
   * Returns "continue" (resume engine), "retry" (platform trouble; wait then
   * resubmit the still-pending claim), or "done" (slot terminal).
   */
  private async handleFlagClaim(
    q: ContestQuestion,
    info: SlotInfo,
    handle: CampaignHandle,
    maxAttempts: number,
  ): Promise<"continue" | "retry" | "done"> {
    const qid = q.question_id;
    const proposition = handle.pendingFlag();
    const flag = proposition ? extractFlag(proposition) : null;
    if (!flag) {
      handle.reject(
        "no submittable flag value in this claim (expected a flag{...}-style value or a single bare token). " +
          "Find the actual flag string and submit only it.",
      );
      return "continue";
    }
    let rejectedSet = this.rejected.get(qid);
    if (!rejectedSet) {
      rejectedSet = new Set<string>();
      this.rejected.set(qid, rejectedSet);
    }
    if (rejectedSet.has(flag)) {
      handle.reject(
        "this exact value was already rejected by the contest platform. Do not submit it again; find a different value.",
      );
      return "continue";
    }

    const verdict = await this.submitSerialized(qid, flag);
    if (verdict.kind === "rate_limited" || verdict.kind === "blocked") {
      this.log(`submit for ${qid} ${verdict.kind}: ${verdict.message}; claim left pending, will retry`);
      return "retry";
    }
    if (verdict.kind === "correct") {
      this.log(`flag ACCEPTED for ${qid} — closing campaign, freeing slot`);
      rejectedSet.add(flag);
      try {
        handle.accept();
      } catch (err) {
        this.log(`local accept failed for ${qid}: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.solvedLocal.add(qid);
      try {
        handle.killKali();
      } catch {
        // cleanup is best-effort
      }
      info.phase = "done";
      info.note = "flag accepted";
      return "done";
    }

    // wrong answer
    info.attempts++;
    rejectedSet.add(flag);
    this.log(`flag rejected for ${qid} (attempt ${info.attempts}/${maxAttempts}): ${verdict.message || verdict.raw}`);
    handle.reject(
      `Contest platform judged this flag incorrect (attempt ${info.attempts}/${maxAttempts}). ` +
        `Platform message: ${verdict.message || verdict.raw}.`,
    );
    const advice = await this.safeManager(q, handle, flag, verdict.message || verdict.raw, info.attempts, maxAttempts);
    if (advice) {
      handle.hint(`[manager] ${advice.hint}`);
      for (const v of advice.doNotResubmit) rejectedSet.add(v);
      if (advice.nextAction === "reset_container" && q.interactive) {
        const r = await this.opts.api.resetQuestion(qid).catch((err) => ({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          rateLimited: false,
        }));
        this.log(`container reset for ${qid} (manager advised): ${r.ok ? "ok" : r.message}`);
        if (r.ok) {
          handle.hint("container was reset at the platform; the endpoint may change — re-check connection info.");
        }
      }
    }
    if (info.attempts >= maxAttempts) {
      handle.pause();
      try {
        handle.killKali();
      } catch {
        // cleanup is best-effort
      }
      this.quarantined.set(qid, `wrong flag x${info.attempts}`);
      info.phase = "paused";
      info.note = `wrong flag x${info.attempts}; paused`;
      this.log(`${qid} paused after ${info.attempts} wrong submits; slot freed`);
      return "done";
    }
    return "continue";
  }

  private async safeManager(
    q: ContestQuestion,
    handle: CampaignHandle,
    flag: string,
    platformMessage: string,
    attempt: number,
    maxAttempts: number,
  ): Promise<ManagerAdvice | null> {
    if (!this.opts.manager) return null;
    try {
      return await this.opts.manager({
        question: { id: q.question_id, title: q.title, category: q.category, interactive: q.interactive },
        rejectedFlag: flag,
        platformMessage,
        attempt,
        maxAttempts,
        state: handle.state(),
        connectionSummary: connectionKey(q),
        recentHints: handle.recentHints(),
      });
    } catch {
      return null;
    }
  }

  /** Global serialized submit queue: spacing + platform rate-limit backoff. */
  private submitSerialized(qid: string, flag: string): Promise<SubmitVerdict> {
    const run = async (): Promise<SubmitVerdict> => {
      const gap = this.opts.submitIntervalMs ?? 5_000;
      const wait = gap - (this.now() - this.lastSubmitAt);
      if (wait > 0) await this.sleep(wait);
      let verdict = await this.opts.api.submitFlag(qid, flag);
      this.lastSubmitAt = this.now();
      let retries = this.opts.rateLimitRetries ?? 6;
      while (verdict.kind === "rate_limited" && retries-- > 0 && !this.stopped) {
        this.log(`platform rate-limited a submit; backing off ${this.opts.rateLimitBackoffMs ?? 40_000}ms`);
        await this.sleep(this.opts.rateLimitBackoffMs ?? 40_000);
        verdict = await this.opts.api.submitFlag(qid, flag);
        this.lastSubmitAt = this.now();
      }
      return verdict;
    };
    const p = this.submitChain.then(run, run);
    this.submitChain = p.catch(() => {});
    return p;
  }

  /** Recompute the union of live campaigns' assets and replay egress rules. */
  private refreshSharedAllowlist(): void {
    if (!this.opts.sharedKali) return;
    const assets: string[] = [];
    for (const entry of this.slots.values()) {
      if (!isLivePhase(entry.info.phase)) continue;
      const q = this.seen.get(entry.info.qid);
      if (q) assets.push(...scopeFor(q).assets);
    }
    const key = [...new Set(assets)].sort().join("|");
    if (key === this.lastUnionKey) return;
    this.lastUnionKey = key;
    try {
      this.opts.sharedKali.applyAllowlist(assets);
    } catch (err) {
      this.log(`shared egress replay failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private writeState(): void {
    if (!this.opts.stateFile) return;
    const snap = this.snapshot();
    const state = {
      pid: process.pid,
      mode: this.opts.mode,
      dir: this.opts.dir,
      started_at: this.startedAt,
      updated_at: new Date().toISOString(),
      ticks: this.ticks,
      questions_seen: snap.seen,
      active: snap.active,
      finished: snap.finished.slice(-20),
      quarantined: snap.quarantined,
      solved: snap.solved,
    };
    try {
      const tmp = `${this.opts.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      renameSync(tmp, this.opts.stateFile);
    } catch (err) {
      this.log(`state write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private safeClose(handle: CampaignHandle): void {
    try {
      handle.close();
    } catch {
      // close must never break the slot loop
    }
  }
}
