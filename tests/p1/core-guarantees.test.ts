import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine, openEngine } from "../../src/controller/engine.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { evaluateCompletion } from "../../src/domain/completion.ts";
import { ModelGateway } from "../../src/gateway/gateways.ts";
import { InvocationBook } from "../../src/gateway/invocation.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";
import { createCataloguedProviderStream } from "../../src/provider/stream.ts";
import { pickFairReadyStep } from "../../src/scheduler/fair.ts";
import { SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";
import { buildContextPack, composeSystemPrompt, loadPrompt } from "../../src/context/builder.ts";
import { buildKaliFlagSpec } from "../../src/domain/quick-spec.ts";
import { inspectWorld, freshWorld } from "../../src/tools/synthetic.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import type { RunLease } from "../../src/domain/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-core-"));
}

function boot(dir: string, id: string): Engine {
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec(id);
  e.createCampaign(spec);
  e.storage.setCampaignState(spec.campaign_id, "active", { kind: "user", id: "t" });
  return e;
}

test("controller lock releases on close and a new process can start", async () => {
  const dir = tmp();
  const spec = loadDemoSpec("lock-reopen");
  const e1 = openEngine(dir, { silent: true, maxCycles: 1 });
  e1.createCampaign(spec);
  await e1.start(spec.campaign_id);
  e1.close();
  const e2 = openEngine(dir, { silent: true, maxCycles: 1 });
  await e2.start(spec.campaign_id);
  e2.close();
});

test("controller lock takeover after lease expiry", async () => {
  const dir = tmp();
  const spec = loadDemoSpec("lock-take");
  const e1 = new Engine(makeRuntimeConfig(dir, "owner-a"), { silent: true, maxCycles: 1 });
  e1.createCampaign(spec);
  e1.storage.acquireControllerLock(spec.campaign_id, "owner-a", 1);
  await new Promise((r) => setTimeout(r, 5));
  const e2 = new Engine(makeRuntimeConfig(dir, "owner-b"), { silent: true, maxCycles: 1 });
  const got = e2.storage.acquireControllerLock(spec.campaign_id, "owner-b", 60_000);
  assert.equal(got.takeover, true);
  e1.close();
  e2.close();
});

test("model settle uses reserved tokens so the reserved bucket does not go negative", async () => {
  const dir = tmp();
  const e = boot(dir, "bgt-settle");
  const run = e.storage.claimDecide("bgt-settle", "t")!;
  const lease: RunLease = {
    run_id: run.run_id,
    campaign_id: "bgt-settle",
    step_id: null,
    mode: "decide",
    kind: "decide",
    attempt_no: 1,
    fence: run.fence,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "t",
    continuation_of: null,
  };
  const catalog = new ProviderCatalog(join(dir, "prov"));
  const rec = catalog.addProvider({
    display_name: "fake",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "http://127.0.0.1:9/v1/chat/completions",
    api_key: "x",
  });
  catalog.addModel({ provider_id: rec.id, name: "fake-model" });
  const { stream } = createCataloguedProviderStream({
    catalog,
    providerId: rec.id,
    modelName: "fake-model",
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
        { status: 200 },
      ),
  });
  const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), stream, lease, "fake-model", rec.id, 16);
  const s = await Promise.resolve(
    gw.stream(SCRIPTED_MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
  );
  await s.result();
  const snap = e.budget.snapshot("bgt-settle");
  assert.equal(Number(snap.reserved_tokens) >= 0, true);
  assert.equal(Number(snap.spent_tokens), 18);
  assert.equal(Number(snap.free_tokens), Number(snap.total_tokens) - 18);
  e.close();
});

