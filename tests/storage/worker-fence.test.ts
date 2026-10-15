/**
 * L09–L18: worker write fences — a fenced-off worker cannot write business
 * state, finish someone else's run, or keep a slot after takeover; unknown
 * external effects hold their recovery slot; crashed workers are reclaimed.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { DomainError } from "../../src/domain/errors.ts";
import type { ControllerLease, RunLease } from "../../src/domain/types.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { DispatchGate } from "../../src/gateway/dispatch.ts";
import { ModelGateway, ToolGateway } from "../../src/gateway/gateways.ts";
import { InvocationBook } from "../../src/gateway/invocation.ts";
import { SCRIPTED_MODEL, createTextStream } from "../../src/runtime/pi/scripted-stream.ts";
import { FileEffectAdapter } from "../../src/tools/effect-adapter.ts";

function boot(id: string): Engine {
  const e = new Engine(makeRuntimeConfig(mkdtempSync(join(tmpdir(), "rn-wf-"))), { silent: true, maxCycles: 1 });
  e.createCampaign(loadDemoSpec(id));
  e.storage.setCampaignState(id, "active", { kind: "user", id: "t" });
  return e;
}

function seedStep(e: Engine, id: string, fp: string): void {
  const root = String(e.storage.list("goals", id)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: id,
    producer_id: "t",
    submission_id: `s-${fp}`,
    question: "work",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "generic",
    expected_observations: [],
    completion_criteria: "done",
    fingerprint: fp,
    reopen_rule: { kind: "always" },
  });
}

function ctrlFor(e: Engine, id: string, owner = "ctrl"): ControllerLease {
  const acq = e.storage.acquireControllerLock(id, owner, 60_000);
  return { campaign_id: id, owner, generation: acq.generation };
}

function leaseOf(id: string, claimed: { run_id: string; fence: number; controller_generation: number }, stepId: string | null): RunLease {
  return {
    run_id: claimed.run_id,
    campaign_id: id,
    step_id: stepId,
    mode: "execute",
    kind: "explore",
    attempt_no: 1,
    fence: claimed.fence,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "ctrl",
    controller_generation: claimed.controller_generation,
    continuation_of: null,
  };
}

/** Take the controller over under a new generation, fencing off the old one. */
function takeover(e: Engine, id: string): ControllerLease {
  e.storage.store.db.prepare("UPDATE controller_locks SET lease_until = 0 WHERE campaign_id = ?").run(id);
  return ctrlFor(e, id, "ctrl2");
}

test("L09: a run whose controller generation was superseded cannot send model or env calls", async () => {
  const e = boot("l09");
  const id = "l09";
  seedStep(e, id, "l09-fp");
  const c1 = ctrlFor(e, id);
  const claimed = e.storage.claimNextStep(id, c1, 1)!;
  const lease = leaseOf(id, claimed, claimed.step_id);
  // controller moves on to generation 2 while the run is nominally live
  takeover(e, id);
  const inv = new InvocationBook(e.storage);
  const adapter = new FileEffectAdapter(join(e.config.data_dir, "fx"));
  const gate = new DispatchGate(e.storage, e.budget, inv, adapter);
  const tg = new ToolGateway(e.storage, e.budget, inv, lease, gate, 10);
  const res = await tg.admit({ name: "world_act", args: { action: "scan" }, lease, effect: "unknown", envTool: true });
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "controller_lost");
  assert.equal(adapter.sendCount(), 0, "nothing was sent");
  let sends = 0;
  const mg = new ModelGateway(e.storage, e.budget, inv, (() => {
    sends += 1;
    return createTextStream(SCRIPTED_MODEL, "nope");
  }) as never, lease, "m", "p", 16);
  const s = await Promise.resolve(mg.stream(SCRIPTED_MODEL, { systemPrompt: "s", messages: [{ role: "user", content: "x", timestamp: Date.now() }] }));
  const r = (await s.result()) as { stopReason?: string; errorMessage?: string | null };
  assert.equal(r.stopReason, "error");
  assert.match(String(r.errorMessage), /controller_lost/);
  assert.equal(sends, 0, "the provider was never called");
  e.close();
});

