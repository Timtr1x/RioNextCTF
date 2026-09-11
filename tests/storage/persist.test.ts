import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainError } from "../../src/domain/errors.ts";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { ArtifactStore } from "../../src/storage/artifacts.ts";
import { Store } from "../../src/storage/db.ts";
import { StorageService } from "../../src/storage/service.ts";
import { buildContextPack } from "../../src/context/builder.ts";

function open(dir: string): Engine {
  return new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
}

test("create does not start work", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const engine = open(dir);
  const spec = loadDemoSpec("camp_create_only");
  const rec = engine.createCampaign(spec);
  assert.equal(rec.state, "created");
  const runs = engine.storage.list("task_runs", rec.id);
  assert.equal(runs.length, 0);
  engine.close();
});

test("T08/T09 idempotent submit and conflict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const store = new Store(join(dir, "db.sqlite"));
  const artifacts = new ArtifactStore(join(dir, "art"));
  const svc = new StorageService(store, artifacts);
  const engine = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 2 });
  const spec = loadDemoSpec("camp_idem");
  engine.createCampaign(spec);
  const run = engine.storage.claimDecide(spec.campaign_id, "t");
  assert.ok(run);
  const payload = {
    campaign_id: spec.campaign_id,
    producer_id: "p1",
    submission_id: "sub-1",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "desk",
    body: { ok: true },
    artifact_refs: [] as string[],
    conditions: {},
    env_rev: "env-1",
  };
  const a = engine.storage.recordObservation(payload);
  const b = engine.storage.recordObservation(payload);
  const c = engine.storage.recordObservation(payload);
  assert.equal(a.canonical_ids.observation_id, b.canonical_ids.observation_id);
  assert.equal(b.canonical_ids.observation_id, c.canonical_ids.observation_id);
  assert.equal(b.status, "replayed");
  const obs = engine.storage.list("observations", spec.campaign_id);
  assert.equal(obs.length, 1);
  assert.throws(
    () => engine.storage.recordObservation({ ...payload, body: { ok: false } }),
    (e: unknown) => e instanceof DomainError && e.code === "submission_conflict",
  );
  engine.close();
  svc.close();
});

test("T10 cross-campaign fact ref is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const engine = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const a = loadDemoSpec("camp_a");
  const b = loadDemoSpec("camp_b");
  engine.createCampaign(a);
  engine.createCampaign(b);
  const runA = engine.storage.claimDecide(a.campaign_id, "t");
  const runB = engine.storage.claimDecide(b.campaign_id, "t");
  assert.ok(runA && runB);
  const art = { campaign_id: a.campaign_id, producer_id: "p", submission_id: "o1", run_id: runA.run_id, attempt_id: runA.run_id, subject: "x", body: {}, artifact_refs: [] as string[], conditions: {}, env_rev: "e" };
  const obs = engine.storage.recordObservation(art);
  engine.storage.submitFact({
    campaign_id: a.campaign_id,
    producer_id: "p",
    submission_id: "f1",
    run_id: runA.run_id,
    proposition: "p",
    fact_key: "k",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
  });
  const fact = engine.storage.list("facts", a.campaign_id)[0]!;
  assert.throws(
    () =>
      engine.storage.proposeStepDirect({
        campaign_id: b.campaign_id,
        producer_id: "p",
        submission_id: "s1",
        run_id: runB.run_id,
        question: "use foreign fact",
        kind: "explore",
        goal_refs: [String(engine.storage.list("goals", b.campaign_id)[0]!.id)],
        preconditions: { op: "atom", fact_id: String(fact.id) },
        method_family: "x",
        expected_observations: [],
        completion_criteria: "x",
        fingerprint: "ffff",
        reopen_rule: { kind: "never" },
        input_refs: [{ id: String(fact.id), revision: 1 }],
      }),
    (e: unknown) => e instanceof DomainError && e.code === "cross_campaign_ref",
  );
  engine.close();
});