test("tool allowlist and campaign deadline are checked at admit", async () => {
  const dir = tmp();
  const e = boot(dir, "allow-dl");
  const spec = e.storage.getCampaign("allow-dl").spec;
  spec.tool_allowlist = ["finish_step"];
  spec.budget.deadline_ms = null;
  e.storage.store.db.prepare("UPDATE campaigns SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), "allow-dl");
  const run = e.storage.claimDecide("allow-dl", "t")!;
  const claimed = e.storage.claimNextStep("allow-dl", "t", 1);
  const lease: RunLease = {
    run_id: claimed?.run_id ?? run.run_id,
    campaign_id: "allow-dl",
    step_id: claimed?.step_id ?? null,
    mode: "execute",
    kind: "explore",
    attempt_no: 1,
    fence: claimed?.fence ?? 1,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "t",
    continuation_of: null,
  };
  const gw = e.factory.create("execute", lease.run_id);
  void gw;
  const pack = { manifest: { selected_entity_revisions: [] } };
  void pack;
  const toolGw = new (await import("../../src/gateway/gateways.ts")).ToolGateway(
    e.storage,
    e.budget,
    e.invocations,
    lease,
    e.dispatchGate,
  );
  const denied = await toolGw.admit({
    name: "world_inspect",
    args: { target: "desk" },
    lease,
    effect: "unknown",
    envTool: true,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "tool_not_allowlisted");
  spec.tool_allowlist = ["world_inspect", "finish_step"];
  spec.budget.deadline_ms = Date.now() - 5;
  e.storage.store.db.prepare("UPDATE campaigns SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), "allow-dl");
  const expired = await toolGw.admit({
    name: "world_inspect",
    args: { target: "desk" },
    lease,
    effect: "unknown",
    envTool: true,
  });
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, "campaign_deadline");
  e.close();
});

test("catalogued stream sends history, tools, and returns tool calls", async () => {
  const dir = tmp();
  const catalog = new ProviderCatalog(dir);
  const rec = catalog.addProvider({
    display_name: "fake",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "http://127.0.0.1:9/v1/chat/completions",
    api_key: "x",
  });
  catalog.addModel({ provider_id: rec.id, name: "fake-model" });
  let toolsSent = false;
  let historySent = false;
  const { stream } = createCataloguedProviderStream({
    catalog,
    providerId: rec.id,
    modelName: "fake-model",
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        tools?: unknown[];
        messages?: { role: string }[];
      };
      toolsSent = Array.isArray(body.tools) && body.tools.length > 0;
      historySent = Array.isArray(body.messages) && body.messages.length >= 3;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "echo_probe", arguments: "{\"token\":\"ok\"}" } }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  const s = await Promise.resolve(
    stream(
      SCRIPTED_MODEL,
      {
        systemPrompt: "sys",
        messages: [
          { role: "user", content: "first", timestamp: Date.now() },
          {
            role: "assistant",
            content: [{ type: "text", text: "ack" }],
            api: "openai-completions",
            provider: "scripted",
            model: "scripted",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          },
          { role: "user", content: "second", timestamp: Date.now() },
        ],
        tools: [
          {
            name: "echo_probe",
            description: "echo",
            parameters: { type: "object", properties: { token: { type: "string" } } } as never,
          },
        ],
      },
    ),
  );
  const msg = await s.result();
  assert.equal(toolsSent, true);
  assert.equal(historySent, true);
  assert.equal(msg.stopReason, "toolUse");
  assert.ok(msg.content.some((c) => c.type === "toolCall" && c.name === "echo_probe"));
});

test("deferred never does not reopen when preconditions are already true", () => {
  const dir = tmp();
  const e = boot(dir, "reopen-never");
  const run = e.storage.claimDecide("reopen-never", "t")!;
  const root = String(e.storage.list("goals", "reopen-never")[0]!.id);
  const st = e.storage.proposeStepDirect({
    campaign_id: "reopen-never",
    producer_id: "p",
    submission_id: "side",
    run_id: run.run_id,
    question: "wait forever",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "x",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "never-1",
    reopen_rule: { kind: "never" },
  });
  e.storage.store.db.prepare("UPDATE steps SET status = 'deferred' WHERE id = ?").run(st.canonical_ids.step_id!);
  e.storage.recomputeStepReadiness("reopen-never");
  const step = e.storage.list("steps", "reopen-never").find((s) => s.id === st.canonical_ids.step_id)!;
  assert.equal(step.status, "deferred");
  e.close();
});

test("fair pick rotates after a branch has been served", () => {
  const dir = tmp();
  const e = boot(dir, "fair-starve");
  const run = e.storage.claimDecide("fair-starve", "t")!;
  const root = String(e.storage.list("goals", "fair-starve")[0]!.id);
  const mk = (q: string, branch: string, fp: string, ready: string, served: string | null) => {
    const r = e.storage.proposeStepDirect({
      campaign_id: "fair-starve",
      producer_id: "p",
      submission_id: fp,
      run_id: run.run_id,
      question: q,
      kind: "explore",
      goal_refs: [root],
      preconditions: { op: "all", of: [] },
      method_family: q,
      expected_observations: [],
      completion_criteria: "x",
      fingerprint: fp,
      reopen_rule: { kind: "never" },
      branch_id: branch,
    });
    e.storage.store.db
      .prepare("UPDATE steps SET ready_since = ?, branch_id = ?, last_served_at = ? WHERE id = ?")
      .run(ready, branch, served, r.canonical_ids.step_id!);
    return String(r.canonical_ids.step_id);
  };
  const a = mk("A", "brA", "fa", "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:10.000Z");
  const b = mk("B", "brB", "fb", "2026-01-01T00:00:02.000Z", null);
  const picked = pickFairReadyStep(e.storage, "fair-starve");
  assert.equal(picked, b);
  assert.notEqual(picked, a);
  e.close();
});

test("assessment cannot close on stale or missing coverage evidence", () => {
  const base = {
    mode: "assessment" as const,
    state: "active" as const,
    cancel_epoch: 0,
    in_flight_runs: 0,
    in_flight_invocations: 0,
    unconsumed_events: 0,
    pending_important_proposals: 0,
    uncertain_invocations: 0,
    empty_reviews: 2,
    max_empty_reviews: 2,
    ready_steps: 0,
    blocked_steps: 0,
    frontier_size: 0,
    new_observation_since_progress: false,
    findings: [{ status: "confirmed" as const }],
    root_goal_satisfied: false,
  };
  const stale = evaluateCompletion({
    ...base,
    coverage: [
      {
        id: "c1",
        mandatory: true,
        applicability: "applicable",
        execution_state: "tested",
        outcome: "no_issue_observed",
        evidence_state: "stale",
      },
    ],
  });
  assert.equal(stale.canClose, false);
  const missing = evaluateCompletion({
    ...base,
    coverage: [
      {
        id: "c1",
        mandatory: true,
        applicability: "applicable",
        execution_state: "tested",
        outcome: "no_issue_observed",
        evidence_state: "missing",
      },
    ],
  });
  assert.equal(missing.canClose, false);
});

test("derived facts do not bump progress_epoch", () => {
  const dir = tmp();
  const e = boot(dir, "derived-prog");
  const run = e.storage.claimDecide("derived-prog", "t")!;
  const before = e.storage.getCampaign("derived-prog").progress_epoch;
  const obs = e.storage.recordObservation({
    campaign_id: "derived-prog",
    producer_id: "p",
    submission_id: "o",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "x",
    body: {},
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  const afterObs = e.storage.getCampaign("derived-prog").progress_epoch;
  e.storage.submitFact({
    campaign_id: "derived-prog",
    producer_id: "p",
    submission_id: "d1",
    run_id: run.run_id,
    proposition: "guess 1",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
    source_grade: "derived",
  });
  e.storage.submitFact({
    campaign_id: "derived-prog",
    producer_id: "p",
    submission_id: "d2",
    run_id: run.run_id,
    proposition: "guess 2",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
    source_grade: "derived",
  });
  const after = e.storage.getCampaign("derived-prog").progress_epoch;
  assert.equal(afterObs, before + 1);
  assert.equal(after, afterObs);
  e.close();
});

test("incomplete decide does not spin a tight empty loop", async () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 80,
    chooseDecide: () => ({ type: "text", text: "no finish_decision" }),
    chooseExecute: () => ({ type: "text", text: "no finish_step" }),
  });
  const spec = loadDemoSpec("empty-decide");
  e.createCampaign(spec);
  e.hint("empty-decide", "nudge");
  await e.start("empty-decide");
  const n = Number(
    (e.storage.store.db.prepare("SELECT COUNT(*) AS c FROM task_runs WHERE campaign_id = ? AND mode = 'decide'").get("empty-decide") as { c: number }).c,
  );
  assert.equal(n, 1);
  e.close();
});