test("L10: every worker business-write entry rejects a superseded lease", () => {
  const e = boot("l10");
  const id = "l10";
  seedStep(e, id, "l10-fp");
  const c1 = ctrlFor(e, id);
  const claimed = e.storage.claimNextStep(id, c1, 1)!;
  const lease = leaseOf(id, claimed, claimed.step_id);
  takeover(e, id);

  const writes: [string, () => unknown][] = [
    ["recordObservation", () =>
      e.storage.recordObservation({
        campaign_id: id, producer_id: "w", submission_id: "w-obs", run_id: lease.run_id, attempt_id: lease.run_id,
        subject: "s", body: {}, artifact_refs: [], conditions: {}, env_rev: "env-1", lease,
      })],
    ["submitFact", () =>
      e.storage.submitFact({
        campaign_id: id, producer_id: "w", submission_id: "w-fact", run_id: lease.run_id,
        proposition: "p", support_refs: [], conditions: {}, lease,
      })],
    ["submitFinding", () =>
      e.storage.submitFinding({
        campaign_id: id, producer_id: "w", submission_id: "w-find", run_id: lease.run_id,
        claim: "c", evidence_refs: [], dedup_key: "k", lease,
      })],
    ["proposeStepDirect", () =>
      e.storage.proposeStepDirect({
        campaign_id: id, producer_id: "w", submission_id: "w-step", run_id: lease.run_id,
        question: "q", kind: "explore", goal_refs: [], preconditions: { op: "all", of: [] }, method_family: "x",
        expected_observations: [], completion_criteria: "c", fingerprint: "w-fp", reopen_rule: { kind: "never" }, lease,
      })],
    ["applyProposalBatch", () =>
      e.storage.applyProposalBatch({
        campaign_id: id, producer_id: "w", submission_id: "w-batch", run_id: lease.run_id,
        operations: [], lease,
      })],
    ["saveCheckpoint", () =>
      e.storage.saveCheckpoint({ campaign_id: id, run_id: lease.run_id, note: "n", lease })],
    ["submitRunOutcome", () =>
      e.storage.submitRunOutcome({
        campaign_id: id, run_id: lease.run_id, fence: lease.fence, controller_generation: lease.controller_generation,
        submission_id: "w-fin", payload: { disposition: "resolved", summary: "s" } as never,
        observation_ids: [], fact_ids: [], finding_ids: [], source: "primary",
      })],
  ];
  for (const [name, fn] of writes) {
    assert.throws(fn, (err: unknown) => err instanceof DomainError && (err.code === "lease_lost" || err.code === "stale_fence"), name);
  }
  // and the same entries without a lease (trusted control-plane actor) still work
  const ok = e.storage.recordObservation({
    campaign_id: id, producer_id: "t", submission_id: "ctrl-obs", run_id: lease.run_id, attempt_id: lease.run_id,
    subject: "s", body: {}, artifact_refs: [], conditions: {}, env_rev: "env-1",
  });
  assert.equal(ok.status, "ok");
  e.close();
});

test("L11: an old run's finishRun never touches the successor's step or slot", () => {
  const e = boot("l11");
  const id = "l11";
  seedStep(e, id, "l11-fp");
  const c1 = ctrlFor(e, id);
  const a = e.storage.claimNextStep(id, c1, 1)!;
  // A expires, gets revoked, B reclaims the step under a new generation
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = 0 WHERE id = ?").run(a.run_id);
  const c2 = takeover(e, id);
  const b = e.storage.claimNextStep(id, c2, 1)!;
  assert.ok(b);
  assert.equal(b.step_id, a.step_id);
  // A's late finish with its own (old) fence/generation must not apply
  const late = e.storage.finishRun(id, a.run_id, {
    run_id: a.run_id, step_id: a.step_id, mode: "execute", reason: "resolved", summary: "stale",
    observation_ids: [], fact_ids: [], finding_ids: [], blocked_on: null, reopen_rule: null,
    finish_requested: true, protocol_error: null,
  }, { fence: a.fence, controller_generation: a.controller_generation });
  assert.equal(late.applied, false);
  const step = e.storage.store.db.prepare("SELECT status, active_run_id FROM steps WHERE id = ?").get(b.step_id) as {
    status: string;
    active_run_id: string;
  };
  assert.equal(step.status, "running");
  assert.equal(step.active_run_id, b.run_id, "B's claim is untouched");
  e.close();
});

