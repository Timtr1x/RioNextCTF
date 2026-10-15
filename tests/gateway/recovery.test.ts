/**
 * E01–E14, E18–E20: external-call recovery — persisted handles, the decision
 * table, idempotent budget reconciliation, no never_sent without proof.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitCompletion, enterClosing } from "../../src/controller/close.ts";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import type { RunLease } from "../../src/domain/types.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { DispatchGate } from "../../src/gateway/dispatch.ts";
import { InvocationBook } from "../../src/gateway/invocation.ts";
import {
  FileEffectAdapter,
  type EffectAdapter,
  type ExecutionDescriptor,
  type ExecutionEvidence,
} from "../../src/tools/effect-adapter.ts";

function boot(dir: string, id: string): Engine {
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  e.createCampaign(loadDemoSpec(id));
  e.storage.setCampaignState(id, "active", { kind: "user", id: "t" });
  return e;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-rec-"));
}

function leaseFor(e: Engine, campaignId: string): RunLease {
  const run = e.storage.claimDecideAsOwner(campaignId, "owner-a")!;
  const root = String(e.storage.list("goals", campaignId)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: campaignId,
    producer_id: "p",
    submission_id: `st-${Math.random()}`,
    run_id: run.run_id,
    question: "do thing",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "x",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: `fp-${Math.random()}`,
    reopen_rule: { kind: "never" },
  });
  e.storage.finishRun(campaignId, run.run_id, {
    run_id: run.run_id,
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
  const claimed = e.storage.claimNextStepAsOwner(campaignId, "owner-a", 1)!;
  return {
    run_id: claimed.run_id,
    campaign_id: campaignId,
    step_id: claimed.step_id,
    mode: "execute",
    kind: claimed.kind,
    attempt_no: claimed.attempt_no,
    fence: claimed.fence,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "owner-a",
    controller_generation: claimed.controller_generation,
    continuation_of: null,
  };
}

/** Expire and revoke every run/lock: the crashed-driver precondition. */
function crashAndReclaim(e: Engine, campaignId: string): void {
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = 0 WHERE campaign_id = ?").run(campaignId);
  e.storage.store.db.prepare("UPDATE controller_locks SET lease_until = 0 WHERE campaign_id = ?").run(campaignId);
  e.storage.recoverStaleRuns(campaignId);
}

/** A stub adapter whose evidence the test controls per handle. */
class StubAdapter implements EffectAdapter {
  sends: string[] = [];
  evidence = new Map<string, ExecutionEvidence>();
  describe(invocationId: string): ExecutionDescriptor {
    return { handle: `stub_${invocationId}`, queryable: true, replaySafe: false };
  }
  send(invocationId: string): { execution_id: string } {
    this.sends.push(invocationId);
    return { execution_id: `stub_${invocationId}` };
  }
  sendAsync(invocationId: string): Promise<{ execution_id: string }> {
    this.sends.push(invocationId);
    return Promise.resolve({ execution_id: `stub_${invocationId}` });
  }
  query(): "unknown" {
    return "unknown";
  }
  queryEvidence(handle: string): ExecutionEvidence {
    return this.evidence.get(handle) ?? { status: "unknown", reason: "no_record" };
  }
  sendCount(): number {
    return this.sends.length;
  }
}

test("E01: the effect landed but no receipt was written — the persisted handle finds it, no never_sent, no resend", async () => {
  const dir = tmp();
  const e = boot(dir, "e01");
  const lease = leaseFor(e, "e01");
  const adapter = new FileEffectAdapter(join(dir, "fx"));
  const gate = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapter);
  // permit commits (handle persisted), the adapter performs the effect, and the
  // process dies before afterSend writes external_id.
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  adapter.send(invId, { op: "touch" }); // the effect happens; the receipt write never does
  const before = e.budget.snapshot("e01");
  e.close();
  const e2 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1, effectAdapter: adapter });
  crashAndReclaim(e2, "e01");
  const gate2 = new DispatchGate(e2.storage, e2.budget, new InvocationBook(e2.storage), adapter);
  const rec = await gate2.recover("e01");
  assert.equal(rec.reconciled, 1, "the handle found the landed effect");
  assert.equal(adapter.sendCount(), 1, "nothing was resent");
  const invRow = e2.invocations.get(invId);
  assert.equal(invRow.state, "reconciled");
  assert.equal(invRow.external_id, null, "no receipt was ever written; the handle sufficed");
  const after = e2.budget.snapshot("e01");
  assert.equal(Number(after.reserved_calls), 0);
  assert.equal(Number(after.liability_calls), 0);
  assert.equal(Number(after.spent_calls), Number(before.spent_calls) + 1);
  e2.close();
});

