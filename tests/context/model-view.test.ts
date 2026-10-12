import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildContextPack } from "../../src/context/builder.ts";
import { projectGraphItems } from "../../src/context/model-view.ts";
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
    // production input_refs are EntityRef objects, not bare strings
    e.storage.store.db
      .prepare("UPDATE steps SET input_refs_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: "fact_anchor", revision: 1 }]), "step_cur");
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

// --- R05: dependency links survive the real formats ---

test("R05-02/03/04: precondition atoms and nesting pull in old facts", () => {
  const e = boot("mv-r05");
  try {
    insertFact(e, "mv-r05", "fact_byid", "linked by fact_id", { seq: 1 });
    insertFact(e, "mv-r05", "fact_bykey", "linked by key", { seq: 2, key: "handshake_done" });
    insertFact(e, "mv-r05", "fact_nested", "linked deep in any/all", { seq: 3 });
    for (let i = 0; i < 65; i++) insertFact(e, "mv-r05", `f_${i}`, `noise ${i}`, { seq: 100 + i });
    insertStep(e, "mv-r05", "step_cur", "ready", 500);
    e.storage.store.db
      .prepare("UPDATE steps SET preconditions_json = ? WHERE id = ?")
      .run(
        JSON.stringify({
          op: "all",
          of: [
            { op: "atom", fact_id: "fact_byid" },
            { op: "any", of: [{ op: "atom", key: "handshake_done" }, { op: "all", of: [{ op: "atom", fact_id: "fact_nested" }] }] },
          ],
        }),
        "step_cur",
      );
    const pack = buildContextPack(e.storage, lease("mv-r05", "execute", "step_cur"));
    const facts = (pack.user_payload as { graph: { facts: { id: string }[] } }).graph.facts;
    assert.ok(facts.some((f) => f.id === "fact_byid"), "atom.fact_id");
    assert.ok(facts.some((f) => f.id === "fact_bykey"), "atom.key");
    assert.ok(facts.some((f) => f.id === "fact_nested"), "nested all/any");
  } finally {
    e.close();
  }
});

test("R05-05/06: linked facts dedupe and never upgrade disputed state", () => {
  const e = boot("mv-r05b");
  try {
    insertFact(e, "mv-r05b", "fact_dis", "contested dependency", { seq: 1, status: "disputed", counters: ["obs_9"] });
    insertStep(e, "mv-r05b", "step_cur", "ready", 500);
    e.storage.store.db
      .prepare("UPDATE steps SET input_refs_json = ?, preconditions_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: "fact_dis", revision: 1 }]), JSON.stringify({ op: "all", of: [{ op: "atom", fact_id: "fact_dis" }] }), "step_cur");
    const pack = buildContextPack(e.storage, lease("mv-r05b", "execute", "step_cur"));
    const facts = (pack.user_payload as { graph: { facts: { id: string; state: string; counter_refs: string[] }[] } }).graph.facts;
    const hits = facts.filter((f) => f.id === "fact_dis");
    assert.equal(hits.length, 1, "referenced twice, shown once");
    assert.equal(hits[0]!.state, "disputed");
    assert.deepEqual(hits[0]!.counter_refs, ["obs_9"]);
  } finally {
    e.close();
  }
});

test("R05-09: a production-created step's input refs land in the view and manifest", () => {
  const e = boot("mv-r05c");
  try {
    insertFact(e, "mv-r05c", "fact_prod", "production-linked", { seq: 1 });
    for (let i = 0; i < 65; i++) insertFact(e, "mv-r05c", `f_${i}`, `noise ${i}`, { seq: 100 + i });
    const fact = e.storage.list("facts", "mv-r05c").find((f) => f.id === "fact_prod")!;
    const root = (e.storage.store.db.prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1").get("mv-r05c") as { id: string }).id;
    const result = e.storage.proposeStepDirect({
      campaign_id: "mv-r05c",
      producer_id: "t",
      submission_id: "r05c-step",
      question: "verify the linked dependency",
      kind: "explore",
      goal_refs: [root],
      preconditions: { op: "all", of: [] },
      method_family: "generic",
      expected_observations: [],
      completion_criteria: "done",
      fingerprint: "r05c-fp",
      reopen_rule: { kind: "always" },
      input_refs: [{ id: String(fact.id), revision: Number(fact.revision) }],
    });
    const stepId = String(result.canonical_ids.step_id);
    const pack = buildContextPack(e.storage, lease("mv-r05c", "execute", stepId));
    const facts = (pack.user_payload as { graph: { facts: { id: string }[] } }).graph.facts;
    assert.ok(facts.some((f) => f.id === "fact_prod"), "production input_refs surface the linked fact");
    assert.ok(
      pack.manifest.selected_entity_revisions.some((r) => r.table === "facts" && r.id === "fact_prod"),
      "and its revision enters the internal read set",
    );
  } finally {
    e.close();
  }
});

// --- R06: the active frontier displays in full while the budget allows ---

test("R06-01: 65 short active steps all appear (no fixed cap)", () => {
  const e = boot("mv-r06a");
  try {
    for (let i = 0; i < 65; i++) insertStep(e, "mv-r06a", `step_a${i}`, "ready", i, `short question ${i}`);
    const pack = buildContextPack(e.storage, lease("mv-r06a", "decide", null));
    const payload = pack.user_payload as { graph: { steps: { id: string }[] }; omitted: { kind: string }[] };
    assert.equal(payload.graph.steps.length, 65, "the whole active frontier shows");
    assert.equal(payload.omitted.some((o) => o.kind === "steps"), false, "nothing omitted under budget");
  } finally {
    e.close();
  }
});

test("R06-03: a genuinely over-budget frontier omits honestly and protects the current step", () => {
  const e = boot("mv-r06b");
  try {
    const long = "q".repeat(400);
    for (let i = 0; i < 400; i++) insertStep(e, "mv-r06b", `step_b${String(i).padStart(3, "0")}`, "ready", i, `${long} ${i}`);
    const pack = buildContextPack(e.storage, lease("mv-r06b", "execute", "step_b399"));
    const payload = pack.user_payload as {
      graph: { steps: { id: string }[] };
      omitted: { kind: string; total: number; included: number; omitted: number; read_more: { entity: string } }[];
    };
    const entry = payload.omitted.find((o) => o.kind === "steps");
    assert.ok(entry, "over budget omits with an entry");
    assert.equal(entry.total, 400);
    assert.equal(entry.included + entry.omitted, 400, "counts add up");
    assert.ok(entry.omitted > 0);
    assert.ok(payload.graph.steps.some((s) => s.id === "step_b399"), "the current step survives trimming");
    assert.ok(JSON.stringify(payload).length <= 400_000);
  } finally {
    e.close();
  }
});

test("R06-05: the same data builds the same overview twice", () => {
  const e = boot("mv-r06c");
  try {
    for (let i = 0; i < 30; i++) insertStep(e, "mv-r06c", `step_c${i}`, "ready", i, `q${i}`);
    for (let i = 0; i < 20; i++) insertFact(e, "mv-r06c", `fact_c${i}`, `claim ${i}`, { seq: i });
    const a = buildContextPack(e.storage, lease("mv-r06c", "decide", null));
    const b = buildContextPack(e.storage, lease("mv-r06c", "decide", null));
    const ga = (a.user_payload as { graph: unknown }).graph;
    const gb = (b.user_payload as { graph: unknown }).graph;
    assert.equal(JSON.stringify(ga), JSON.stringify(gb));
  } finally {
    e.close();
  }
});

test("R06-07: ids detail reads return business content without control columns", () => {
  const e = boot("mv-r06d");
  try {
    insertFact(e, "mv-r06d", "fact_d", "detail claim", { seq: 1 });
    const raw = e.storage.graphQuery("mv-r06d", { entity: "facts", ids: ["fact_d"] });
    const row = raw.items[0] as Record<string, unknown>;
    assert.ok("source_run_id" in row || "revision" in row, "raw rows keep metadata for the read set");
    // the model-facing projection drops them
    const projected = projectGraphItems("facts", raw.items) as Record<string, unknown>[];
    assert.equal(projected[0]!.claim, "detail claim");
    assert.equal("revision" in projected[0]!, false);
    assert.equal("source_run_id" in projected[0]!, false);
  } finally {
    e.close();
  }
});

test("F04: detail reads return the full business content, overviews stay clipped", () => {
  const e = boot("mv-f04");
  try {
    const longClaim = `prefix-${"x".repeat(600)}-tail-marker`;
    insertFact(e, "mv-f04", "fact_long", longClaim, { seq: 1 });
    const raw = e.storage.graphQuery("mv-f04", { entity: "facts", ids: ["fact_long"] });
    const detail = projectGraphItems("facts", raw.items) as { claim: string }[];
    assert.ok(detail[0]!.claim.endsWith("tail-marker"), "detail read carries the full claim");
    // the overview still clips
    const pack = buildContextPack(e.storage, lease("mv-f04", "decide", null));
    const overview = (pack.user_payload as { graph: { facts: { claim: string }[] } }).graph.facts.find((f) => f.claim.includes("prefix-"));
    assert.ok(overview && overview.claim.length < longClaim.length, "overview stays compact");
  } finally {
    e.close();
  }
});