test("L14/L20: two connections under one controller respect capacity and mutex; a lost claim writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-wf14-"));
  const e1 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec("l14");
  spec.execution_policy = { max_execute_workers: 1 };
  e1.createCampaign(spec);
  e1.storage.setCampaignState("l14", "active", { kind: "user", id: "t" });
  seedStep(e1, "l14", "l14-a");
  seedStep(e1, "l14", "l14-b");
  const c = ctrlFor(e1, "l14");
  const e2 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  // conn1 claims the single execute slot
  const a = e1.storage.claimNextStep("l14", c, 1);
  assert.ok(a);
  // conn2 (same lease): capacity exhausted, and no run row was half-written
  const runsBefore = e2.storage.list("task_runs", "l14").length;
  assert.equal(e2.storage.claimNextStep("l14", c, 1), null);
  assert.equal(e2.storage.list("task_runs", "l14").length, runsBefore, "no half-created run");
  // conn2 cannot take a decide while an execute is live
  assert.equal(e2.storage.claimDecide("l14", c), null);
  // conn1 cannot claim a second decide either
  assert.equal(e1.storage.claimDecide("l14", c), null);
  e1.close();
  e2.close();
});

test("L17: an expired run with unknown external calls keeps its recovery slot", () => {
  const e = boot("l17");
  const id = "l17";
  seedStep(e, id, "l17-a");
  seedStep(e, id, "l17-b");
  const c = ctrlFor(e, id);
  const a = e.storage.claimNextStep(id, c, 1)!;
  // an unknown-outcome external invocation on A
  const inv = new InvocationBook(e.storage).prepare({
    campaign_id: id, run_id: a.run_id, kind: "tool", purpose: "kali_run",
    fence: a.fence, cancel_epoch: 0, effect_class: "unknown", reserved_calls: 1,
  });
  new InvocationBook(e.storage).mark(inv.id, "uncertain");
  // A expires
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = 0 WHERE id = ?").run(a.run_id);
  // capacity 1: the recovery slot holds; the sibling step cannot start
  assert.equal(e.storage.claimNextStep(id, c, 1), null, "the unknown effect keeps the slot");
  const stepA = e.storage.store.db.prepare("SELECT status, last_failure FROM steps WHERE id = ?").get(a.step_id) as {
    status: string;
    last_failure: string;
  };
  assert.equal(stepA.status, "deferred");
  assert.equal(stepA.last_failure, "recovery_pending");
  // once the invocation is reconciled, the slot frees
  new InvocationBook(e.storage).mark(inv.id, "completed");
  const b = e.storage.claimNextStep(id, c, 1);
  assert.ok(b, "slot freed after the unknown call was reconciled");
  e.close();
});

test("L18: a worker whose promise rejects is memory-cleaned and its run is reclaimable", async () => {
  const e = boot("l18");
  const id = "l18";
  seedStep(e, id, "l18-fp");
  const c = ctrlFor(e, id);
  const claimed = e.storage.claimNextStep(id, c, 1)!;
  const lease = leaseOf(id, claimed, claimed.step_id);
  const fakeWorker = {
    start: async () => {},
    settle: () => Promise.reject(new Error("worker blew up")),
    abort: () => {},
    modelGateway: null,
    toolGateway: null,
  };
  const origCreate = e.factory.create.bind(e.factory);
  e.factory.create = (() => fakeWorker) as never;
  await assert.rejects(e.runWorker(lease), /worker blew up/);
  e.factory.create = origCreate;
  // the persistent run is not settled by the crash; it stays reclaimable
  assert.equal(String(e.storage.getRun(lease.run_id).state), "running");
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = 0 WHERE id = ?").run(lease.run_id);
  assert.equal(e.storage.recoverStaleRuns(id), 1);
  assert.equal(String(e.storage.getRun(lease.run_id).state), "lease_expired");
  e.close();
});