test("T22 crash reload keeps committed graph", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const spec = loadDemoSpec("camp_crash");
  const e1 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  e1.createCampaign(spec);
  const run = e1.storage.claimDecide(spec.campaign_id, "t")!;
  const obs = e1.storage.recordObservation({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "o1",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "desk",
    body: { v: 1 },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  const step = e1.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "st1",
    run_id: run.run_id,
    question: "inspect desk and note",
    kind: "explore",
    goal_refs: [String(e1.storage.list("goals", spec.campaign_id)[0]!.id)],
    preconditions: { op: "all", of: [] },
    method_family: "inspect-desk",
    expected_observations: ["desk"],
    completion_criteria: "seen",
    fingerprint: "desk1",
    reopen_rule: { kind: "never" },
  });
  const obsId = obs.canonical_ids.observation_id;
  const stepId = step.canonical_ids.step_id;
  const seq = e1.storage.getCampaign(spec.campaign_id).event_head;
  e1.close();
  const e2 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const obs2 = e2.storage.list("observations", spec.campaign_id);
  const steps = e2.storage.list("steps", spec.campaign_id);
  assert.equal(obs2[0]!.id, obsId);
  assert.equal(steps[0]!.id, stepId);
  assert.equal(e2.storage.getCampaign(spec.campaign_id).event_head, seq);
  e2.close();
});

test("context pack observations are newest first; graph_query defaults to oldest", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-"));
  const e = open(dir);
  const spec = loadDemoSpec("camp_obs_order");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  for (let i = 0; i < 25; i++) {
    e.storage.recordObservation({
      campaign_id: spec.campaign_id,
      producer_id: "p",
      submission_id: `obs-${i}`,
      run_id: run.run_id,
      attempt_id: run.run_id,
      subject: `obs-${String(i).padStart(2, "0")}`,
      body: { i },
      artifact_refs: [],
      conditions: {},
      env_rev: "env-1",
    });
  }
  const oldest = e.storage.graphQuery(spec.campaign_id, { entity: "observations", limit: 20 });
  const newest = e.storage.graphQuery(spec.campaign_id, { entity: "observations", limit: 20, order: "desc" });
  assert.equal((oldest.items[0] as { subject: string }).subject, "obs-00");
  assert.equal((newest.items[0] as { subject: string }).subject, "obs-24");
  const pack = buildContextPack(e.storage, {
    run_id: run.run_id,
    campaign_id: spec.campaign_id,
    step_id: null,
    mode: "decide",
    kind: "decide",
    attempt_no: 1,
    fence: run.fence,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 1000,
    lease_owner: "t",
    continuation_of: null,
  });
  const packed = JSON.stringify(pack.user_payload);
  assert.match(packed, /obs-24/);
  assert.match(packed, /obs-05/);
  assert.equal(packed.includes("obs-00"), false);
  e.close();
});

test("F21 persist payload then crash recovers the same outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-f21-"));
  const spec = loadDemoSpec("f21");
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const childJs = join(process.cwd(), "dist/tests/fault/child-finish-payload.js");
  const childTs = join(process.cwd(), "tests/fault/child-finish-payload.ts");
  const r = spawnSync(
    process.execPath,
    existsSync(childJs) ? [childJs, dir, specPath] : ["--experimental-strip-types", childTs, dir, specPath],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const runId = /RUN (\S+)/.exec(r.stdout)?.[1];
  assert.ok(runId);
  const e = open(dir);
  e.storage.recoverStaleRuns(spec.campaign_id);
  const run = e.storage.getRun(runId);
  assert.equal(run.state, "finished");
  assert.equal(run.end_reason, "resolved");
  const step = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.equal(step.status, "resolved");
  const outcome = JSON.parse(String(run.outcome_json)) as { summary: string };
  assert.equal(outcome.summary, "persisted before finishRun");
  e.close();
});

