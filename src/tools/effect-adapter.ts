import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The pre-send execution identity (H04 §6.3): computed deterministically from
 * the invocation id before anything is sent, persisted in the permit
 * transaction, and queryable afterwards. describe() must be side-effect free.
 */
export interface ExecutionDescriptor {
  handle: string;
  /** The adapter can answer queryEvidence for this handle. */
  queryable: boolean;
  /** True only when the adapter itself dedupes by handle — never model-decided. */
  replaySafe: boolean;
}

/**
 * Query evidence is more precise than completed/failed (H04 §6.4):
 * "failed" means some execution stage failed, not "no effect, no cost";
 * "not_started" needs positive proof; anything unprovable stays unknown.
 */
export type ExecutionEvidence =
  | { status: "running"; evidenceRef: string }
  | { status: "completed"; evidenceRef: string }
  | { status: "failed"; evidenceRef: string; effect: "none" | "possible" }
  | { status: "not_started"; evidenceRef: string }
  | { status: "unknown"; reason: string };

export interface EffectAdapter {
  send(invocationId: string, payload: unknown): { execution_id: string; pending?: boolean };
  /** Async send for worker paths; implementations must not block the loop.
   *  Aborting `signal` kills only this invocation's work. */
  sendAsync(invocationId: string, payload: unknown, signal?: AbortSignal): Promise<{ execution_id: string; pending?: boolean }>;
  query(executionId: string): "unknown" | "completed" | "failed";
  /** Async query for controller polling; falls back to query when absent. */
  queryAsync?(executionId: string): Promise<"unknown" | "completed" | "failed">;
  /** Evidence-grade query; adapters without one fall back to legacy query(). */
  queryEvidence?(executionId: string): Promise<ExecutionEvidence> | ExecutionEvidence;
  /** Deterministic pre-send handle; adapters without one get the default. */
  describe?(invocationId: string, payload: unknown): ExecutionDescriptor;
  sendCount(): number;
}

/** Default handle for adapters that do not override describe(). */
export function defaultDescriptor(invocationId: string): ExecutionDescriptor {
  return { handle: `ex_${invocationId}`, queryable: false, replaySafe: false };
}

/** Local file side effect. Survives process kill; tests count sends.
 *  Sends are idempotent by invocation: a replayed invocation returns its
 *  existing record and never increments the effect count (E13). */
export class FileEffectAdapter implements EffectAdapter {
  private n = 0;

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.n = this.loadCount();
  }

  describe(invocationId: string): ExecutionDescriptor {
    return { handle: `ex_${invocationId}`, queryable: true, replaySafe: true };
  }

  send(invocationId: string, payload: unknown): { execution_id: string } {
    const execution_id = `ex_${invocationId}`;
    const path = join(this.root, `${execution_id}.json`);
    const existing = this.readRecord(path);
    if (existing && existing.invocationId === invocationId) {
      // replay of an already-landed effect: no second count, no second write
      return { execution_id };
    }
    this.n += 1;
    const rec = { invocationId, payload, execution_id, at: Date.now(), status: "completed" };
    writeFileSync(path, JSON.stringify(rec));
    writeFileSync(join(this.root, "send_count"), String(this.n));
    return { execution_id };
  }

  sendAsync(invocationId: string, payload: unknown, _signal?: AbortSignal): Promise<{ execution_id: string }> {
    return Promise.resolve(this.send(invocationId, payload));
  }

  query(executionId: string): "unknown" | "completed" | "failed" {
    const rec = this.readRecord(join(this.root, `${executionId}.json`));
    if (!rec) return "unknown";
    if (rec.status === "failed") return "failed";
    if (rec.status === "completed") return "completed";
    return "unknown";
  }

  queryEvidence(executionId: string): ExecutionEvidence {
    const path = join(this.root, `${executionId}.json`);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      // No record is not positive proof of not_started: the crash window
      // between effect and fsync is real. Stay honest.
      return { status: "unknown", reason: "no_record" };
    }
    try {
      const rec = JSON.parse(raw) as { status?: string };
      if (rec.status === "failed") return { status: "failed", evidenceRef: path, effect: "possible" };
      if (rec.status === "completed") return { status: "completed", evidenceRef: path };
      return { status: "unknown", reason: "record_without_status" };
    } catch {
      return { status: "unknown", reason: "corrupt_record" };
    }
  }

  sendCount(): number {
    return this.loadCount();
  }

  private readRecord(path: string): { invocationId?: string; status?: string } | null {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as { invocationId?: string; status?: string };
    } catch {
      return null;
    }
  }

  private loadCount(): number {
    try {
      return Number(readFileSync(join(this.root, "send_count"), "utf8")) || 0;
    } catch {
      return 0;
    }
  }
}
