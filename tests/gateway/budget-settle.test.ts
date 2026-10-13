import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import type { RunLease } from "../../src/domain/types.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { ModelGateway } from "../../src/gateway/gateways.ts";
import { InvocationBook } from "../../src/gateway/invocation.ts";
import { Semaphore } from "../../src/gateway/semaphore.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";
import { createCataloguedProviderStream } from "../../src/provider/stream.ts";
import { SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-bgsettle-"));
}

function boot(id: string): Engine {
  const e = new Engine(makeRuntimeConfig(tmp()), { silent: true, maxCycles: 1 });
  e.createCampaign(loadDemoSpec(id));
  e.storage.setCampaignState(id, "active", { kind: "user", id: "t" });
  return e;
}

function leaseFor(run: { run_id: string; fence: number }, campaignId: string): RunLease {
  return {
    run_id: run.run_id,
    campaign_id: campaignId,
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
}

function fakeProvider(dir: string): ReturnType<typeof createCataloguedProviderStream> {
  const catalog = new ProviderCatalog(join(dir, "prov"));
  const rec = catalog.addProvider({
    display_name: "fake",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "http://127.0.0.1:9/v1/chat/completions",
    api_key: "x",
  });
  catalog.addModel({ provider_id: rec.id, name: "fake-model" });
  return createCataloguedProviderStream({
    catalog,
    providerId: rec.id,
    modelName: "fake-model",
    fetchFn: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }), {
        status: 200,
      }),
  });
}

test("a gated model call still settles budget and marks the invocation", async () => {
  const e = boot("bgt-gated");
  const run = e.storage.claimDecide("bgt-gated", "t")!;
  const lease = leaseFor(run, "bgt-gated");
  const { stream } = fakeProvider(e.config.data_dir);
  const sem = new Semaphore(2);
  const invocations = new InvocationBook(e.storage);
  const gw = new ModelGateway(e.storage, e.budget, invocations, stream, lease, "fake-model", "prv_fake", 16, { semaphore: sem });
  const s = await Promise.resolve(gw.stream(SCRIPTED_MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }));
  await s.result();
  const snap = e.budget.snapshot("bgt-gated");
  assert.equal(Number(snap.spent_tokens), 18, "the gated path must settle the budget");
  assert.equal(Number(snap.reserved_tokens), 0, "nothing left reserved");
  const inv = e.storage.list("invocations", "bgt-gated")[0]!;
  assert.equal(inv.state, "completed");
  assert.equal(Number(inv.actual_tokens), 18);
  assert.equal(sem.active, 0, "the semaphore slot is released");
  e.close();
});

test("recover skips an in-flight tool dispatch on a live run, reconciles it when the run settled", async () => {
  const e = boot("rec-live");
  // seed a ready step and claim it
  const root = String(e.storage.list("goals", "rec-live")[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: "rec-live",
    producer_id: "t",
    submission_id: "s1",
    question: "work",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "generic",
    expected_observations: [],
    completion_criteria: "done",
    fingerprint: "rec-live-fp",
    reopen_rule: { kind: "always" },
  });
  const claimed = e.storage.claimNextStep("rec-live", "w1", 1)!;
  const lease = leaseFor(claimed, "rec-live");
  // an in-flight tool dispatch (permit taken, never sent)
  const inv = e.invocations.prepare({
    campaign_id: "rec-live",
    run_id: lease.run_id,
    kind: "tool",
    purpose: "kali_run",
    fence: lease.fence,
    cancel_epoch: 0,
    effect_class: "unknown",
    reserved_calls: 1,
  });
  e.budget.reserve("rec-live", inv.id, 1, 0, 0);
  e.invocations.mark(inv.id, "dispatching");

  const before = e.budget.snapshot("rec-live");
  const r1 = await e.dispatchGate.recover("rec-live", undefined, new Set([lease.run_id]));
  assert.equal(r1.marked_uncertain, 0, "a live run's in-flight dispatch is left alone");
  const mid = e.budget.snapshot("rec-live");
  assert.equal(Number(mid.liability_calls ?? 0), 0, "no liability marked while the run is alive");
  assert.equal(Number(mid.reserved_calls), Number(before.reserved_calls));

  // now the run settles (crashed worker) — recovery reconciles the orphan
  e.storage.store.db
    .prepare("UPDATE task_runs SET state = 'lease_expired', deadline_ms = 0 WHERE id = ?")
    .run(lease.run_id);
  const r2 = await e.dispatchGate.recover("rec-live");
  assert.ok(r2.marked_uncertain >= 1, "orphaned dispatch is marked uncertain");
  const invAfter = e.storage.store.db.prepare("SELECT state FROM invocations WHERE id = ?").get(inv.id) as { state: string };
  assert.equal(invAfter.state, "uncertain");
  e.close();
});

test("an orphaned model invocation of a settled run reconciles its budget", async () => {
  const e = boot("rec-model");
  const run = e.storage.claimDecide("rec-model", "t")!;
  const lease = leaseFor(run, "rec-model");
  const inv = e.invocations.prepare({
    campaign_id: "rec-model",
    run_id: lease.run_id,
    kind: "model",
    purpose: "decide",
    fence: lease.fence,
    cancel_epoch: 0,
    prompt_hash: "x",
    reserved_calls: 1,
    reserved_tokens: 16,
  });
  e.budget.reserve("rec-model", inv.id, 1, 16, 0);
  e.invocations.mark(inv.id, "running");
  const before = e.budget.snapshot("rec-model");
  assert.equal(Number(before.reserved_tokens), 16);

  // run settles without the stream settling
  e.storage.store.db.prepare("UPDATE task_runs SET state = 'finished' WHERE id = ?").run(lease.run_id);
  await e.dispatchGate.recover("rec-model");
  const after = e.budget.snapshot("rec-model");
  assert.equal(Number(after.reserved_tokens), 0, "the orphan's reserve is reconciled");
  const invAfter = e.storage.store.db.prepare("SELECT state FROM invocations WHERE id = ?").get(inv.id) as { state: string };
  assert.equal(invAfter.state, "failed_known");
  e.close();
});