test("E02: an unqueryable unknown stays uncertain across ten recoveries, locks and liability intact", async () => {
  const dir = tmp();
  const e = boot(dir, "e02");
  const lease = leaseFor(e, "e02");
  const adapter = new StubAdapter();
  const gate = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  crashAndReclaim(e, "e02");
  for (let i = 0; i < 10; i += 1) {
    const rec = await gate.recover("e02");
    assert.equal(rec.reconciled, 0, `round ${i}: nothing resolved without evidence`);
  }
  assert.equal(String(e.invocations.get(invId).state), "uncertain");
  assert.equal(adapter.sendCount(), 0, "never resent");
  const snap = e.budget.snapshot("e02");
  assert.equal(Number(snap.liability_calls), 1, "the liability is recorded exactly once");
  // the recovery events dedupe instead of flooding the log
  const events = e.storage.list("events", "e02").filter((r) => String(r.type) === "invocation.uncertain");
  assert.ok(events.length <= 2, `deduped events, got ${events.length}`);
  e.close();
});

test("E04: permit committed, adapter never called — no positive not_started proof, stays uncertain", async () => {
  const dir = tmp();
  const e = boot(dir, "e04");
  const lease = leaseFor(e, "e04");
  const adapter = new FileEffectAdapter(join(dir, "fx"));
  const gate = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  crashAndReclaim(e, "e04");
  const rec = await gate.recover("e04");
  assert.equal(rec.reconciled, 0, "a missing record is not proof of not_started");
  assert.equal(String(e.invocations.get(invId).state), "uncertain");
  e.close();
});

