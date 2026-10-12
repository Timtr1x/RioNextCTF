import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EffectAdapter {
  send(invocationId: string, payload: unknown): { execution_id: string; pending?: boolean };
  /** Async send for worker paths; implementations must not block the loop. */
  sendAsync(invocationId: string, payload: unknown): Promise<{ execution_id: string; pending?: boolean }>;
  query(executionId: string): "unknown" | "completed" | "failed";
  sendCount(): number;
}

/** Local file side effect. Survives process kill; tests count sends. */
export class FileEffectAdapter implements EffectAdapter {
  private n = 0;

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.n = this.loadCount();
  }

  send(invocationId: string, payload: unknown): { execution_id: string } {
    this.n += 1;
    const execution_id = `ex_${invocationId}`;
    const rec = { invocationId, payload, execution_id, at: Date.now(), status: "completed" };
    writeFileSync(join(this.root, `${execution_id}.json`), JSON.stringify(rec));
    writeFileSync(join(this.root, "send_count"), String(this.n));
    return { execution_id };
  }

  sendAsync(invocationId: string, payload: unknown): Promise<{ execution_id: string }> {
    return Promise.resolve(this.send(invocationId, payload));
  }

  query(executionId: string): "unknown" | "completed" | "failed" {
    try {
      const rec = JSON.parse(readFileSync(join(this.root, `${executionId}.json`), "utf8")) as { status?: string };
      if (rec.status === "failed") return "failed";
      if (rec.status === "completed") return "completed";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  sendCount(): number {
    return this.loadCount();
  }

  private loadCount(): number {
    try {
      return Number(readFileSync(join(this.root, "send_count"), "utf8")) || 0;
    } catch {
      return 0;
    }
  }
}
