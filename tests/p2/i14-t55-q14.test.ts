import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { checkLockedDependencyIntegrity, sequentialToolExecutionRequired } from "../../src/contracts/integrity.ts";
import { Engine } from "../../src/controller/engine.ts";
import { buildContextPack } from "../../src/context/builder.ts";
import { ModelGateway } from "../../src/gateway/gateways.ts";
import { InvocationBook } from "../../src/gateway/invocation.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";
import type { FetchFn } from "../../src/provider/client.ts";
import { createCataloguedProviderStream } from "../../src/provider/stream.ts";
import { PiWorker } from "../../src/runtime/pi/factory.ts";
import { SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import type { RunLease } from "../../src/domain/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-p2-"));
}

function boot(dir: string, id: string): Engine {
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec(id);
  e.createCampaign(spec);
  e.storage.setCampaignState(spec.campaign_id, "active", { kind: "user", id: "t" });
  return e;
}

function leaseFor(e: Engine, campaignId: string): RunLease {
  const run = e.storage.claimDecide(campaignId, "owner-a")!;
  const root = String(e.storage.list("goals", campaignId)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: campaignId,
    producer_id: "p",
    submission_id: `st-${Date.now()}-${Math.random()}`,
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
  const claimed = e.storage.claimNextStep(campaignId, "owner-a", 1)!;
  return {
    run_id: claimed.run_id,
    campaign_id: campaignId,
    step_id: claimed.step_id,
    mode: "execute",
    kind: claimed.kind,
    attempt_no: claimed.attempt_no,
    fence: claimed.fence,
    cancel_epoch: e.storage.getCampaign(campaignId).cancel_epoch,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "owner-a",
    continuation_of: null,
  };
}

function ctx(): Context {
  return {
    systemPrompt: "sys",
    messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
  };
}

function catalogOn(dir: string): { catalog: ProviderCatalog; providerId: string } {
  const catalog = new ProviderCatalog(dir);
  const rec = catalog.addProvider({
    display_name: "fake-upstream",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "http://127.0.0.1:9/v1/chat/completions",
    api_key: "not-a-live-key",
  });
  return { catalog, providerId: rec.id };
}

async function throughGateway(
  e: Engine,
  lease: RunLease,
  fetchFn: FetchFn,
  extra?: {
    maxRetries?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    providerId?: string;
    catalog?: ProviderCatalog;
    retryDelayMs?: (n: number) => number;
  },
) {
  const { catalog, providerId } = extra?.catalog
    ? { catalog: extra.catalog, providerId: extra.providerId! }
    : catalogOn(join(e.config.data_dir, "prov"));
  const { stream, stats } = createCataloguedProviderStream({
    catalog,
    providerId,
    modelName: "fake-model",
    fetchFn,
    maxRetries: extra?.maxRetries ?? 0,
    timeoutMs: extra?.timeoutMs ?? 200,
    // Tests never wait out a real backoff unless they ask for one.
    retryDelayMs: extra?.retryDelayMs ?? (() => 0),
  });
  const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), stream, lease, "fake-model", providerId);
  const s = await Promise.resolve(gw.stream(SCRIPTED_MODEL, ctx(), { signal: extra?.signal, timeoutMs: extra?.timeoutMs }));
  const msg = await s.result();
  return { gw, stats, msg, inv: e.invocations };
}

test("I14 catalogued provider error stream through ModelGateway", async () => {
  const dir = tmp();
  const e = boot(dir, "i14e");
  const lease = leaseFor(e, "i14e");
  const { msg, gw } = await throughGateway(e, lease, async () => new Response("nope", { status: 500 }));
  assert.equal(msg.stopReason, "error");
  assert.ok(msg.errorMessage);
  assert.equal(gw.modelSends, 1);
  e.close();
});

test("I14 catalogued provider usage recorded through ModelGateway", async () => {
  const dir = tmp();
  const e = boot(dir, "i14u");
  const lease = leaseFor(e, "i14u");
  const { msg } = await throughGateway(e, lease, async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello from catalogued" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  assert.equal(msg.stopReason, "stop");
  assert.equal(msg.usage.totalTokens, 18);
  const rows = e.storage.list("invocations", "i14u");
  const modelInv = rows.find((r) => r.kind === "model");
  assert.ok(modelInv);
  assert.equal(Number(modelInv.actual_tokens), 18);
  e.close();
});

test("I14 catalogued provider cancel through ModelGateway", async () => {
  const dir = tmp();
  const e = boot(dir, "i14c");
  const lease = leaseFor(e, "i14c");
  const ac = new AbortController();
  ac.abort();
  const { msg } = await throughGateway(e, lease, async () => new Response("should-not-run", { status: 200 }), { signal: ac.signal });
  assert.equal(msg.stopReason, "aborted");
  e.close();
});

test("I14 catalogued provider timeout through ModelGateway", async () => {
  const dir = tmp();
  const e = boot(dir, "i14t");
  const lease = leaseFor(e, "i14t");
  const hung: FetchFn = async (_url, init) => {
    await new Promise<never>((_, rej) => {
      const timer = setTimeout(() => {
        const err = new Error("hung");
        err.name = "AbortError";
        rej(err);
      }, 30_000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        rej(err);
      });
    });
    throw new Error("unreachable");
  };
  const { msg } = await throughGateway(e, lease, hung, { timeoutMs: 30 });
  assert.equal(msg.stopReason, "aborted");
  e.close();
});