test("F22 finish_requested without payload recovers incomplete not resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-f22-"));
  const e = open(dir);
  const spec = loadDemoSpec("f22");
  e.createCampaign(spec);
  const decide = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "t",
    submission_id: "s",
    run_id: decide.run_id,
    question: "f22",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "f22",
    expected_observations: ["marker"],
    completion_criteria: "observe",
    fingerprint: "f22-fp",
    reopen_rule: { kind: "always" },
  });
  e.storage.finishRun(spec.campaign_id, decide.run_id, {
    run_id: decide.run_id,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "seed",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  const claimed = e.storage.claimNextStep(spec.campaign_id, "t", 1)!;
  e.storage.markFinishRequested(spec.campaign_id, claimed.run_id, claimed.fence);
  e.storage.recoverStaleRuns(spec.campaign_id);
  const run = e.storage.getRun(claimed.run_id);
  assert.equal(run.end_reason, "incomplete_protocol");
  assert.notEqual(e.storage.list("steps", spec.campaign_id)[0]!.status, "resolved");
  e.close();
});

test("F23 repeat recovery does not duplicate events or step revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-f23-"));
  const spec = loadDemoSpec("f23");
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const childJs = join(process.cwd(), "dist/tests/fault/child-finish-payload.js");
  const childTs = join(process.cwd(), "tests/fault/child-finish-payload.ts");
  const r = spawnSync(
    process.execPath,
    existsSync(childJs) ? [childJs, dir, specPath] : ["--experimental-strip-types", childTs, dir, specPath],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const e = open(dir);
  e.storage.recoverStaleRuns(spec.campaign_id);
  const n1 = e.storage.list("events", spec.campaign_id).length;
  const rev1 = Number(e.storage.list("steps", spec.campaign_id)[0]!.revision);
  e.storage.recoverStaleRuns(spec.campaign_id);
  const n2 = e.storage.list("events", spec.campaign_id).length;
  const rev2 = Number(e.storage.list("steps", spec.campaign_id)[0]!.revision);
  assert.equal(n2, n1);
  assert.equal(rev2, rev1);
  e.close();
});

test("F24 v2 database opens at schema 4 with rows intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-f24-"));
  const path = join(dir, "rionext.sqlite");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE campaigns (
      id TEXT PRIMARY KEY,
      spec_json TEXT NOT NULL,
      state TEXT NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 0,
      cancel_epoch INTEGER NOT NULL DEFAULT 0,
      event_head INTEGER NOT NULL DEFAULT 0,
      progress_epoch INTEGER NOT NULL DEFAULT 0,
      reviewed_seq INTEGER NOT NULL DEFAULT 0,
      requested_seq INTEGER NOT NULL DEFAULT 0,
      empty_reviews INTEGER NOT NULL DEFAULT 0,
      admission_open INTEGER NOT NULL DEFAULT 1,
      decide_lock_owner TEXT,
      decide_lock_until INTEGER,
      execute_lock_owner TEXT,
      execute_lock_until INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_runs (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      step_id TEXT,
      mode TEXT NOT NULL,
      kind TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      context_manifest_json TEXT,
      lease_owner TEXT NOT NULL,
      fence INTEGER NOT NULL,
      deadline_ms INTEGER NOT NULL,
      state TEXT NOT NULL,
      end_reason TEXT,
      outcome_json TEXT,
      continuation_of TEXT,
      finish_requested INTEGER NOT NULL DEFAULT 0,
      env_admission INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(new Date().toISOString());
  db.prepare(
    "INSERT INTO campaigns(id, spec_json, state, created_at, updated_at) VALUES (?, ?, 'created', ?, ?)",
  ).run("camp_f24", "{}", new Date().toISOString(), new Date().toISOString());
  db.prepare(
    `INSERT INTO task_runs(id, campaign_id, mode, kind, attempt_no, lease_owner, fence, deadline_ms, state, finish_requested, env_admission, created_at, updated_at)
     VALUES ('run_f24', 'camp_f24', 'execute', 'explore', 1, 't', 1, ?, 'running', 0, 1, ?, ?)`,
  ).run(Date.now() + 60_000, new Date().toISOString(), new Date().toISOString());
  db.close();
  const store = new Store(path);
  assert.equal(store.schemaVersion(), 4);
  const camp = store.db.prepare("SELECT id, state FROM campaigns WHERE id = ?").get("camp_f24") as { id: string; state: string };
  assert.equal(camp.id, "camp_f24");
  assert.equal(camp.state, "created");
  const run = store.db.prepare("SELECT id, finish_payload_json, finalize_attempted FROM task_runs WHERE id = ?").get("run_f24") as {
    id: string;
    finish_payload_json: string | null;
    finalize_attempted: number;
  };
  assert.equal(run.id, "run_f24");
  assert.equal(run.finish_payload_json, null);
  assert.equal(Number(run.finalize_attempted), 0);
  store.close();
});

