import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildContextPack } from "../../src/context/builder.ts";
import { openEngine, type Engine } from "../../src/controller/engine.ts";
import type { RunLease } from "../../src/domain/types.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { SCHEMA_VERSION } from "../../src/version.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-mview-"));
}

function boot(id: string): Engine {
  const e = openEngine(tmp(), { silent: true, maxCycles: 1 });
  e.createCampaign(loadDemoSpec(id));
  return e;
}

function lease(campaignId: string, mode: "decide" | "execute", stepId: string | null): RunLease {
  return {
    run_id: `run_${mode}_1`,
    campaign_id: campaignId,
    step_id: stepId,
    mode,
    kind: mode === "decide" ? "decide" : "explore",
    attempt_no: 1,
    fence: 1,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "test",
    continuation_of: null,
  };
}

function insertStep(e: Engine, campaignId: string, id: string, status: string, seq: number, question?: string): void {
  e.storage.store.db
    .prepare(
      `INSERT INTO steps(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq,
        branch_id, kind, question, preconditions_json, method_family, completion_criteria, fingerprint,
        reopen_rule_json, status, priority)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      campaignId,
      SCHEMA_VERSION,
      1,
      new Date().toISOString(),
      seq,
      seq,
      "br_main",
      "explore",
      question ?? `question ${id}`,
      '{"op":"all","of":[]}',
      "generic",
      "done",
      `fp-${id}`,
      '{"kind":"always"}',
      status,
      100,
    );
}

function insertFact(
  e: Engine,
  campaignId: string,
  id: string,
  proposition: string,
  opts: { status?: string; validity?: string; grade?: string; seq: number; key?: string; counters?: string[] },
): void {
  e.storage.store.db
    .prepare(
      `INSERT INTO facts(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq,
        proposition, fact_key, epistemic_status, source_grade, validity, support_refs_json, counter_refs_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      campaignId,
      SCHEMA_VERSION,
      1,
      new Date().toISOString(),
      opts.seq,
      opts.seq,
      proposition,
      opts.key ?? null,
      opts.status ?? "accepted",
      opts.grade ?? "observed",
      opts.validity ?? "current",
      "[]",
      JSON.stringify(opts.counters ?? []),
    );
}

test("G01: a ready step is never crowded out by retired history", () => {
  const e = boot("mv-g01");
  try {
    for (let i = 0; i < 40; i++) insertStep(e, "mv-g01", `step_old_${i}`, i % 2 === 0 ? "retired" : "resolved", i);
    insertStep(e, "mv-g01", "step_live", "ready", 999, "the live frontier question");
    const pack = buildContextPack(e.storage, lease("mv-g01", "decide", null));
    const graph = (pack.user_payload as { graph: { steps: { id: string; status: string }[] } }).graph;
    assert.ok(graph.steps.some((s) => s.id === "step_live"), "ready step must be in the view");
    assert.equal(graph.steps.some((s) => s.id === "step_old_0"), false, "retired history stays out");
  } finally {
    e.close();
  }
});

test("G02+G07: newest facts survive and omission counts are honest", () => {
  const e = boot("mv-g02");
  try {
    for (let i = 0; i < 70; i++) insertFact(e, "mv-g02", `fact_${i}`, `old claim ${i}`, { seq: i });
    insertFact(e, "mv-g02", "fact_key", "the decisive new evidence", { seq: 999 });
    const pack = buildContextPack(e.storage, lease("mv-g02", "decide", null));
    const payload = pack.user_payload as {
      graph: { facts: { id: string; claim: string }[] };
      omitted: { kind: string; total: number; included: number; omitted: number }[];
    };
    assert.ok(payload.graph.facts.some((f) => f.id === "fact_key"), "newest fact must be visible");
    const entry = payload.omitted.find((o) => o.kind === "facts");
    assert.ok(entry, "facts omission entry expected");
    assert.equal(entry.total, 71);
    assert.equal(entry.included + entry.omitted, entry.total, "counts must add up");
    assert.ok(entry.omitted > 0);
  } finally {
    e.close();
  }
});

test("G03: facts linked by the current step stay in view even when old", () => {
  const e = boot("mv-g03");
  try {
    // 65 newer facts push the linked one past every recency lane
    insertFact(e, "mv-g03", "fact_anchor", "old but load-bearing precondition evidence", { seq: 1 });
    for (let i = 0; i < 65; i++) insertFact(e, "mv-g03", `f_${i}`, `noise ${i}`, { seq: 100 + i });
    insertStep(e, "mv-g03", "step_cur", "ready", 500);
    e.storage.store.db
      .prepare("UPDATE steps SET input_refs_json = ? WHERE id = ?")
      .run(JSON.stringify(["fact_anchor"]), "step_cur");
    const pack = buildContextPack(e.storage, lease("mv-g03", "execute", "step_cur"));
    const facts = (pack.user_payload as { graph: { facts: { id: string }[] } }).graph.facts;
    assert.ok(facts.some((f) => f.id === "fact_anchor"), "linked fact must survive");
  } finally {
    e.close();
  }
});

test("G04-G06: disputed keeps counter refs, stale is never known, derived stays hypothesis", () => {
  const e = boot("mv-g04");
  try {
    insertFact(e, "mv-g04", "fact_dis", "contested claim", { seq: 1, status: "disputed", counters: ["obs_9"] });
    insertFact(e, "mv-g04", "fact_stale", "was true before the env change", { seq: 2, validity: "stale" });
    insertFact(e, "mv-g04", "fact_der", "inferred from strings output", { seq: 3, status: "proposed", grade: "derived" });
    insertFact(e, "mv-g04", "fact_ok", "observed directly", { seq: 4 });
    const pack = buildContextPack(e.storage, lease("mv-g04", "decide", null));
    const facts = (pack.user_payload as {
      graph: { facts: { id: string; state: string; counter_refs: string[] }[] };
    }).graph.facts;
    const dis = facts.find((f) => f.id === "fact_dis");
    assert.equal(dis?.state, "disputed");
    assert.deepEqual(dis?.counter_refs, ["obs_9"]);
    assert.equal(facts.find((f) => f.id === "fact_stale")?.state, "stale");
    assert.equal(facts.find((f) => f.id === "fact_der")?.state, "hypothesis");
    assert.equal(facts.find((f) => f.id === "fact_ok")?.state, "known");
  } finally {
    e.close();
  }
});

test("G10+G11: graph_query ids reads detail in-campaign and nothing cross-campaign", () => {
  const e = boot("mv-g10");
  const e2 = openEngine(tmp(), { silent: true, maxCycles: 1 });
  try {
    e2.createCampaign(loadDemoSpec("mv-g10b"));
    insertFact(e, "mv-g10", "fact_a", "first", { seq: 1 });
    insertFact(e2, "mv-g10b", "fact_foreign", "other campaign", { seq: 1 });
    const res = e.storage.graphQuery("mv-g10", { entity: "facts", ids: ["fact_a", "fact_foreign"] });
    assert.equal(res.items.length, 1);
    assert.equal((res.items[0] as { id: string }).id, "fact_a");
    // paging still works unchanged
    const page = e.storage.graphQuery("mv-g10", { entity: "facts", limit: 10, order: "desc" });
    assert.ok(page.items.length >= 1);
    // unknown entity still rejected
    assert.throws(() => e.storage.graphQuery("mv-g10", { entity: "events", ids: ["x"] }), /not allowed/);
  } finally {
    e.close();
    e2.close();
  }
});

test("G13: recent results carry summary and next_action from finished runs", () => {
  const e = boot("mv-g13");
  try {
    insertStep(e, "mv-g13", "step_a", "deferred", 1, "try 33");
    e.storage.store.db
      .prepare(
        `INSERT INTO task_runs(id, campaign_id, step_id, mode, kind, attempt_no, lease_owner, fence, deadline_ms, state, end_reason, outcome_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "run_a1",
        "mv-g13",
        "step_a",
        "execute",
        "explore",
        2,
        "t",
        1,
        Date.now(),
        "finished",
        "deferred",
        JSON.stringify({ run_id: "run_a1", step_id: "step_a", mode: "execute", reason: "deferred", summary: "33 未命中", observation_ids: [], fact_ids: [], finding_ids: [], blocked_on: null, reopen_rule: null, next_action: "改成 34 再试", finish_requested: true }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    const pack = buildContextPack(e.storage, lease("mv-g13", "execute", "step_a"));
    const payload = pack.user_payload as {
      recent_results: { step_id: string; summary: string; next_action: string; attempt: number }[];
    };
    const rr = payload.recent_results.find((r) => r.step_id === "step_a");
    assert.ok(rr, "recent result expected");
    assert.equal(rr.summary, "33 未命中");
    assert.equal(rr.next_action, "改成 34 再试");
    assert.equal(rr.attempt, 2);
    // and the step itself shows the continuation hint in the overview
    const steps = (payload as unknown as { graph: { steps: { id: string }[] } }).graph.steps;
    assert.ok(steps.some((s) => s.id === "step_a"));
  } finally {
    e.close();
  }
});

test("G08: a fat tool_raw observation cannot push goal, scope or steps out of the pack", () => {
  const e = boot("mv-g08");
  try {
    insertStep(e, "mv-g08", "step_live", "ready", 1, "live question");
    e.storage.store.db
      .prepare(
        "INSERT INTO observations(id, campaign_id, schema_version, revision, created_at, created_seq, updated_seq, subject, env_rev, collector_version, body_json, observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "obs_fat",
        "mv-g08",
        SCHEMA_VERSION,
        1,
        new Date().toISOString(),
        1,
        1,
        "tool_raw",
        "env-1",
        "test",
        "x".repeat(300_000),
        new Date().toISOString(),
      );
    const pack = buildContextPack(e.storage, lease("mv-g08", "decide", null));
    const payload = pack.user_payload as {
      goal: { statement: string };
      scope: { assets: string[] };
      graph: { steps: { id: string }[]; observations: { body_json: string }[] };
    };
    assert.ok(payload.goal.statement.length > 0, "goal survives");
    assert.ok(payload.graph.steps.some((s) => s.id === "step_live"), "active step survives");
    const fat = payload.graph.observations.find((o) => o.body_json.includes("truncated"));
    assert.ok(fat, "fat observation is truncated with a pointer");
    assert.ok(JSON.stringify(payload).length <= 400_000);
  } finally {
    e.close();
  }
});

test("model payload hides control fields; resources are scalars", () => {
  const e = boot("mv-hide");
  try {
    const pack = buildContextPack(e.storage, lease("mv-hide", "decide", null));
    const payload = pack.user_payload as Record<string, unknown>;
    assert.equal("fence" in payload, false);
    assert.equal("cancel_epoch" in payload, false);
    assert.equal("policy_version" in payload, false);
    assert.equal("scope_version" in payload, false);
    assert.equal("goal_version" in payload, false);
    const resources = payload.resources as { remaining_calls: unknown; remaining_tokens: unknown };
    assert.equal(typeof resources.remaining_calls === "number" || resources.remaining_calls === null, true);
    // the manifest still carries the real snapshot for internal use
    assert.equal(typeof pack.manifest.graph_snapshot_seq, "number");
  } finally {
    e.close();
  }
});
