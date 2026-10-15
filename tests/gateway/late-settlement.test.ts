/**
 * P1-03/P1-04: a real late sendAsync return settles nothing twice; recovery
 * CAS keeps terminal states terminal against stale competing queries.
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
import { InvocationBook } from "../../src/gateway/invocation.ts";
import {
  FileEffectAdapter,
  type EffectAdapter,
  type ExecutionDescriptor,
  type ExecutionEvidence,
} from "../../src/tools/effect-adapter.ts";

function boot(id: string): Engine {
  const e = new Engine(makeRuntimeConfig(mkdtempSync(join(tmpdir(), "rn-late-"))), { silent: true, maxCycles: 1 });
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

function crashAndReclaim(e: Engine, id: string): void {
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = 0 WHERE campaign_id = ?").run(id);
  e.storage.store.db.prepare("UPDATE controller_locks SET lease_until = 0 WHERE campaign_id = ?").run(id);
  e.storage.recoverStaleRuns(id);
}

/** File effect that lands immediately, with a gateable return (crash window). */
class DeferredFileAdapter implements EffectAdapter {
  gate: Promise<void> | null = null;
  readonly inner: FileEffectAdapter;
  constructor(root: string) {
    this.inner = new FileEffectAdapter(root);
  }
  describe(invocationId: string): ExecutionDescriptor {
    return this.inner.describe(invocationId);
  }
  send(invocationId: string, payload: unknown): { execution_id: string } {
    return this.inner.send(invocationId, payload);
  }
  async sendAsync(invocationId: string, payload: unknown): Promise<{ execution_id: string }> {
    const r = this.inner.send(invocationId, payload); // the effect happens now
    if (this.gate) await this.gate; // the receipt comes back after the crash
    return r;
  }
  query(executionId: string): "unknown" | "completed" | "failed" {
    return this.inner.query(executionId);
  }
  queryEvidence(executionId: string): ExecutionEvidence {
    return this.inner.queryEvidence(executionId);
  }
  sendCount(): number {
    return this.inner.sendCount();
  }
}

