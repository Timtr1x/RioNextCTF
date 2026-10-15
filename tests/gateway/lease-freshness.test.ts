/**
 * P1-01/P2-01: admission reads the live database lease, not the claim-time
 * snapshot; the model gateway passes the real call signal into the queue.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import type { RunLease } from "../../src/domain/types.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { DispatchGate } from "../../src/gateway/dispatch.ts";
import { ModelGateway, ToolGateway } from "../../src/gateway/gateways.ts";
import { InvocationBook } from "../../src/gateway/invocation.ts";
import { Semaphore } from "../../src/gateway/semaphore.ts";
import { SCRIPTED_MODEL, createTextStream } from "../../src/runtime/pi/scripted-stream.ts";
import { FileEffectAdapter } from "../../src/tools/effect-adapter.ts";

function boot(id: string): Engine {
  const e = new Engine(makeRuntimeConfig(mkdtempSync(join(tmpdir(), "rn-lfresh-"))), { silent: true, maxCycles: 1 });
  e.createCampaign(loadDemoSpec(id));
  e.storage.setCampaignState(id, "active", { kind: "user", id: "t" });
  return e;
}

function leaseFor(e: Engine, id: string): RunLease {
  const root = String(e.storage.list("goals", id)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: id, producer_id: "t", submission_id: `s-${Math.random()}`, question: "work", kind: "explore",
    goal_refs: [root], preconditions: { op: "all", of: [] }, method_family: "x",
    expected_observations: [], completion_criteria: "c", fingerprint: `fp-${Math.random()}`, reopen_rule: { kind: "never" },
  });
  const claimed = e.storage.claimNextStepAsOwner(id, "ctrl", 1)!;
  return {
    run_id: claimed.run_id, campaign_id: id, step_id: claimed.step_id, mode: "execute", kind: claimed.kind,
    attempt_no: 1, fence: claimed.fence, cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "ctrl", controller_generation: claimed.controller_generation, continuation_of: null,
  };
}

function ctx() {
  return { systemPrompt: "s", messages: [{ role: "user" as const, content: "x", timestamp: Date.now() }] };
}

test("P1-01: a renewed DB lease admits model and tool calls even with a stale snapshot", async () => {
  const e = boot("lf1");
  const lease = leaseFor(e, "lf1");
  // The snapshot the gateway was built with is long past; the DB row is fresh.
  const stale: RunLease = { ...lease, deadline_ms: Date.now() - 60_000 };
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = ? WHERE id = ?").run(Date.now() + 300_000, lease.run_id);
  const inv = new InvocationBook(e.storage);
  const mg = new ModelGateway(e.storage, e.budget, inv, ((m: never, c: never) => createTextStream(SCRIPTED_MODEL, "ok")) as never, stale, "m", "p", 16);
  const s = await Promise.resolve(mg.stream(SCRIPTED_MODEL, ctx()));
  const r = (await s.result()) as { stopReason?: string };
  assert.equal(r.stopReason, "stop", "model admitted on the fresh DB lease");

  const adapter = new FileEffectAdapter(join(e.config.data_dir, "fx"));
  const gate = new DispatchGate(e.storage, e.budget, inv, adapter);
  const tg = new ToolGateway(e.storage, e.budget, inv, stale, gate, 10);
  const res = await tg.admit({ name: "world_act", args: { action: "x" }, lease: stale, effect: "unknown", envTool: true });
  assert.equal(res.allowed, true, "tool admitted on the fresh DB lease");
  assert.equal(adapter.sendCount(), 1);
  e.close();
});

test("P1-01: a lapsed DB lease rejects immediately, snapshot freshness irrelevant", async () => {
  const e = boot("lf2");
  const lease = leaseFor(e, "lf2");
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = ? WHERE id = ?").run(Date.now() - 1, lease.run_id);
  const inv = new InvocationBook(e.storage);
  const mg = new ModelGateway(e.storage, e.budget, inv, (() => createTextStream(SCRIPTED_MODEL, "nope")) as never, lease, "m", "p", 16);
  const s = await Promise.resolve(mg.stream(SCRIPTED_MODEL, ctx()));
  const r = (await s.result()) as { stopReason?: string; errorMessage?: string | null };
  assert.equal(r.stopReason, "error");
  assert.match(String(r.errorMessage), /lease_expired/);
  const adapter = new FileEffectAdapter(join(e.config.data_dir, "fx"));
  const tg = new ToolGateway(e.storage, e.budget, inv, lease, new DispatchGate(e.storage, e.budget, inv, adapter), 10);
  const res = await tg.admit({ name: "world_act", args: {}, lease, effect: "unknown", envTool: true });
  assert.equal(res.allowed, false);
  assert.equal(adapter.sendCount(), 0);
  e.close();
});

test("P1-01: the campaign hard deadline still wins over any renewal", async () => {
  const e = boot("lf3");
  const lease = leaseFor(e, "lf3");
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = ? WHERE id = ?").run(Date.now() + 300_000, lease.run_id);
  e.storage.store.db
    .prepare("UPDATE campaigns SET spec_json = json_replace(spec_json, '$.budget.deadline_ms', ?) WHERE id = ?")
    .run(Date.now() - 1, "lf3");
  const mg = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), (() => createTextStream(SCRIPTED_MODEL, "nope")) as never, lease, "m", "p", 16);
  const s = await Promise.resolve(mg.stream(SCRIPTED_MODEL, ctx()));
  const r = (await s.result()) as { stopReason?: string; errorMessage?: string | null };
  assert.equal(r.stopReason, "error");
  assert.match(String(r.errorMessage), /campaign_deadline/);
  e.close();
});

test("P2-01: aborting the call signal while queued removes the call and releases the reserve", async () => {
  const e = boot("lf4");
  const lease = leaseFor(e, "lf4");
  const sem = new Semaphore(1);
  const blocker = await sem.acquire();
  let innerCalls = 0;
  const mg = new ModelGateway(
    e.storage,
    e.budget,
    new InvocationBook(e.storage),
    (() => {
      innerCalls += 1;
      return createTextStream(SCRIPTED_MODEL, "nope");
    }) as never,
    lease,
    "m",
    "p",
    16,
    { semaphore: sem },
  );
  const ctl = new AbortController();
  const pending = Promise.resolve(mg.stream(SCRIPTED_MODEL, ctx(), { signal: ctl.signal } as never));
  for (let i = 0; i < 20 && sem.queued !== 1; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 1, "the call is queued");
  ctl.abort();
  const s = await pending;
  const r = (await s.result()) as { stopReason?: string; errorMessage?: string | null };
  assert.equal(r.stopReason, "error");
  assert.match(String(r.errorMessage), /queue_aborted/);
  assert.equal(sem.queued, 0, "the aborted call left the queue");
  blocker.release();
  for (let i = 0; i < 20 && (sem.active as number) !== 0; i += 1) await new Promise((x) => setImmediate(x));
  assert.equal(sem.active, 0, "no slot leaked");
  assert.equal(innerCalls, 0, "the provider was never called");
  const snap = e.budget.snapshot("lf4");
  assert.equal(Number(snap.reserved_tokens), 0, "the prepared reserve was released as never-sent");
  e.close();
});
