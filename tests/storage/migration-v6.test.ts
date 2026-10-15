/**
 * D01/D02: schema v6 migration — fresh databases record the latest version on
 * first open, v5 databases upgrade in place, an interrupted migration retries
 * cleanly, and a too-new database is refused.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LATEST_SCHEMA_VERSION, Store } from "../../src/storage/db.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-mig6-"));
}

test("D01: a fresh database opens directly at the latest schema with the v6 columns", () => {
  const path = join(tmp(), "rionext.sqlite");
  const store = new Store(path);
  try {
    assert.equal(store.schemaVersion(), LATEST_SCHEMA_VERSION);
    assert.equal(LATEST_SCHEMA_VERSION, 6);
    const runCols = (store.db.prepare("PRAGMA table_info(task_runs)").all() as { name: string }[]).map((c) => c.name);
    const invCols = (store.db.prepare("PRAGMA table_info(invocations)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(runCols.includes("controller_generation"));
    assert.ok(invCols.includes("execution_handle"));
  } finally {
    store.close();
  }
});

test("D01: a v5 database upgrades to v6 on open", () => {
  const path = join(tmp(), "rionext.sqlite");
  {
    const store = new Store(path);
    // Rewind to v5: drop the v6 columns and the v6 migration row.
    store.db.exec("ALTER TABLE task_runs DROP COLUMN controller_generation");
    store.db.exec("ALTER TABLE invocations DROP COLUMN execution_handle");
    store.db.exec("DELETE FROM schema_migrations WHERE version = 6");
    store.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(5, new Date().toISOString());
    assert.equal(store.schemaVersion(), 5);
    store.close();
  }
  const store = new Store(path);
  try {
    assert.equal(store.schemaVersion(), 6);
    const runCols = (store.db.prepare("PRAGMA table_info(task_runs)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(runCols.includes("controller_generation"), "upgrade re-adds the column");
  } finally {
    store.close();
  }
});

test("D02: an interrupted migration retries without duplicating columns or rows", () => {
  const path = join(tmp(), "rionext.sqlite");
  {
    const store = new Store(path);
    // Simulate a crash between the column adds and the version record.
    store.db.exec("DELETE FROM schema_migrations WHERE version = 6");
    store.close();
  }
  const store = new Store(path);
  try {
    assert.equal(store.schemaVersion(), 6);
    const rows = store.db.prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 6").get() as { c: number };
    assert.equal(Number(rows.c), 1, "the version row is recorded exactly once");
    const runCols = (store.db.prepare("PRAGMA table_info(task_runs)").all() as { name: string }[]).map((c) => c.name);
    assert.equal(runCols.filter((c) => c === "controller_generation").length, 1, "no duplicate column");
  } finally {
    store.close();
  }
});

test("D02: a database newer than this binary is refused", () => {
  const path = join(tmp(), "rionext.sqlite");
  {
    const store = new Store(path);
    store.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(99, new Date().toISOString());
    store.close();
  }
  assert.throws(() => new Store(path), /schema_too_new/);
});

test("D01: migrate is idempotent on an already-current database", () => {
  const path = join(tmp(), "rionext.sqlite");
  const store = new Store(path);
  store.close();
  const again = new Store(path);
  try {
    assert.equal(again.schemaVersion(), 6);
    const rows = again.db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
    assert.ok(Number(rows.c) >= 1);
  } finally {
    again.close();
  }
  void DatabaseSync;
});
