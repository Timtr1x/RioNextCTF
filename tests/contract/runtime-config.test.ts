/**
 * U01–U12: config threading — one resolution rule across CLI, Web and Contest;
 * persisted request vs host limit vs effective value visible in status.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig, parseWorkersFlag, resolveRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { EngineRunnerFactory } from "../../src/contest/runner.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";
import type { ContestQuestion } from "../../src/contest/api.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { EngineHost } from "../../src/web/engine-host.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-ucfg-"));
}

test("U01: no workers anywhere keeps the single-worker default", () => {
  const dir = tmp();
  const cfg = resolveRuntimeConfig(dir, {}, {});
  assert.equal(cfg.max_concurrent_execute, 1);
  assert.equal(cfg.max_inflight_model_calls, 8);
  const e = new Engine(cfg, { silent: true, maxCycles: 1 });
  e.createCampaign(loadDemoSpec("u01"));
  const st = e.status("u01");
  const cap = st.execution_capacity as { requested_workers: number; effective_workers: number; runtime_limit_per_campaign: number };
  assert.equal(cap.requested_workers, 1);
  assert.equal(cap.effective_workers, 1);
  assert.equal(cap.runtime_limit_per_campaign, 1);
  e.close();
});

test("U03: request 2 with host limit 1 shows effective 1 and the runtime limit", () => {
  const dir = tmp();
  const cfg = resolveRuntimeConfig(dir, {}, {});
  const e = new Engine(cfg, { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec("u03");
  spec.execution_policy = { max_execute_workers: 2 };
  e.createCampaign(spec);
  const cap = e.status("u03").execution_capacity as { requested_workers: number; effective_workers: number; runtime_limit_per_campaign: number };
  assert.equal(cap.requested_workers, 2);
  assert.equal(cap.runtime_limit_per_campaign, 1);
  assert.equal(cap.effective_workers, 1, "requested 2, effective 1, host-limited");
  e.close();
});

test("U03b: host limit 2 plus request 2 yields effective 2", () => {
  const dir = tmp();
  const cfg = resolveRuntimeConfig(dir, { "max-concurrent-execute": "2" }, {});
  const e = new Engine(cfg, { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec("u03b");
  spec.execution_policy = { max_execute_workers: 2 };
  e.createCampaign(spec);
  const cap = e.status("u03b").execution_capacity as { requested_workers: number; effective_workers: number };
  assert.equal(cap.effective_workers, 2);
  e.close();
});

test("U04: the workers request persists across a process restart", () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec("u04");
  spec.execution_policy = { max_execute_workers: 2 };
  e.createCampaign(spec);
  e.close();
  const e2 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const cap = e2.status("u04").execution_capacity as { requested_workers: number };
  assert.equal(cap.requested_workers, 2, "the persisted spec drives the projection");
  e2.close();
});

test("U05/U06: the web EngineHost resolves runtime.json and keeps it across a service restart", () => {
  const dir = tmp();
  writeFileSync(join(dir, "runtime.json"), JSON.stringify({ max_concurrent_execute: 2, max_inflight_model_calls: 4 }));
  const host = new EngineHost(dir);
  assert.equal(host.control.config.max_concurrent_execute, 2);
  assert.equal(host.control.config.max_inflight_model_calls, 4);
  host.close();
  const host2 = new EngineHost(dir);
  assert.equal(host2.control.config.max_concurrent_execute, 2, "restart re-reads runtime.json");
  host2.close();
});

test("U07: contest workers land in each question campaign's spec, slots stay the supervisor's", async () => {
  const dir = tmp();
  const cat = new ProviderCatalog(dir);
  const provider = cat.addProvider({
    display_name: "test",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://example.invalid/v1/chat/completions",
    api_key: "sk-test",
  });
  const model = cat.addModel({ provider_id: provider.id, name: "deepseek-chat" });
  cat.assignSlot("solver", model.id);
  const factory = new EngineRunnerFactory(dir, { workers: 2, fetchFn: async () => new Response("x"), onLog: () => {} });
  const q: ContestQuestion = {
    question_id: "qw1",
    title: "web question",
    category: "web",
    description: "hit it",
    score: 100,
    real_score: 100,
    solved_number: 0,
    is_solved: false,
    interactive: false,
    file_url: null,
    attributes: [],
    capabilities: [],
    connection: { docker_url: "web.example:8080", docker_ip: null, docker_port: null },
    raw: {},
  } as unknown as ContestQuestion;
  const prep = await factory.prepare(q);
  const camp = factory.controlStorage().getCampaign(prep.campaignId);
  assert.equal(camp.spec.execution_policy?.max_execute_workers, 2, "workers = per-question fragment count");
  factory.dispose();
});

test("U08: flags beat env beat runtime.json beat defaults", () => {
  const dir = tmp();
  writeFileSync(join(dir, "runtime.json"), JSON.stringify({ max_concurrent_execute: 3, max_inflight_model_calls: 5 }));
  const cfg = resolveRuntimeConfig(dir, { "max-concurrent-execute": "7" }, { RIONEXT_MAX_INFLIGHT_MODEL_CALLS: "6" } as NodeJS.ProcessEnv);
  assert.equal(cfg.max_concurrent_execute, 7, "flag wins");
  assert.equal(cfg.max_inflight_model_calls, 6, "env beats file");
  const cfg2 = resolveRuntimeConfig(dir, {}, {} as NodeJS.ProcessEnv);
  assert.equal(cfg2.max_concurrent_execute, 3, "file applies");
  assert.equal(cfg2.max_inflight_model_calls, 5);
});

test("U09: workers values share one validation rule everywhere", () => {
  for (const bad of ["0", "9", "1.5", "x", ""]) {
    assert.throws(() => parseWorkersFlag({ workers: bad }), /workers must be an integer between 1 and 8/);
  }
  assert.equal(parseWorkersFlag({ workers: "2" }), 2);
  assert.equal(parseWorkersFlag({}), null);
});

test("U10: a broken or illegal runtime.json fails startup; no campaign is created", () => {
  const dir = tmp();
  writeFileSync(join(dir, "runtime.json"), "{not json");
  assert.throws(() => new EngineHost(dir), /runtime\.json/);
  writeFileSync(join(dir, "runtime.json"), JSON.stringify({ max_concurrent_execute: 0 }));
  assert.throws(() => new EngineHost(dir), /max_concurrent_execute/);
  writeFileSync(join(dir, "runtime.json"), JSON.stringify({ provider_api_key: "steal-me" }));
  assert.throws(() => new EngineHost(dir), /not allowed/);
  const host = new EngineHost(tmp());
  assert.equal(host.control.listCampaigns().length, 0);
  host.close();
});

test("U11: a running campaign refuses a workers change; a paused one accepts it with an event", () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  e.createCampaign(loadDemoSpec("u11"));
  // simulate a live controller
  e.storage.acquireControllerLock("u11", "other-proc", 60_000);
  assert.throws(
    () => e.setExecutionWorkers("u11", 2),
    (err: unknown) => err instanceof DomainError && err.code === "campaign_running",
  );
  // controller gone (expired lock): the control plane updates and records
  e.storage.store.db.prepare("UPDATE controller_locks SET lease_until = 0 WHERE campaign_id = ?").run("u11");
  e.setExecutionWorkers("u11", 2);
  const camp = e.storage.getCampaign("u11");
  assert.equal(camp.spec.execution_policy?.max_execute_workers, 2);
  const events = e.storage.list("events", "u11").map((r) => String(r.type));
  assert.ok(events.includes("execution.policy_changed"));
  assert.throws(
    () => e.setExecutionWorkers("u11", 3.5),
    (err: unknown) => err instanceof DomainError && err.code === "workers",
  );
  e.close();
});

test("U12: provider-capacity projection reports the shared process semaphore", () => {
  const dir = tmp();
  const cfg = resolveRuntimeConfig(dir, { "max-inflight-model-calls": "3" }, {});
  const e = new Engine(cfg, { silent: true, maxCycles: 1 });
  e.createCampaign(loadDemoSpec("u12"));
  const cap = e.status("u12").provider_capacity as { scope: string; limit: number; active: number; queued: number };
  assert.equal(cap.scope, "service_process");
  assert.equal(cap.limit, 3);
  assert.equal(cap.active, 0);
  assert.equal(cap.queued, 0);
  e.close();
});

test("engine worker counts never multiply the campaign budget", () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec("u-budget");
  spec.execution_policy = { max_execute_workers: 2 };
  e.createCampaign(spec);
  const before = e.budget.snapshot("u-budget");
  const after = e.budget.snapshot("u-budget");
  assert.deepEqual(Number(after.free_calls), Number(before.free_calls), "one campaign budget, unchanged by worker count");
  e.close();
});
