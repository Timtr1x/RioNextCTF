/**
 * S10–S15: model queue lifecycle — send counting, post-queue revalidation,
 * consumer-independent termination observation, exactly-once settlement.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import type { RunLease } from "../../src/domain/types.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { ModelGateway } from "../../src/gateway/gateways.ts";
import { InvocationBook } from "../../src/gateway/invocation.ts";
import { Semaphore } from "../../src/gateway/semaphore.ts";
import { EMPTY_USAGE, SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function boot(id: string): Engine {
  const e = new Engine(makeRuntimeConfig(mkdtempSync(join(tmpdir(), "rn-mlc-"))), { silent: true, maxCycles: 1 });
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
    controller_generation: null,
    continuation_of: null,
  };
}

function okMessage(totalTokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "scripted",
    model: "scripted",
    usage: { ...EMPTY_USAGE, totalTokens },
    stopReason: "stop",
    errorMessage: undefined,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** A stream whose termination the test controls by pushing the done event. */
function controllableStream(): { stream: AssistantMessageEventStream; finish: (tokens?: number) => void } {
  const stream = createAssistantMessageEventStream();
  return {
    stream,
    finish: (tokens = 5) => stream.push({ type: "done", reason: "stop", message: okMessage(tokens) }),
  };
}

function ctx(): { systemPrompt: string; messages: { role: "user"; content: string; timestamp: number }[] } {
  return { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
}

test("S10: a provider that throws before producing a stream frees the slot and settles exactly once", async () => {
  for (const mode of ["sync", "async"] as const) {
    const e = boot(`s10-${mode}`);
    const run = e.storage.claimDecideAsOwner(`s10-${mode}`, "t")!;
    const sem = new Semaphore(1);
    let calls = 0;
    const inner = () => {
      calls += 1;
      if (mode === "sync") throw new Error("boom-sync");
      return Promise.reject(new Error("boom-async"));
    };
    const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), inner as never, leaseFor(run, `s10-${mode}`), "m", "p", 16, { semaphore: sem });
    const s = await Promise.resolve(gw.stream(SCRIPTED_MODEL, ctx()));
    const r = (await s.result()) as { stopReason?: string; errorMessage?: string | null };
    assert.equal(r.stopReason, "error");
    assert.match(String(r.errorMessage), new RegExp(mode === "sync" ? "boom-sync" : "boom-async"));
    assert.equal(calls, 1);
    assert.equal(sem.active, 0, `slot returned after a ${mode} throw`);
    const snap = e.budget.snapshot(`s10-${mode}`);
    assert.equal(Number(snap.reserved_tokens), 0, "reservation released");
    assert.equal(Number(snap.spent_tokens), 0, "nothing was sent, nothing was spent");
    const invs = e.storage.list("invocations", `s10-${mode}`);
    assert.equal(invs.length, 1);
    assert.equal(invs[0]!.state, "failed_known");
    e.close();
  }
});

test("S11: a stream whose result rejects still frees the slot with no unhandled rejection", async () => {
  const e = boot("s11");
  const run = e.storage.claimDecideAsOwner("s11", "t")!;
  const sem = new Semaphore(1);
  const inner = () => ({ result: () => Promise.reject(new Error("transport exploded")) }) as unknown as AssistantMessageEventStream;
  const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), inner as never, leaseFor(run, "s11"), "m", "p", 16, { semaphore: sem });
  const s = await Promise.resolve(gw.stream(SCRIPTED_MODEL, ctx()));
  await assert.rejects(s.result(), /transport exploded/, "the consumer still sees the error");
  await tick();
  assert.equal(sem.active, 0, "slot freed on terminal rejection");
  const snap = e.budget.snapshot("s11");
  assert.equal(Number(snap.reserved_tokens), 0);
  assert.equal(Number(snap.spent_tokens), 16, "sent-but-unanswered is charged at the reserve, never zero");
  assert.equal(Number(snap.liability_tokens), 0);
  const inv = e.storage.list("invocations", "s11")[0]!;
  assert.equal(inv.state, "failed_known");
  e.close();
});