test("execute prompt is generic; web/flag specifics live in briefs and the env index", () => {
  const base = loadPrompt("execute");
  // the generic base must not carry web-target or flag-only global rules
  assert.ok(!base.includes("unserialize"));
  assert.ok(!base.includes("flag_recovered"));
  assert.ok(!base.includes("artifact_read"));

  // the composed prompt for a pure web flag campaign still carries them
  const spec = buildKaliFlagSpec({ url: "http://target.example/", provider: "prv_test", model: "m" });
  const composed = composeSystemPrompt("execute", spec);
  assert.match(composed, /环境可能不同/); // web brief: container vs target
  assert.match(composed, /目标的实际响应/);
  assert.match(composed, /artifact_read/); // env index: paging
  assert.match(composed, /truncated/);
  assert.match(composed, /finish_step/);
  assert.match(composed, /flag_recovered/); // ctf brief: flag submission semantics
  assert.match(composed, /外部验收/);
});

test("hints land in the next context pack", () => {
  const dir = tmp();
  const e = boot(dir, "hint-ctx");
  e.hint("hint-ctx", "UNIQUE_HINT_TOKEN_9f3a");
  const run = e.storage.claimDecide("hint-ctx", "t")!;
  const pack = buildContextPack(e.storage, {
    run_id: run.run_id,
    campaign_id: "hint-ctx",
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
  assert.equal(JSON.stringify(pack.user_payload).includes("UNIQUE_HINT_TOKEN_9f3a"), true);
  e.close();
});

test("httpReq-style propose_plan becomes a ready step", () => {
  const dir = tmp();
  const e = boot(dir, "coerce-http");
  const run = e.storage.claimDecide("coerce-http", "t")!;
  const result = e.storage.applyProposalBatch({
    campaign_id: "coerce-http",
    producer_id: run.run_id,
    submission_id: "http1",
    run_id: run.run_id,
    operations: [{ op: "httpReq", url: "http://b147.example/" }],
  });
  assert.ok(result.canonical_ids.step_id);
  const step = e.storage.list("steps", "coerce-http")[0]!;
  assert.equal(step.status, "ready");
  assert.match(String(step.question), /b147.example/);
  e.close();
});

test("inspectWorld does not leak hidden sample_id on desk inspect", () => {
  const r = inspectWorld(freshWorld(), "desk");
  assert.equal(JSON.stringify(r.observation).includes("SAMPLE-42"), false);
  assert.equal(r.world.sample_id, "SAMPLE-42");
});

test("success-predicate fact stays pending until a human accepts or rejects it", async () => {
  const dir = tmp();
  const spec = loadDemoSpec("goal-human");
  spec.root_goal = { ...spec.root_goal, success_predicate_ref: "flag_recovered" };
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 2 });
  e.createCampaign(spec);
  e.storage.setCampaignState("goal-human", "active", { kind: "user", id: "t" });
  const run = e.storage.claimDecide("goal-human", "t")!;
  const obs = e.storage.recordObservation({
    campaign_id: "goal-human",
    producer_id: "p",
    submission_id: "o1",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "http-body",
    body: { text: "CTF2{fake}" },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  e.storage.submitFact({
    campaign_id: "goal-human",
    producer_id: "p",
    submission_id: "f1",
    run_id: run.run_id,
    proposition: "CTF2{fake}",
    fact_key: "flag_recovered",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
    source_grade: "observed",
  });
  const first = e.storage.list("facts", "goal-human")[0]!;
  assert.equal(first.epistemic_status, "proposed");
  assert.equal(first.source_grade, "observed");
  assert.ok(e.storage.pendingGoalClaim("goal-human"));
  e.storage.finishRun("goal-human", run.run_id, {
    run_id: run.run_id,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "submitted candidate",
    observation_ids: [],
    fact_ids: [String(first.id)],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  await e.runLoop("goal-human");
  assert.equal(e.storage.getCampaign("goal-human").state, "awaiting_verify");
  assert.throws(
    () => e.resume("goal-human"),
    (err: unknown) => err instanceof DomainError && err.code === "awaiting_human_verify",
  );
  const rejected = e.verifyGoal("goal-human", { accept: false, text: "flag不正确" });
  assert.equal(rejected.state, "active");
  assert.equal(e.storage.list("facts", "goal-human")[0]!.epistemic_status, "disputed");
  assert.equal(e.storage.pendingGoalClaim("goal-human"), null);
  const pack = buildContextPack(e.storage, {
    run_id: run.run_id,
    campaign_id: "goal-human",
    step_id: null,
    mode: "execute",
    kind: "explore",
    attempt_no: 1,
    fence: run.fence,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 1000,
    lease_owner: "t",
    continuation_of: null,
  });
  const blob = JSON.stringify(pack.user_payload);
  assert.equal(blob.includes("flag不正确"), true);
  assert.equal(blob.includes("CTF2{fake}"), true);
  e.storage.submitFact({
    campaign_id: "goal-human",
    producer_id: "p",
    submission_id: "f2",
    run_id: run.run_id,
    proposition: "CTF2{real}",
    fact_key: "flag_recovered",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
    source_grade: "observed",
  });
  await e.runLoop("goal-human");
  assert.equal(e.storage.getCampaign("goal-human").state, "awaiting_verify");
  const accepted = e.verifyGoal("goal-human", { accept: true });
  assert.equal(accepted.state, "completed");
  const kept = e.storage.list("facts", "goal-human").find((f) => String(f.proposition) === "CTF2{real}")!;
  assert.equal(kept.epistemic_status, "accepted");
  assert.equal(kept.source_grade, "verified");
  e.close();
});
