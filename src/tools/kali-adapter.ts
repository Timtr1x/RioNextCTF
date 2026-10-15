import { DomainError } from "../domain/errors.ts";
import type { EffectAdapter, ExecutionDescriptor, ExecutionEvidence } from "./effect-adapter.ts";
import { isKnownKaliBin, shouldBackgroundKali } from "./kali-profile.ts";
import type { KaliStartOpts, KaliRuntime } from "./kali-runtime.ts";

export interface KaliPayload {
  kind: "kali" | "browser" | "playwright" | "kali_write";
  bin?: string;
  args?: string[];
  url?: string;
  redirects?: string[];
  op?: string;
  path?: string;
  content?: string;
  ref?: string;
  selector?: string;
  text?: string;
  key?: string;
  timeout_ms?: number;
}

export function isKaliPayload(payload: unknown): payload is KaliPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { kind?: unknown; bin?: unknown; url?: unknown; op?: unknown };
  if (p.kind === "kali" || p.kind === "browser" || p.kind === "playwright" || p.kind === "kali_write") return true;
  if (p.op === "write") return true;
  return typeof p.bin === "string" && isKnownKaliBin(p.bin);
}

export class KaliEffectAdapter implements EffectAdapter {
  private n = 0;
  private last = new Map<string, "unknown" | "completed" | "failed">();

  constructor(
    private readonly runtime: KaliRuntime,
    private readonly optsFor: (invocationId: string) => KaliStartOpts,
  ) {}

  send(invocationId: string, payload: unknown): { execution_id: string; pending?: boolean } {
    if (!isKaliPayload(payload)) throw new DomainError("kali_payload", "not a kali payload", "invalid_input");
    this.n += 1;
    const execution_id = `kali_${invocationId}`;
    const opts = this.optsFor(invocationId);
    try {
      const result =
        payload.kind === "playwright" || payload.kind === "browser"
          ? this.runtime.playwright(opts, {
              op: payload.kind === "browser" ? "goto" : String(payload.op ?? "snapshot"),
              url: payload.url,
              ref: payload.ref,
              selector: payload.selector,
              text: payload.text,
              key: payload.key,
              timeout_ms: payload.timeout_ms,
              redirects: payload.redirects,
            })
          : payload.kind === "kali_write" || payload.op === "write"
            ? this.runtime.writeWorkspace(opts, String(payload.path ?? ""), String(payload.content ?? ""))
            : this.runtime.exec(opts, String(payload.bin ?? "nmap"), payload.args ?? [], {
                url: payload.url,
                redirects: payload.redirects,
                timeout_ms: payload.timeout_ms,
                executionId: execution_id,
                background: shouldBackgroundKali(String(payload.bin ?? "nmap"), payload.timeout_ms),
              });
      const pending = Boolean((result as { pending?: boolean }).pending);
      this.last.set(execution_id, pending ? "unknown" : result.code === 0 ? "completed" : "failed");
      (payload as KaliPayload & { _result?: unknown })._result = {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        truncated: result.truncated,
        container: result.container,
        timedOut: result.timedOut,
        pending,
      };
      return { execution_id, pending };
    } catch (err) {
      this.last.set(execution_id, "failed");
      throw err;
    }
  }

