/**
 * Campaign runner abstraction for the contest supervisor. The supervisor only
 * knows the RunnerFactory/CampaignHandle interfaces, so the whole slot machine
 * is testable with fakes; EngineRunnerFactory is the real implementation on top
 * of per-campaign Engine instances (the same shape EngineHost uses for the UI).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine, openEngine } from "../controller/engine.ts";
import { invalidInput } from "../domain/errors.ts";
import { seedChallengeStep, specFromInput, specFromUrl, type LoadedRun } from "../cli/run-spec.ts";
import { fetchAttachment } from "../domain/attachment-fetch.ts";
import type { ContestQuestion, FetchLike } from "./api.ts";
import { campaignIdFor, planFor, type LaunchPlan } from "./plan.ts";

export interface CampaignHandle {
  readonly campaignId: string;
  /** Runs Decide/Execute until a halt state (awaiting_verify/completed/...). */
  start(): Promise<void>;
  state(): string;
  /** Proposition of the pending flag_recovered claim, when halted for verify. */
  pendingFlag(): string | null;
  recentHints(): string[];
  accept(): void;
  /** Reject the pending claim (dispute + anti-resubmit hint + back to active). */
  reject(text: string): void;
  hint(text: string): void;
  pause(): void;
  cancel(): void;
  /** Reclaim runtime resources after a terminal verdict. Shared-container mode
   *  cleans only this campaign's workspace dir; classic mode kills the container. */
  killKali(): void;
  /** Platform moved the endpoint: rewrite scope assets/entries and tell the model. */
  updateConnection(assets: string[], entries: string[], note: string): void;
  close(): void;
}

export interface PreparedCampaign {
  campaignId: string;
  created: boolean;
}

export interface RunnerControl {
  cancel(campaignId: string): void;
  /** Cancel every non-terminal campaign; returns the cancelled ids. */
  cancelAll(): string[];
}

export interface RunnerFactory {
  prepare(q: ContestQuestion): Promise<PreparedCampaign>;
  open(campaignId: string): CampaignHandle;
  control(): RunnerControl;
  dispose(): void;
}

export interface EngineRunnerOptions {
  maxCycles?: number;
  /** Shared-container mode: all campaigns exec into this one container. */
  shared?: { name: string; mountHost: string };
  fetchFn?: FetchLike;
  downloadTimeoutMs?: number;
  onLog?: (line: string) => void;
}

function campaignExists(engine: Engine, id: string): boolean {
  try {
    engine.storage.getCampaign(id);
    return true;
  } catch {
    return false;
  }
}

function briefFor(q: ContestQuestion): string {
  const lines = [
    `Title: ${q.title}`,
    `Category: ${q.category}  Score: ${q.real_score ?? q.score ?? "?"}  Solved by: ${q.solved_number ?? "?"}`,
    `Interactive: ${q.interactive}`,
  ];
  if (q.connection) {
    lines.push(
      `Connection: docker_url=${q.connection.docker_url ?? ""} docker_ip=${q.connection.docker_ip ?? ""} docker_port=${q.connection.docker_port ?? ""}`,
    );
  }
  if (q.attributes.length) lines.push(`Attributes: ${q.attributes.join(", ")}`);
  if (q.capabilities.length) lines.push(`Capabilities: ${q.capabilities.join(", ")}`);
  lines.push("", "Description:", q.description.slice(0, 4000));
  return lines.join("\n") + "\n";
}

class EngineCampaignHandle implements CampaignHandle {
  constructor(
    private readonly engine: Engine,
    readonly campaignId: string,
    private readonly contestDir: string,
    private readonly shared: boolean,
  ) {}

  start(): Promise<void> {
    return this.engine.start(this.campaignId);
  }

  state(): string {
    return this.engine.storage.getCampaign(this.campaignId).state;
  }

  pendingFlag(): string | null {
    return this.engine.storage.pendingGoalClaim(this.campaignId)?.proposition ?? null;
  }

  recentHints(): string[] {
    return this.engine.storage.listHints(this.campaignId, 8).map((h) => h.text);
  }

  accept(): void {
    this.engine.verifyGoal(this.campaignId, { accept: true });
  }

  reject(text: string): void {
    this.engine.storage.rejectGoalClaim(this.campaignId, text, { kind: "controller", id: "contest" });
  }

  hint(text: string): void {
    this.engine.storage.persistHint(this.campaignId, text, { kind: "controller", id: "contest" });
  }

  pause(): void {
    this.engine.pause(this.campaignId);
  }

  cancel(): void {
    this.engine.cancel(this.campaignId);
  }

  killKali(): void {
    if (this.shared) {
      rmSync(join(this.contestDir, "workspace", this.campaignId), { recursive: true, force: true });
      return;
    }
    this.engine.kali.kill(this.campaignId);
  }

