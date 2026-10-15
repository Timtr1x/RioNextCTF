/**
 * L03–L08, L15, L19: controller generation and run-lease fencing at the
 * storage layer — takeover increments generations, heartbeats never revive,
 * release is generation-scoped, and expired runs keep their recovery slot.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import type { ControllerLease } from "../../src/domain/types.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";

function boot(id: string): Engine {
  const e = new Engine(makeRuntimeConfig(mkdtempSync(join(tmpdir(), "rn-lf-"))), { silent: true, maxCycles: 1 });
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

function ctrl(campaignId: string, owner: string, generation: number): ControllerLease {
  return { campaign_id: campaignId, owner, generation };
}

test("L03: after a takeover the old generation cannot heartbeat, claim, or renew", () => {
  const e = boot("l03");
  const id = "l03";
  const g1 = e.storage.acquireControllerLock(id, "proc-a", 60_000);
  // simulate the old owner going silent: expire its lock, then B takes over
  e.storage.store.db.prepare("UPDATE controller_locks SET lease_until = 0 WHERE campaign_id = ?").run(id);
  const g2 = e.storage.acquireControllerLock(id, "proc-b", 60_000);
  assert.equal(g2.generation, g1.generation + 1);
  assert.equal(g2.takeover, true);
  // old generation heartbeat is rejected
  assert.equal(e.storage.heartbeatControllerLock(id, "proc-a", g1.generation, 60_000), false);
  // old generation cannot claim
  seedStep(e, id, "l03-fp");
  assert.equal(e.storage.claimNextStep(id, ctrl(id, "proc-a", g1.generation), 1), null);
  assert.equal(e.storage.claimDecide(id, ctrl(id, "proc-a", g1.generation)), null);
  // the run.lease_rejected events explain the refusals
  const events = e.storage.list("events", id).map((r) => String(r.type));
  assert.ok(events.includes("run.lease_rejected"));
  // the new generation claims fine
  const claimed = e.storage.claimNextStep(id, ctrl(id, "proc-b", g2.generation), 1);
  assert.ok(claimed);
  e.close();
});

test("L04: the same owner string re-acquiring after expiry gets a new generation", () => {
  const e = boot("l04");
  const id = "l04";
  const g1 = e.storage.acquireControllerLock(id, "same-owner", 60_000);
  e.storage.store.db.prepare("UPDATE controller_locks SET lease_until = 0 WHERE campaign_id = ?").run(id);
  const g2 = e.storage.acquireControllerLock(id, "same-owner", 60_000);
  assert.ok(g2.generation > g1.generation, "expired-then-reacquired means a new generation even for the same owner");
  assert.equal(e.storage.heartbeatControllerLock(id, "same-owner", g1.generation, 60_000), false, "the old generation is dead");
  e.close();
});

test("L05: release expires the row but never resets the generation", () => {
  const e = boot("l05");
  const id = "l05";
  const g1 = e.storage.acquireControllerLock(id, "a", 60_000);
  e.storage.releaseControllerLock(id, "a", g1.generation);
  const g2 = e.storage.acquireControllerLock(id, "b", 60_000);
  assert.equal(g2.generation, g1.generation + 1, "no delete+insert reset");
  e.storage.releaseControllerLock(id, "b", g2.generation);
  const g3 = e.storage.acquireControllerLock(id, "a", 60_000);
  assert.equal(g3.generation, g2.generation + 1);
  e.close();
});

test("L06: an old owner's release cannot touch the successor's lock", () => {
  const e = boot("l06");
  const id = "l06";
  const g1 = e.storage.acquireControllerLock(id, "old", 60_000);
  e.storage.store.db.prepare("UPDATE controller_locks SET lease_until = 0 WHERE campaign_id = ?").run(id);
  const g2 = e.storage.acquireControllerLock(id, "new", 60_000);
  // old owner's finally fires late with its stale generation
  e.storage.releaseControllerLock(id, "old", g1.generation);
  // the new lock is still valid
  assert.equal(e.storage.heartbeatControllerLock(id, "new", g2.generation, 60_000), true);
  e.close();
});

test("L07/L08: an expired run cannot heartbeat, keeps no slot once recovered, and a reclaim+capacity-1 reclaim stays at one run", () => {
  const e = boot("l078");
  const id = "l078";
  seedStep(e, id, "l078-a");
  seedStep(e, id, "l078-b");
  const acq = e.storage.acquireControllerLock(id, "proc", 60_000);
  const c = ctrl(id, "proc", acq.generation);
  const first = e.storage.claimNextStep(id, c, 1, 60_000)!;
  assert.ok(first);
  // capacity 1: a second claim is refused while the first is live
  assert.equal(e.storage.claimNextStep(id, c, 1, 60_000), null);
  // expire the run and the controller lease, then a new controller claims
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = ? WHERE id = ?").run(Date.now() - 1, first.run_id);
  // L07: the expired run's heartbeat is refused and does not extend anything
  const before = Number(e.storage.getRun(first.run_id).deadline_ms);
  const late = e.storage.heartbeatRun(c, { run_id: first.run_id, fence: first.fence }, Date.now() + 300_000);
  assert.ok(!late.renewed, "an expired run is never revived");
  assert.equal(Number(e.storage.getRun(first.run_id).deadline_ms), before);
  // L08: the next claim revokes the expired run and takes exactly its one slot
  const second = e.storage.claimNextStep(id, c, 1, 60_000);
  assert.ok(second, "the reclaimed slot is claimable (no unknown external calls)");
  assert.equal(e.storage.getRun(first.run_id).state, "lease_expired");
  assert.equal(e.storage.claimNextStep(id, c, 1, 60_000), null, "still capped at one");
  // the old run's heartbeat still fails after the reclaim
  const late2 = e.storage.heartbeatRun(c, { run_id: first.run_id, fence: first.fence }, Date.now() + 300_000);
  assert.ok(!late2.renewed);
  e.close();
});

test("L15: deadline == now is expired on every path", () => {
  const e = boot("l15");
  const id = "l15";
  seedStep(e, id, "l15-fp");
  const acq = e.storage.acquireControllerLock(id, "proc", 60_000);
  const c = ctrl(id, "proc", acq.generation);
  const run = e.storage.claimNextStep(id, c, 1, 60_000)!;
  const now = Date.now();
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = ? WHERE id = ?").run(now, run.run_id);
  // heartbeat: expired
  assert.ok(!e.storage.heartbeatRun(c, { run_id: run.run_id, fence: run.fence }, now + 60_000).renewed);
  // capacity: the expired run no longer counts as live (recovery slot needs an
  // unresolved invocation, which this run does not have)
  const second = e.storage.claimNextStep(id, c, 1, 60_000);
  assert.ok(second, "the boundary-expired run was revoked and its slot freed");
  e.close();
});

test("L19: a pre-v6 run without a generation is never a valid worker for any controller", () => {
  const e = boot("l19");
  const id = "l19";
  seedStep(e, id, "l19-fp");
  const acq = e.storage.acquireControllerLock(id, "proc", 60_000);
  const c = ctrl(id, "proc", acq.generation);
  const run = e.storage.claimNextStep(id, c, 1, 60_000)!;
  // downgrade the row to a pre-v6 shape
  e.storage.store.db.prepare("UPDATE task_runs SET controller_generation = NULL WHERE id = ?").run(run.run_id);
  const res = e.storage.heartbeatRun(c, { run_id: run.run_id, fence: run.fence }, Date.now() + 60_000);
  assert.ok(!res.renewed, "NULL generation matches no current generation");
  e.close();
});

test("L16: a stale heartbeat never shortens a newer deadline", () => {
  const e = boot("l16");
  const id = "l16";
  seedStep(e, id, "l16-fp");
  const acq = e.storage.acquireControllerLock(id, "proc", 60_000);
  const c = ctrl(id, "proc", acq.generation);
  const run = e.storage.claimNextStep(id, c, 1, 60_000)!;
  const extended = Date.now() + 3_600_000;
  const r1 = e.storage.heartbeatRun(c, { run_id: run.run_id, fence: run.fence }, extended);
  assert.ok(r1.renewed);
  assert.equal(Number(e.storage.getRun(run.run_id).deadline_ms), extended);
  const r2 = e.storage.heartbeatRun(c, { run_id: run.run_id, fence: run.fence }, Date.now() + 5_000);
  assert.ok(r2.renewed);
  assert.equal(Number(e.storage.getRun(run.run_id).deadline_ms), extended, "the later deadline stands");
  e.close();
});

test("decide and execute claims are mutually exclusive at the storage layer", () => {
  const e = boot("l14-mutex");
  const id = "l14-mutex";
  seedStep(e, id, "l14m-fp");
  const acq = e.storage.acquireControllerLock(id, "proc", 60_000);
  const c = ctrl(id, "proc", acq.generation);
  const decide = e.storage.claimDecide(id, c, 60_000);
  assert.ok(decide);
  assert.equal(e.storage.claimNextStep(id, c, 1, 60_000), null, "no execute while a decide is live");
  e.storage.finishRun(id, decide.run_id, {
    run_id: decide.run_id,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "done",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  assert.ok(e.storage.claimNextStep(id, c, 1, 60_000), "execute claims once the decide finished");
  assert.equal(e.storage.claimDecide(id, c, 60_000), null, "no decide while an execute is live");
  e.close();
});