  async sendAsync(
    invocationId: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{ execution_id: string; pending?: boolean }> {
    if (!isKaliPayload(payload)) throw new DomainError("kali_payload", "not a kali payload", "invalid_input");
    this.n += 1;
    const execution_id = `kali_${invocationId}`;
    const opts = this.optsFor(invocationId);
    try {
      const result =
        payload.kind === "playwright" || payload.kind === "browser"
          ? await this.runtime.playwrightAsync(
              opts,
              {
                op: payload.kind === "browser" ? "goto" : String(payload.op ?? "snapshot"),
                url: payload.url,
                ref: payload.ref,
                selector: payload.selector,
                text: payload.text,
                key: payload.key,
                timeout_ms: payload.timeout_ms,
                redirects: payload.redirects,
              },
              signal,
            )
          : payload.kind === "kali_write" || payload.op === "write"
            ? await this.runtime.writeWorkspaceAsync(opts, String(payload.path ?? ""), String(payload.content ?? ""), signal)
            : await this.runtime.execAsync(opts, String(payload.bin ?? "nmap"), payload.args ?? [], {
                url: payload.url,
                redirects: payload.redirects,
                timeout_ms: payload.timeout_ms,
                executionId: execution_id,
                background: shouldBackgroundKali(String(payload.bin ?? "nmap"), payload.timeout_ms),
                signal,
              });
      const pending = Boolean((result as { pending?: boolean }).pending);
      this.last.set(execution_id, pending ? "unknown" : result.code === 0 ? "completed" : "failed");
      (payload as KaliPayload & { _result?: unknown })._result = {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        truncated: result.truncated,
        container: result.container,
        timedOut: result.timedOut,
        pending,
      };
      return { execution_id, pending };
    } catch (err) {
      this.last.set(execution_id, "failed");
      throw err;
    }
  }

  describe(invocationId: string): ExecutionDescriptor {
    // The handle is deterministic and pre-persisted in the permit transaction;
    // kali execution is never blindly replayable.
    return { handle: `kali_${invocationId}`, queryable: true, replaySafe: false };
  }

  /** Evidence-grade query (H04 §6.4): a missing container or a missing exit
   *  record is never proof of not_started. */
  async queryEvidence(executionId: string): Promise<ExecutionEvidence> {
    const mem = this.last.get(executionId);
    if (mem === "completed") return { status: "completed", evidenceRef: "memory" };
    if (mem === "failed") return { status: "failed", evidenceRef: "memory", effect: "possible" };
    try {
      const invId = executionId.startsWith("kali_") ? executionId.slice("kali_".length) : "";
      if (invId) {
        const opts = this.optsFor(invId);
        const box = await this.runtime.inspectCampaignAsync(opts.campaignId);
        const bg = await this.runtime.backgroundStatusAsync(opts, executionId);
        const ref = `workspace:.rionext-ops/${executionId}`;
        if (bg === "completed") {
          this.last.set(executionId, "completed");
          return { status: "completed", evidenceRef: ref };
        }
        if (bg === "failed") {
          this.last.set(executionId, "failed");
          // A nonzero exit says the command failed; it says nothing about the
          // effects it produced before failing.
          return { status: "failed", evidenceRef: ref, effect: "possible" };
        }
        if (box === "running") return { status: "running", evidenceRef: ref };
        // container gone or exited, no exit record: the process state is
        // unknowable from here — never downgrade this to not_started.
        return { status: "unknown", reason: `container_${box}_no_exit_record` };
      }
    } catch (err) {
      return { status: "unknown", reason: `query_error:${err instanceof Error ? err.message : String(err)}` };
    }
    return { status: "unknown", reason: "no_record" };
  }

  query(executionId: string): "unknown" | "completed" | "failed" {
    const mem = this.last.get(executionId);
    if (mem === "completed" || mem === "failed") return mem;
    try {
      const invId = executionId.startsWith("kali_") ? executionId.slice("kali_".length) : "";
      if (invId) {
        const opts = this.optsFor(invId);
        const bg = this.runtime.backgroundStatus(opts, executionId);
        if (bg === "completed" || bg === "failed") {
          this.last.set(executionId, bg);
          return bg;
        }
        const box = this.runtime.inspectCampaign(opts.campaignId);
        if (box === "missing" || box === "exited") return "failed";
        return "unknown";
      }
    } catch {
      // invocation missing after restart
    }
    return mem ?? "unknown";
  }

  /** Same as query but without spawnSync on the polling path. */
  async queryAsync(executionId: string): Promise<"unknown" | "completed" | "failed"> {
    const mem = this.last.get(executionId);
    if (mem === "completed" || mem === "failed") return mem;
    try {
      const invId = executionId.startsWith("kali_") ? executionId.slice("kali_".length) : "";
      if (invId) {
        const opts = this.optsFor(invId);
        const bg = await this.runtime.backgroundStatusAsync(opts, executionId);
        if (bg === "completed" || bg === "failed") {
          this.last.set(executionId, bg);
          return bg;
        }
        const box = await this.runtime.inspectCampaignAsync(opts.campaignId);
        if (box === "missing" || box === "exited") return "failed";
        return "unknown";
      }
    } catch {
      // invocation missing after restart
    }
    return mem ?? "unknown";
  }

  sendCount(): number {
    return this.n;
  }

  cancel(campaignId: string): void {
    this.runtime.kill(campaignId);
  }
}

export class RoutingEffectAdapter implements EffectAdapter {
  constructor(
    private readonly file: EffectAdapter,
    private readonly kali: KaliEffectAdapter,
  ) {}

  send(invocationId: string, payload: unknown): { execution_id: string } {
    if (isKaliPayload(payload)) return this.kali.send(invocationId, payload);
    return this.file.send(invocationId, payload);
  }

  sendAsync(invocationId: string, payload: unknown, signal?: AbortSignal): Promise<{ execution_id: string; pending?: boolean }> {
    if (isKaliPayload(payload)) return this.kali.sendAsync(invocationId, payload, signal);
    return this.file.sendAsync(invocationId, payload, signal);
  }

  query(executionId: string): "unknown" | "completed" | "failed" {
    if (executionId.startsWith("kali_")) return this.kali.query(executionId);
    return this.file.query(executionId);
  }

  queryAsync(executionId: string): Promise<"unknown" | "completed" | "failed"> {
    if (executionId.startsWith("kali_")) return this.kali.queryAsync(executionId);
    return Promise.resolve(this.file.query(executionId));
  }

  describe(invocationId: string, payload: unknown): ExecutionDescriptor {
    if (isKaliPayload(payload)) return this.kali.describe(invocationId);
    return this.file.describe ? this.file.describe(invocationId, payload) : { handle: `ex_${invocationId}`, queryable: true, replaySafe: true };
  }

  async queryEvidence(executionId: string): Promise<ExecutionEvidence> {
    if (executionId.startsWith("kali_")) return this.kali.queryEvidence(executionId);
    if (this.file.queryEvidence) return this.file.queryEvidence(executionId);
    const q = this.file.query(executionId);
    return q === "unknown" ? { status: "unknown", reason: "legacy_query" } : { status: q, evidenceRef: "legacy" } as ExecutionEvidence;
  }

  sendCount(): number {
    return this.file.sendCount() + this.kali.sendCount();
  }
}