test("F25 identical submission_id replays; different payload cannot overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-f25-"));
  const e = open(dir);
  const spec = loadDemoSpec("f25");
  e.createCampaign(spec);
  const decide = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "t",
    submission_id: "s",
    run_id: decide.run_id,
    question: "f25",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "f25",
    expected_observations: ["marker"],
    completion_criteria: "none",
    fingerprint: "f25-fp",
    reopen_rule: { kind: "always" },
  });
  e.storage.finishRun(spec.campaign_id, decide.run_id, {
    run_id: decide.run_id,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "seed",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  const claimed = e.storage.claimNextStep(spec.campaign_id, "t", 1)!;
  const payload = { disposition: "deferred" as const, summary: "one", next_action: "later", evidence_refs: [] };
  const a = e.storage.submitRunOutcome({
    campaign_id: spec.campaign_id,
    run_id: claimed.run_id,
    fence: claimed.fence,
    submission_id: "same-sub",
    payload,
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    source: "primary",
  });
  const b = e.storage.submitRunOutcome({
    campaign_id: spec.campaign_id,
    run_id: claimed.run_id,
    fence: claimed.fence,
    submission_id: "same-sub",
    payload,
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    source: "primary",
  });
  const c = e.storage.submitRunOutcome({
    campaign_id: spec.campaign_id,
    run_id: claimed.run_id,
    fence: claimed.fence,
    submission_id: "other-sub",
    payload: { disposition: "blocked", summary: "two", blocked_on: "x", evidence_refs: [] },
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    source: "primary",
  });
  assert.equal(a.accepted, true);
  assert.equal(b.accepted, true);
  assert.equal(b.duplicate, true);
  assert.equal(c.conflict, true);
  assert.equal(c.accepted, false);
  const stored = JSON.parse(String(e.storage.getRun(claimed.run_id).finish_payload_json)) as { summary: string };
  assert.equal(stored.summary, "one");
  e.close();
});

