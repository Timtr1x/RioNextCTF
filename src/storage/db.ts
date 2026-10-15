import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.ts";

export const DURABILITY_NOTES = {
  journal_mode: "WAL",
  synchronous: "NORMAL",
  assumption:
    "WAL + synchronous=NORMAL is durable across process crash on a functioning local volume; it is not a power-loss guarantee on all hardware. Do not copy the main DB file alone as a backup while WAL exists.",
};

export const LATEST_SCHEMA_VERSION = 6;

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  private txDepth = 0;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.path = path;
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  migrate(): void {
    this.db.exec(SCHEMA_SQL);
    let v = this.schemaVersion();
    if (v > LATEST_SCHEMA_VERSION) {
      // A newer binary wrote this database. Writing through the old paths
      // would skip fences and recovery semantics the data now relies on.
      throw new Error(`schema_too_new: database is v${v}, this binary understands up to v${LATEST_SCHEMA_VERSION}`);
    }
    if (v === 0) {
      // Fresh database: SCHEMA_SQL already has the full current shape, so the
      // first open records the latest version — no second-start catch-up.
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(LATEST_SCHEMA_VERSION, nowIso());
      return;
    }
    if (v < 2) {
      this.addColumn("controller_locks", "heartbeat_at", "TEXT");
      this.addColumn("controller_locks", "lease_until", "INTEGER");
      this.addColumn("controller_locks", "generation", "INTEGER NOT NULL DEFAULT 1");
      this.addColumn("steps", "last_served_at", "TEXT");
      this.db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        run_id TEXT,
        note TEXT NOT NULL,
        next TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
      )`);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, nowIso());
    }
    v = this.schemaVersion();
    if (v < 3) {
      this.migrateToV3();
    }
    v = this.schemaVersion();
    if (v < 4) {
      this.migrateToV4();
    }
    v = this.schemaVersion();
    if (v < 5) {
      this.migrateToV5();
    }
    v = this.schemaVersion();
    if (v < 6) {
      this.migrateToV6();
    }
  }

  private migrateToV3(): void {
    this.addColumn("task_runs", "finish_submission_id", "TEXT");
    this.addColumn("task_runs", "finish_payload_json", "TEXT");
    this.addColumn("task_runs", "finish_submitted_at", "TEXT");
    this.addColumn("task_runs", "primary_stop_trigger", "TEXT");
    this.addColumn("task_runs", "finalize_attempted", "INTEGER NOT NULL DEFAULT 0");
    this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(3, nowIso());
  }

  private migrateToV4(): void {
    this.addColumn("campaigns", "execute_run_id", "TEXT");
    this.addColumn("steps", "active_run_id", "TEXT");
    this.addColumn("steps", "next_action", "TEXT");
    this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(4, nowIso());
  }

  /** Why the run stopped, verbatim (e.g. "http_500", a network error, a
   *  timeout). Without it a dead run is only diagnosable by inference. */
  private migrateToV5(): void {
    this.addColumn("task_runs", "last_error", "TEXT");
    this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(5, nowIso());
  }

  /** Lease fencing and pre-send execution identity (H03/H04). Nullable so
   *  pre-v6 rows stay valid historical data without a backfill. */
  private migrateToV6(): void {
    this.addColumn("task_runs", "controller_generation", "INTEGER");
    this.addColumn("invocations", "execution_handle", "TEXT");
    this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(6, nowIso());
  }

  private addColumn(table: string, name: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === name)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as
      | { version: number }
      | undefined;
    return row?.version ?? 0;
  }

  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    if (depth === 0) this.db.exec("BEGIN IMMEDIATE");
    else this.db.exec(`SAVEPOINT sp${depth}`);
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      if (depth === 0) this.db.exec("COMMIT");
      else this.db.exec(`RELEASE sp${depth}`);
      return result;
    } catch (err) {
      this.txDepth -= 1;
      try {
        if (depth === 0) this.db.exec("ROLLBACK");
        else this.db.exec(`ROLLBACK TO sp${depth}`);
      } catch {
        // ignore
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function asJson(value: unknown): string {
  return JSON.stringify(value);
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  return JSON.parse(text) as T;
}