test("I14 catalogued provider retry cap through ModelGateway", async () => {
  const dir = tmp();
  const e = boot(dir, "i14r");
  const lease = leaseFor(e, "i14r");
  let fetches = 0;
  const failing: FetchFn = async () => {
    fetches += 1;
    return new Response("down", { status: 503 });
  };
  const { msg, stats } = await throughGateway(e, lease, failing, { maxRetries: 2 });
  assert.equal(msg.stopReason, "error");
  assert.equal(stats.attempts, 3);
  assert.equal(fetches, 3);
  assert.equal(stats.lastError, "http_503");
  e.close();
});

test("I14 transient 500s are retried and a later success wins", async () => {
  const dir = tmp();
  const e = boot(dir, "i14ok");
  const lease = leaseFor(e, "i14ok");
  let fetches = 0;
  const flaky: FetchFn = async () => {
    fetches += 1;
    if (fetches <= 2) return new Response("upstream hiccup", { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const { msg, stats } = await throughGateway(e, lease, flaky, { maxRetries: 2 });
  assert.equal(msg.stopReason, "stop");
  assert.equal(fetches, 3, "two failures then one success");
  assert.equal(stats.attempts, 3);
  assert.equal(stats.lastError, null, "a recovered stream records no failure");
  e.close();
});

test("I14 the retry backoff is honoured between attempts", async () => {
  const dir = tmp();
  const e = boot(dir, "i14bo");
  const lease = leaseFor(e, "i14bo");
  const delays: number[] = [];
  const { stats } = await throughGateway(e, lease, async () => new Response("down", { status: 429 }), {
    maxRetries: 2,
    retryDelayMs: (n) => {
      delays.push(n);
      return 0;
    },
  });
  assert.equal(stats.attempts, 3);
  assert.deepEqual(delays, [1, 2], "backoff runs before attempt 2 and 3");
  assert.equal(stats.lastError, "http_429");
  e.close();
});

test("I14 a settled 4xx answer is not retried", async () => {
  const dir = tmp();
  const e = boot(dir, "i14f4");
  const lease = leaseFor(e, "i14f4");
  let fetches = 0;
  const { msg, stats } = await throughGateway(
    e,
    lease,
    async () => {
      fetches += 1;
      return new Response("bad request", { status: 400 });
    },
    { maxRetries: 2 },
  );
  assert.equal(msg.stopReason, "error");
  assert.equal(fetches, 1, "400 is a verdict, not a hiccup");
  assert.equal(stats.attempts, 1);
  assert.equal(stats.lastError, "http_400");
  e.close();
});

test("T55 sequential toolExecution and locked Pi integrity", async () => {
  const check = checkLockedDependencyIntegrity(process.cwd());
  assert.equal(check.ok, true, check.failures.join("; "));
  const dir = tmp();
  const e = boot(dir, "t55");
  const lease = leaseFor(e, "t55");
  const pack = buildContextPack(e.storage, lease);
  const worker = e.factory.create("execute", lease.run_id) as PiWorker;
  const ac = new AbortController();
  await worker.start(lease, pack, ac.signal);
  assert.equal(sequentialToolExecutionRequired(worker.toolExecution), true);
  assert.equal(worker.agent?.toolExecution, "sequential");
  worker.abort();
  await worker.settle();
  e.close();
});

test("Q14 default npm test includes P1 recovery and safety tests", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts?: { test?: string } };
  const testScript = pkg.scripts?.test ?? "";
  assert.match(testScript, /dist\/tests\/\*\*\/\*\.test\.js/);
  assert.equal(testScript.includes("--test-name-pattern"), false);
  const p1 = readFileSync(join(process.cwd(), "tests/p1/t25-t54.test.ts"), "utf8");
  assert.match(p1, /test\("T25 /);
  assert.match(p1, /test\("T37 /);
  assert.match(p1, /test\("T43 /);
  assert.match(p1, /test\("T51 /);
  const p2 = readFileSync(join(process.cwd(), "tests/p2/i14-t55-q14.test.ts"), "utf8");
  assert.match(p2, /test\("I14 /);
  assert.match(p2, /test\("T55 /);
});