test("S12: the gateway observes termination even if nobody calls result()", async () => {
  const e = boot("s12");
  const run = e.storage.claimDecideAsOwner("s12", "t")!;
  const sem = new Semaphore(1);
  const ctl = controllableStream();
  const inner = () => ctl.stream;
  const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), inner as never, leaseFor(run, "s12"), "m", "p", 16, { semaphore: sem });
  await Promise.resolve(gw.stream(SCRIPTED_MODEL, ctx()));
  assert.equal(sem.active, 1, "slot held while the stream is live");
  ctl.finish(9);
  // no result() call at all — the gateway's own observer must settle
  for (let i = 0; i < 10 && (sem.active as number) !== 0; i += 1) await tick();
  assert.equal(sem.active, 0, "slot freed by the gateway observer");
  const snap = e.budget.snapshot("s12");
  assert.equal(Number(snap.reserved_tokens), 0);
  assert.equal(Number(snap.spent_tokens), 9);
  e.close();
});

test("S13: multiple consumers of result() settle the budget exactly once", async () => {
  const e = boot("s13");
  const run = e.storage.claimDecideAsOwner("s13", "t")!;
  const sem = new Semaphore(1);
  const inner = () => {
    const c = controllableStream();
    queueMicrotask(() => c.finish(18));
    return c.stream;
  };
  const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), inner as never, leaseFor(run, "s13"), "m", "p", 16, { semaphore: sem });
  const s = await Promise.resolve(gw.stream(SCRIPTED_MODEL, ctx()));
  const [r1, r2, r3] = await Promise.all([s.result(), s.result(), s.result()]);
  assert.equal((r1 as { usage: { totalTokens: number } }).usage.totalTokens, 18);
  assert.equal(r1, r2);
  assert.equal(r2, r3);
  await tick();
  const snap = e.budget.snapshot("s13");
  assert.equal(Number(snap.spent_tokens), 18, "settled once, not once per consumer");
  assert.equal(sem.active, 0);
  e.close();
});

test("S14: a campaign cancelled while the call queues never reaches the provider", async () => {
  const e = boot("s14");
  const run = e.storage.claimDecideAsOwner("s14", "t")!;
  const sem = new Semaphore(1);
  const blocker = await sem.acquire();
  let innerCalls = 0;
  const inner = () => {
    innerCalls += 1;
    const c = controllableStream();
    queueMicrotask(() => c.finish());
    return c.stream;
  };
  const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), inner as never, leaseFor(run, "s14"), "m", "p", 16, { semaphore: sem });
  const pending = Promise.resolve(gw.stream(SCRIPTED_MODEL, ctx()));
  for (let i = 0; i < 10 && sem.queued !== 1; i += 1) await tick();
  assert.equal(sem.queued, 1, "the call is queued behind the blocker");
  e.storage.setCampaignState("s14", "cancelled", { kind: "user", id: "t" });
  blocker.release();
  const s = await pending;
  const r = (await s.result()) as { stopReason?: string; errorMessage?: string | null };
  assert.equal(r.stopReason, "error");
  assert.match(String(r.errorMessage), /campaign cancelled/);
  assert.equal(innerCalls, 0, "provider was never called");
  assert.equal(gw.modelSends, 0, "no send was counted");
  assert.equal(sem.active, 0);
  const snap = e.budget.snapshot("s14");
  assert.equal(Number(snap.reserved_tokens), 0, "reservation released as never-sent");
  assert.equal(Number(snap.spent_tokens), 0);
  e.close();
});

test("S15: an unfinished stream keeps its slot — no early release on abandonment", async () => {
  const e = boot("s15");
  const run = e.storage.claimDecideAsOwner("s15", "t")!;
  const sem = new Semaphore(1);
  const ctl = controllableStream();
  const inner = () => ctl.stream;
  const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), inner as never, leaseFor(run, "s15"), "m", "p", 16, { semaphore: sem });
  await Promise.resolve(gw.stream(SCRIPTED_MODEL, ctx()));
  // The consumer walks away without result(); the transport is still open.
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(sem.active, 1, "slot stays held until the stream truly ends");
  assert.equal(Number(e.budget.snapshot("s15").reserved_tokens), 16, "reservation stays open");
  ctl.finish(4);
  for (let i = 0; i < 10 && (sem.active as number) !== 0; i += 1) await tick();
  assert.equal(sem.active, 0, "freed only at real termination");
  e.close();
});