test("E06/E18: afterSend persisted, crash before settle — restart settles once across repeated recoveries", async () => {
  const dir = tmp();
  const e = boot(dir, "e06");
  const lease = leaseFor(e, "e06");
  const adapter = new FileEffectAdapter(join(dir, "fx"));
  const book = new InvocationBook(e.storage);
  const gate = new DispatchGate(e.storage, e.budget, book, adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  const sent = adapter.send(invId, { op: "touch" });
  book.setExternalId(invId, sent.execution_id);
  // crash before the settle write
  crashAndReclaim(e, "e06");
  const before = e.budget.snapshot("e06");
  const rec1 = await gate.recover("e06");
  assert.equal(rec1.reconciled, 1);
  const rec2 = await gate.recover("e06");
  assert.equal(rec2.reconciled, 0, "a terminal invocation is not settled twice");
  const after = e.budget.snapshot("e06");
  assert.equal(Number(after.spent_calls), Number(before.spent_calls) + 1, "settled exactly once");
  assert.equal(Number(after.liability_calls), 0);
  e.close();
});

test("E07: two recoveries racing one invocation settle it once", async () => {
  const dir = tmp();
  const e = boot(dir, "e07");
  const lease = leaseFor(e, "e07");
  const adapter = new FileEffectAdapter(join(dir, "fx"));
  const book = new InvocationBook(e.storage);
  const gate = new DispatchGate(e.storage, e.budget, book, adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  adapter.send(invId, { op: "touch" });
  crashAndReclaim(e, "e07");
  const [r1, r2] = await Promise.all([gate.recover("e07"), gate.recover("e07")]);
  assert.equal(r1.reconciled + r2.reconciled >= 1, true);
  const snap = e.budget.snapshot("e07");
  assert.equal(Number(snap.spent_calls), 1, "one settlement total");
  assert.equal(Number(snap.liability_calls), 0);
  e.close();
});

test("E08: a late callback after terminal recovery only annotates, never double-settles", async () => {
  const dir = tmp();
  const e = boot(dir, "e08");
  const lease = leaseFor(e, "e08");
  const adapter = new FileEffectAdapter(join(dir, "fx"));
  const book = new InvocationBook(e.storage);
  const gate = new DispatchGate(e.storage, e.budget, book, adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  adapter.send(invId, { op: "touch" });
  crashAndReclaim(e, "e08");
  await gate.recover("e08");
  const settled = e.budget.snapshot("e08");
  gate.archiveLateResult("e08", invId, { note: "the worker finally answered" });
  const after = e.budget.snapshot("e08");
  assert.deepEqual(
    { spent: Number(after.spent_calls), liability: Number(after.liability_calls) },
    { spent: Number(settled.spent_calls), liability: Number(settled.liability_calls) },
    "budget untouched by the late callback",
  );
  assert.equal(String(e.invocations.get(invId).state), "reconciled");
  e.close();
});

test("E09: a corrupt record keeps the invocation uncertain", async () => {
  const dir = tmp();
  const e = boot(dir, "e09");
  const lease = leaseFor(e, "e09");
  const adapter = new FileEffectAdapter(join(dir, "fx"));
  const gate = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  // a torn write: the record exists but does not parse
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "fx"), { recursive: true });
  writeFileSync(join(dir, "fx", `ex_${invId}.json`), "{not json");
  crashAndReclaim(e, "e09");
  const rec = await gate.recover("e09");
  assert.equal(rec.reconciled, 0);
  assert.equal(String(e.invocations.get(invId).state), "uncertain");
  e.close();
});

test("E10: positive not_started proof releases only when the send right is revoked", async () => {
  const dir = tmp();
  const e = boot(dir, "e10");
  const lease = leaseFor(e, "e10");
  const adapter = new StubAdapter();
  const gate = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  adapter.evidence.set(`stub_${invId}`, { status: "not_started", evidenceRef: "registry-empty" });
  // run still live: proof alone is not enough, the sender may still fire
  const recLive = await gate.recover("e10");
  assert.equal(recLive.reconciled, 0);
  assert.equal(String(e.invocations.get(invId).state), "uncertain");
  // run revoked: released as provably never sent
  crashAndReclaim(e, "e10");
  const recDead = await gate.recover("e10");
  assert.equal(recDead.reconciled, 1);
  assert.equal(String(e.invocations.get(invId).state), "failed_known");
  assert.match(String(e.invocations.get(invId).error_json ?? ""), /not_dispatched/);
  const snap = e.budget.snapshot("e10");
  assert.equal(Number(snap.liability_calls), 0);
  assert.equal(Number(snap.spent_calls), 0, "never sent, never spent");
  e.close();
});

test("E11: a failed execution with possible earlier effects is not written as zero-effect", async () => {
  const dir = tmp();
  const e = boot(dir, "e11");
  const lease = leaseFor(e, "e11");
  const adapter = new StubAdapter();
  const gate = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  adapter.evidence.set(`stub_${invId}`, { status: "failed", evidenceRef: "log:exit-137", effect: "possible" });
  crashAndReclaim(e, "e11");
  const rec = await gate.recover("e11");
  assert.equal(rec.reconciled, 1);
  const row = e.invocations.get(invId);
  assert.equal(row.state, "failed_known");
  assert.match(String(row.error_json), /effect:possible/, "the effect note survives");
  e.close();
});

test("E12: an orphaned model call without usage is charged at its reserve, not zero", async () => {
  const dir = tmp();
  const e = boot(dir, "e12");
  const lease = leaseFor(e, "e12");
  const book = new InvocationBook(e.storage);
  const inv = book.prepare({
    campaign_id: "e12",
    run_id: lease.run_id,
    kind: "model",
    purpose: "execute",
    fence: lease.fence,
    cancel_epoch: 0,
    reserved_calls: 1,
    reserved_tokens: 500,
  });
  e.budget.reserve("e12", inv.id, 1, 500, 0);
  book.mark(inv.id, "dispatching");
  book.mark(inv.id, "running");
  crashAndReclaim(e, "e12");
  const gate = new DispatchGate(e.storage, e.budget, book, new StubAdapter());
  await gate.recover("e12");
  const snap = e.budget.snapshot("e12");
  assert.equal(Number(snap.spent_tokens), 500, "missing usage is settled at the reserve, not zero");
  assert.equal(Number(snap.liability_tokens), 0);
  assert.equal(String(book.get(inv.id).state), "failed_known");
  e.close();
});

test("E13: the file adapter is idempotent per invocation across replay and restart", () => {
  const dir = tmp();
  const adapter = new FileEffectAdapter(join(dir, "fx"));
  const first = adapter.send("inv-x", { op: "touch" });
  const again = adapter.send("inv-x", { op: "touch" });
  assert.equal(again.execution_id, first.execution_id);
  assert.equal(adapter.sendCount(), 1, "replay does not double the effect count");
  // a new adapter over the same root (restart) still dedupes
  const adapter2 = new FileEffectAdapter(join(dir, "fx"));
  adapter2.send("inv-x", { op: "touch" });
  assert.equal(adapter2.sendCount(), 1);
});

test("E14: a non-idempotent adapter with unknown evidence is never auto-retried", async () => {
  const dir = tmp();
  const e = boot(dir, "e14");
  const lease = leaseFor(e, "e14");
  const adapter = new StubAdapter();
  const gate = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapter);
  gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  crashAndReclaim(e, "e14");
  await gate.recover("e14");
  await gate.recover("e14");
  assert.equal(adapter.sendCount(), 0, "recovery never resends");
  e.close();
});