test("F36 recovered resolved execute projects coverage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-f36-"));
  const e = open(dir);
  const spec = loadDemoSpec("f36");
  e.createCampaign(spec);
  const decide = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "t",
    submission_id: "s",
    run_id: decide.run_id,
    question: "f36",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "inspect-desk",
    expected_observations: ["desk"],
    completion_criteria: "none",
    fingerprint: "f36-fp",
    reopen_rule: { kind: "always" },
  });
  e.storage.finishRun(spec.campaign_id, decide.run_id, {
    run_id: decide.run_id,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "seed",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  const art = await e.storage.putArtifact(spec.campaign_id, "desk-raw", "text/plain", decide.run_id);
  const obs = e.storage.recordObservation({
    campaign_id: spec.campaign_id,
    producer_id: "t",
    submission_id: "o1",
    run_id: decide.run_id,
    attempt_id: decide.run_id,
    subject: "desk",
    body: { ok: true },
    artifact_refs: [art.id],
    conditions: {},
    env_rev: "env-1",
  });
  const claimed = e.storage.claimNextStep(spec.campaign_id, "t", 1)!;
  const submitted = e.storage.submitRunOutcome({
    campaign_id: spec.campaign_id,
    run_id: claimed.run_id,
    fence: claimed.fence,
    submission_id: "f36-sub",
    payload: {
      disposition: "resolved",
      summary: "seen",
      evidence_refs: [obs.canonical_ids.observation_id!],
    },
    observation_ids: [obs.canonical_ids.observation_id!],
    fact_ids: [],
    finding_ids: [],
    source: "primary",
  });
  assert.equal(submitted.accepted, true);
  e.close();
  const e2 = open(dir);
  e2.storage.recoverStaleRuns(spec.campaign_id);
  const run = e2.storage.getRun(claimed.run_id);
  assert.equal(run.end_reason, "resolved");
  const cov = e2.storage.list("coverage_items", spec.campaign_id).find((c) => c.obligation === "inspect-desk");
  assert.equal(cov?.execution_state, "tested");
  e2.close();
});

test("checkpoint lookup does not return another step's note", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-ckpt-"));
  const e = open(dir);
  const spec = loadDemoSpec("ckpt-iso");
  e.createCampaign(spec);
  const decide = e.storage.claimDecide(spec.campaign_id, "t")!;
  e.storage.saveCheckpoint({
    campaign_id: spec.campaign_id,
    run_id: decide.run_id,
    note: "other-branch",
    next: "foreign",
  });
  const miss = e.storage.latestCheckpoint(spec.campaign_id, { runId: "run_missing", stepId: "step_missing" });
  assert.equal(miss, null);
  const hit = e.storage.latestCheckpoint(spec.campaign_id, { runId: decide.run_id });
  assert.equal(hit?.note, "other-branch");
  e.close();
});


test("heartbeatRun renews a live lease and cannot resurrect a reclaimed run", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-hb-"));
  const e = open(dir);
  try {
    const spec = loadDemoSpec("hb");
    e.createCampaign(spec);
    const run = e.storage.claimDecide(spec.campaign_id, "t")!;
    // A live renewal pushes the deadline out; recoverStaleRuns leaves it alone.
    const later = Date.now() + 120_000;
    e.storage.heartbeatRun(run.run_id, later);
    assert.equal(Number(e.storage.getRun(run.run_id).deadline_ms), later);
    assert.equal(e.storage.recoverStaleRuns(spec.campaign_id), 0);
    // Simulate a crashed worker: the deadline lapses with no renewal.
    e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = 0 WHERE id = ?").run(run.run_id);
    assert.equal(e.storage.recoverStaleRuns(spec.campaign_id), 1);
    assert.equal(e.storage.getRun(run.run_id).state, "lease_expired");
    // A late heartbeat from the dead worker must not steal the lease back.
    const resurrect = Date.now() + 120_000;
    e.storage.heartbeatRun(run.run_id, resurrect);
    assert.notEqual(Number(e.storage.getRun(run.run_id).deadline_ms), resurrect);
    assert.equal(e.storage.getRun(run.run_id).state, "lease_expired");
  } finally {
    e.close();
  }
});

test("run claims use the short run lease, not the controller-lock TTL", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-rl-"));
  const e = open(dir);
  try {
    const spec = loadDemoSpec("rl");
    e.createCampaign(spec);
    const before = Date.now();
    const run = e.storage.claimDecide(spec.campaign_id, "t", e.config.run_lease_ms)!;
    const deadline = Number(e.storage.getRun(run.run_id).deadline_ms);
    assert.ok(deadline - before <= e.config.run_lease_ms + 1000, `deadline too far out: ${deadline - before}`);
    assert.equal(e.config.run_lease_ms, 120_000);
    assert.ok(e.config.run_lease_ms < e.config.lease_ttl_ms);
  } finally {
    e.close();
  }
});