  updateConnection(assets: string[], entries: string[], note: string): void {
    const camp = this.engine.storage.getCampaign(this.campaignId);
    const spec = camp.spec;
    spec.scope = { ...spec.scope, assets, entries };
    spec.scope_version = `s-contest-${Date.now()}`;
    this.engine.storage.store.db
      .prepare("UPDATE campaigns SET spec_json = ?, epoch = epoch + 1, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(spec), new Date().toISOString(), this.campaignId);
    this.hint(note);
    // Classic mode bakes the egress allowlist at container start; recreate.
    if (!this.shared) this.engine.kali.kill(this.campaignId);
  }

  close(): void {
    try {
      this.engine.close();
    } catch {
      // close is idempotent-guarded; a second close may throw on the Store
    }
  }
}

export class EngineRunnerFactory implements RunnerFactory {
  private controlEngine: Engine | null = null;

  constructor(
    readonly contestDir: string,
    private readonly opts: EngineRunnerOptions = {},
  ) {}

  private log(line: string): void {
    this.opts.onLog?.(line);
  }

  private controlEngineGet(): Engine {
    if (!this.controlEngine) {
      this.controlEngine = openEngine(this.contestDir, { silent: true, maxCycles: this.opts.maxCycles ?? 1000 });
    }
    return this.controlEngine;
  }

  async prepare(q: ContestQuestion): Promise<PreparedCampaign> {
    const plan = planFor(q);
    if (plan.type === "blocked") throw invalidInput("contest_unlaunchable", plan.reason);
    const id = campaignIdFor(q);
    const engine = this.controlEngineGet();
    mkdirSync(join(this.contestDir, "workspace", id), { recursive: true });
    if (campaignExists(engine, id)) return { campaignId: id, created: false };
    let loaded: LoadedRun;
    if (plan.type === "url") {
      loaded = { spec: specFromUrl(plan.url, this.contestDir, id) };
    } else {
      const inputDir = await this.stageQuestionInput(q, plan);
      loaded = specFromInput(
        {
          kind: "input",
          path: inputDir,
          challengeKind: plan.kind,
          endpoint: plan.endpoint ?? undefined,
          hint: q.description.slice(0, 2000) || q.title,
        },
        this.contestDir,
        id,
        { containerRoot: this.opts.shared ? `/workspace/${id}` : undefined },
      );
    }
    engine.createCampaign(loaded.spec);
    if (loaded.seed) seedChallengeStep(engine.storage, id, loaded.seed);
    this.log(`campaign prepared: ${id} (${plan.type === "url" ? plan.url : "attachment input"})`);
    return { campaignId: id, created: true };
  }

  open(campaignId: string): CampaignHandle {
    mkdirSync(join(this.contestDir, "workspace", campaignId), { recursive: true });
    const engine = openEngine(this.contestDir, {
      silent: true,
      maxCycles: this.opts.maxCycles ?? 1000,
      kaliShared: this.opts.shared,
    });
    return new EngineCampaignHandle(engine, campaignId, this.contestDir, Boolean(this.opts.shared));
  }

  control(): RunnerControl {
    const engine = this.controlEngineGet();
    return {
      cancel: (id) => {
        try {
          engine.cancel(id);
        } catch (err) {
          this.log(`cancel ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      cancelAll: () => {
        const out: string[] = [];
        for (const c of engine.listCampaigns()) {
          const state = String(c.state ?? "");
          if (state === "completed" || state === "cancelled") continue;
          try {
            engine.cancel(String(c.id));
            out.push(String(c.id));
          } catch {
            // keep cancelling the rest
          }
        }
        return out;
      },
    };
  }

  dispose(): void {
    try {
      this.controlEngine?.close();
    } catch {
      // already closed
    }
    this.controlEngine = null;
  }

  private async stageQuestionInput(q: ContestQuestion, plan: Extract<LaunchPlan, { type: "input" }>): Promise<string> {
    const root = join(this.contestDir, "downloads", campaignIdFor(q));
    const dir = join(root, "input");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "brief.txt"), briefFor(q), "utf8");
    if (plan.fileUrl) await this.download(plan.fileUrl, dir);
    return dir;
  }

  /** Host-side download: the platform token never leaves the supervisor, and
   *  the Kali container never talks to the contest CDN. */
  private async download(url: string, dir: string): Promise<void> {
    const got = await fetchAttachment(url, dir, {
      fetchFn: this.opts.fetchFn,
      timeoutMs: this.opts.downloadTimeoutMs ?? 120_000,
    });
    this.log(`downloaded attachment ${got.name} (${got.bytes}b)`);
  }
}