test("E19: an unresolved invocation blocks ordinary close and names itself", async () => {
  const dir = tmp();
  const e = boot(dir, "e19");
  const lease = leaseFor(e, "e19");
  const adapter = new StubAdapter();
  const gate = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  crashAndReclaim(e, "e19");
  await gate.recover("e19");
  const { H } = enterClosing(e, "e19");
  const committed = commitCompletion(e, "e19", H);
  assert.equal(committed.ok, false);
  if (!committed.ok) {
    assert.match(committed.reason, /uncertain_invocations:/);
    assert.ok(committed.reason.includes(invId), "the blocking invocation is named");
  }
  e.close();
});

test("E20: trusted adjudication records actor and basis; acknowledged_unknown never becomes never_sent", async () => {
  const dir = tmp();
  const e = boot(dir, "e20");
  const lease = leaseFor(e, "e20");
  const adapter = new StubAdapter();
  const gate = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  crashAndReclaim(e, "e20");
  await gate.recover("e20");
  // acknowledged_unknown: stays uncertain, blocks close, audit event written
  const ack = e.adjudicate("e20", invId, "acknowledged_unknown", "operator reviewed; container logs lost");
  assert.equal(ack.state, "uncertain");
  const events = e.storage.list("events", "e20").filter((r) => String(r.type) === "invocation.reconciled");
  assert.equal(events.length, 1);
  assert.match(JSON.stringify(events[0]), /acknowledged_unknown/);
  // then real evidence arrives: confirmed_completed settles it
  const done = e.adjudicate("e20", invId, "confirmed_completed", "target log confirms");
  assert.equal(done.state, "reconciled");
  const snap = e.budget.snapshot("e20");
  assert.equal(Number(snap.spent_calls), 1);
  // a second adjudication is a no-op
  const again = e.adjudicate("e20", invId, "confirmed_not_sent", "late doubt");
  assert.equal(again.state, "reconciled");
  assert.equal(Number(e.budget.snapshot("e20").spent_calls), 1);
  e.close();
});
