import { randomUUID } from "node:crypto";
import { Engine } from "../controller/engine.ts";
import { makeRuntimeConfig } from "../contracts/config.ts";
import { conflict } from "../domain/errors.ts";

export interface RunEntry {
  campaignId: string;
  instanceId: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  promise: Promise<void>;
}

/**
 * Owns the ui process's engines. One control engine serves queries and
 * control-plane writes (pause / hint / verify ...). Every running campaign
 * gets a dedicated Engine — same shape as a CLI `start` process: its own
 * instance id, provider stream and liveSessionId, so concurrent campaigns do
 * not cross-label provider sessions. Campaign engines are closed when the
 * run settles; the controller lock row is what protects against a second
 * process (CLI or ui) starting the same campaign.
 */
export class EngineHost {
  readonly control: Engine;
  private readonly runs = new Map<string, RunEntry>();

  constructor(
    readonly dataDir: string,
    private readonly options: { maxCycles?: number } = {},
  ) {
    this.control = new Engine(makeRuntimeConfig(dataDir, `ui-${randomUUID().slice(0, 8)}`), {
      maxCycles: options.maxCycles ?? 1000,
      silent: true,
    });
  }

  running(campaignId: string): RunEntry | undefined {
    return this.runs.get(campaignId);
  }

  runningIds(): string[] {
    return [...this.runs.keys()];
  }

  start(campaignId: string): RunEntry {
    if (this.runs.has(campaignId)) {
      throw conflict("already_running", `campaign ${campaignId} already has a runner in this ui process`);
    }
    // Existence check first so a typo surfaces as 404-ish invalid input, not a lock row.
    this.control.storage.getCampaign(campaignId);
    this.assertNoLiveController(campaignId);
    const instanceId = `ui-run-${randomUUID().slice(0, 8)}`;
    const engine = new Engine(makeRuntimeConfig(this.dataDir, instanceId), {
      maxCycles: this.options.maxCycles ?? 1000,
      silent: true,
    });
    const entry: RunEntry = {
      campaignId,
      instanceId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      promise: Promise.resolve(),
    };
    entry.promise = engine
      .start(campaignId)
      .catch((err) => {
        entry.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        entry.finishedAt = new Date().toISOString();
        engine.close();
        // Keep the finished entry addressable until something reads it, then
        // the next start() replaces it. Runs map only tracks live runs.
        this.runs.delete(campaignId);
      });
    this.runs.set(campaignId, entry);
    return entry;
  }

  private closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.control.close();
    } catch {
      // Store.close throws when already closed; close() must stay idempotent.
    }
  }

  /**
   * Read-only pre-flight of the controller lock so the HTTP caller gets a
   * synchronous 409 instead of an async runner death. Mirrors the stale
   * rules in StorageService.acquireControllerLock; the runner's own acquire
   * still does the authoritative take-over.
   */
  private assertNoLiveController(campaignId: string): void {
    const row = this.control.storage.store.db
      .prepare("SELECT owner, lease_until, heartbeat_at FROM controller_locks WHERE campaign_id = ?")
      .get(campaignId) as { owner: string; lease_until: number | null; heartbeat_at: string | null } | undefined;
    if (!row) return;
    const now = Date.now();
    const leaseMs = this.control.config.lease_ttl_ms;
    const expired = row.lease_until != null && Number(row.lease_until) < now;
    const heartbeatMs = row.heartbeat_at ? Date.parse(row.heartbeat_at) : 0;
    const staleHeartbeat = heartbeatMs > 0 && now - heartbeatMs > leaseMs;
    if (!expired && !staleHeartbeat) {
      throw conflict("controller_lock_held", `another controller owns this campaign: ${row.owner}`, {
        owner: row.owner,
      });
    }
  }
}