test("P1-03: effect landed, recover reconciled, then the real sendAsync returned — settled exactly once", async () => {
  const e = boot("late1");
  const lease = leaseFor(e, "late1");
  const adapter = new DeferredFileAdapter(join(e.config.data_dir, "fx"));
  let release!: () => void;
  adapter.gate = new Promise<void>((r) => (release = r));
  const book = new InvocationBook(e.storage);
  const gate = new DispatchGate(e.storage, e.budget, book, adapter);
  const pending = gate.dispatchAsync({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  // the effect has landed; the receipt is still hanging
  for (let i = 0; i < 20 && adapter.sendCount() !== 1; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(adapter.sendCount(), 1);
  const invId = book.nonTerminal("late1")[0]!.id as string;
  crashAndReclaim(e, "late1");
  const rec = await gate.recover("late1");
  assert.equal(rec.reconciled, 1);
  assert.equal(Number(e.budget.snapshot("late1").spent_calls), 1);
  // now the original sendAsync returns and afterSend runs late
  release();
  const res = await pending;
  assert.equal(res.status, "sent");
  assert.equal(res.late, true, "the late answer only annotated");
  const after = e.budget.snapshot("late1");
  assert.equal(Number(after.spent_calls), 1, "no second settlement");
  assert.equal(String(book.get(invId).state), "reconciled", "terminal state stands");
  e.close();
});

test("P1-03: a late adapter error after reconciliation is archival, never a second liability flip", async () => {
  const e = boot("late2");
  const lease = leaseFor(e, "late2");
  const adapter = new DeferredFileAdapter(join(e.config.data_dir, "fx"));
  const book = new InvocationBook(e.storage);
  const gate = new DispatchGate(e.storage, e.budget, book, adapter);
  const invId = gate.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  adapter.send(invId, { op: "touch" });
  crashAndReclaim(e, "late2");
  await gate.recover("late2");
  const settled = e.budget.snapshot("late2");
  // the adapter now reports a late failure for the same invocation
  const failed = gate.sendFailed(
    { lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true },
    invId,
    new Error("late transport error"),
  );
  assert.equal(failed.reason, "already_settled");
  const after = e.budget.snapshot("late2");
  assert.equal(Number(after.spent_calls), Number(settled.spent_calls));
  assert.equal(Number(after.liability_calls), Number(settled.liability_calls));
  assert.equal(String(book.get(invId).state), "reconciled");
  e.close();
});

/** Evidence adapter whose answers the test scripts per handle. */
class ScriptedEvidenceAdapter implements EffectAdapter {
  evidence = new Map<string, ExecutionEvidence | Promise<ExecutionEvidence>>();
  describe(invocationId: string): ExecutionDescriptor {
    return { handle: `stub_${invocationId}`, queryable: true, replaySafe: false };
  }
  send(invocationId: string): { execution_id: string } {
    return { execution_id: `stub_${invocationId}` };
  }
  sendAsync(invocationId: string): Promise<{ execution_id: string }> {
    return Promise.resolve({ execution_id: `stub_${invocationId}` });
  }
  query(): "unknown" {
    return "unknown";
  }
  async queryEvidence(handle: string): Promise<ExecutionEvidence> {
    const v = this.evidence.get(handle) ?? { status: "unknown", reason: "none" };
    return await v;
  }
  sendCount(): number {
    return 0;
  }
}

test("P1-04: a stale unknown query can never roll back a completed reconciliation", async () => {
  const e = boot("race1");
  const lease = leaseFor(e, "race1");
  const adapterA = new ScriptedEvidenceAdapter();
  const adapterB = new ScriptedEvidenceAdapter();
  const gateA = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapterA);
  const gateB = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapterB);
  const invId = gateA.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  crashAndReclaim(e, "race1");
  const handle = `stub_${invId}`;
  let resolveA!: (v: ExecutionEvidence) => void;
  let resolveB!: (v: ExecutionEvidence) => void;
  adapterA.evidence.set(handle, new Promise((r) => (resolveA = r)));
  adapterB.evidence.set(handle, new Promise((r) => (resolveB = r)));
  const recA = gateA.recover("race1");
  const recB = gateB.recover("race1");
  // A answers completed first; B answers unknown afterwards
  resolveA({ status: "completed", evidenceRef: "a-log" });
  await recA;
  resolveB({ status: "unknown", reason: "timeout" });
  await recB;
  const row = new InvocationBook(e.storage).get(invId);
  assert.equal(row.state, "reconciled", "the terminal state was not rolled back");
  const snap = e.budget.snapshot("race1");
  assert.equal(Number(snap.spent_calls), 1, "settled once");
  assert.equal(Number(snap.liability_calls), 0);
  e.close();
});

test("P1-04: completed beats failed on first-writer-wins; the loser is skipped", async () => {
  const e = boot("race2");
  const lease = leaseFor(e, "race2");
  const adapterA = new ScriptedEvidenceAdapter();
  const adapterB = new ScriptedEvidenceAdapter();
  const gateA = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapterA);
  const gateB = new DispatchGate(e.storage, e.budget, new InvocationBook(e.storage), adapterB);
  const invId = gateA.markDispatchingOnly({ lease, purpose: "fx", payload: { op: "touch" }, effect: "external_write", envTool: true });
  crashAndReclaim(e, "race2");
  const handle = `stub_${invId}`;
  let resolveA!: (v: ExecutionEvidence) => void;
  let resolveB!: (v: ExecutionEvidence) => void;
  adapterA.evidence.set(handle, new Promise((r) => (resolveA = r)));
  adapterB.evidence.set(handle, new Promise((r) => (resolveB = r)));
  const recA = gateA.recover("race2");
  const recB = gateB.recover("race2");
  resolveA({ status: "failed", evidenceRef: "exit-137", effect: "possible" });
  await recA;
  resolveB({ status: "completed", evidenceRef: "b-log" });
  await recB;
  const row = new InvocationBook(e.storage).get(invId);
  assert.equal(row.state, "failed_known", "the first terminal answer won");
  assert.match(String(row.error_json), /effect:possible/);
  e.close();
});
