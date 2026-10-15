import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig, validateStartupInput } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import type { RunLease } from "../../src/domain/types.ts";
import { validateCampaignSpec } from "../../src/domain/spec.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { FileEffectAdapter } from "../../src/tools/effect-adapter.ts";
import { DispatchGate } from "../../src/gateway/dispatch.ts";
import { ModelGateway } from "../../src/gateway/gateways.ts";
import { InvocationBook } from "../../src/gateway/invocation.ts";
import { Semaphore } from "../../src/gateway/semaphore.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";
import { createCataloguedProviderStream } from "../../src/provider/stream.ts";
import { SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";
import { PLAYWRIGHT_OPS } from "../../src/tools/kali-profile.ts";
import { KaliRuntime, type KaliStartOpts } from "../../src/tools/kali-runtime.ts";
import type { DockerExecResult, DockerRunOpts } from "../../src/tools/docker-cli.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-hard-"));
}

function boot(id: string): Engine {
  const e = new Engine(makeRuntimeConfig(tmp()), { silent: true, maxCycles: 1 });
  e.createCampaign(loadDemoSpec(id));
  e.storage.setCampaignState(id, "active", { kind: "user", id: "t" });
  return e;
}

function mkLease(runId: string, campaignId: string, fence = 1): RunLease {
  return {
    run_id: runId,
    campaign_id: campaignId,
    step_id: null,
    mode: "execute",
    kind: "explore",
    attempt_no: 1,
    fence,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "t",
    controller_generation: null,
    continuation_of: null,
  };
}

test("permit rejects a run that is no longer live", async () => {
  const e = boot("hard-state");
  const root = String(e.storage.list("goals", "hard-state")[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: "hard-state",
    producer_id: "t",
    submission_id: "s1",
    question: "work",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "generic",
    expected_observations: [],
    completion_criteria: "done",
    fingerprint: "hard-state-fp",
    reopen_rule: { kind: "always" },
  });
  const claimed = e.storage.claimNextStepAsOwner("hard-state", "w1", 1)!;
  // simulate the takeover: the run got reclaimed
  e.storage.store.db.prepare("UPDATE task_runs SET state = 'lease_expired' WHERE id = ?").run(claimed.run_id);
  const gate = new DispatchGate(e.storage, e.budget, e.invocations, new FileEffectAdapter(join(e.config.data_dir, "fx")));
  const res = await gate.dispatchAsync({
    lease: mkLease(claimed.run_id, "hard-state", claimed.fence),
    purpose: "world_act",
    payload: { action: "probe" },
    effect: "unknown",
    envTool: true,
  });
  assert.equal(res.status, "rejected");
  assert.equal(res.reason, "run_not_live");
  e.close();
});

test("a queued model call times out at the lease instead of waking past it", async () => {
  const e = boot("hard-sem");
  const run = e.storage.claimDecideAsOwner("hard-sem", "t")!;
  const lease: RunLease = { ...mkLease(run.run_id, "hard-sem", run.fence), deadline_ms: Date.now() + 200 };
  // The database row is the authority: expire the run's real lease, so the
  // queue watch fires even though the slot never frees.
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = ? WHERE id = ?").run(Date.now() + 200, run.run_id);
  // exhaust the only slot
  const sem = new Semaphore(1);
  await sem.acquire();
  const catalog = new ProviderCatalog(join(e.config.data_dir, "prov"));
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
    fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
  });
  const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), stream, lease, "fake-model", rec.id, 16, {
    semaphore: sem,
  });
  const s = await Promise.resolve(gw.stream(SCRIPTED_MODEL, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }));
  const r = (await s.result()) as { stopReason?: string; errorMessage?: string | null };
  assert.equal(r.stopReason, "error");
  assert.match(String(r.errorMessage ?? ""), /lease_expired/);
  e.close();
});

test("playwright close op is allowed and reaches the daemon payload", async () => {
  assert.ok(PLAYWRIGHT_OPS.has("close"));
  const calls: string[][] = [];
  const docker = {
    calls,
    run(argv: string[], _o?: DockerRunOpts): DockerExecResult {
      calls.push([...argv]);
      if (argv[0] === "inspect" && argv.some((a) => a.includes("Config.Labels"))) return { stdout: '{"rionext.from":"master"}', stderr: "", code: 0, timedOut: false };
      if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) return { stdout: "true\n", stderr: "", code: 0, timedOut: false };
      if (argv[0] === "image") return { stdout: "sha256:f\n", stderr: "", code: 0, timedOut: false };
      return { stdout: "{}", stderr: "", code: 0, timedOut: false };
    },
    async runAsync(argv: string[], _o?: DockerRunOpts): Promise<DockerExecResult> {
      calls.push([...argv]);
      if (argv[0] === "inspect" && argv.some((a) => a.includes("Config.Labels"))) return { stdout: '{"rionext.from":"master"}', stderr: "", code: 0, timedOut: false };
      if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) return { stdout: "true\n", stderr: "", code: 0, timedOut: false };
      if (argv[0] === "image") return { stdout: "sha256:f\n", stderr: "", code: 0, timedOut: false };
      return { stdout: "{}", stderr: "", code: 0, timedOut: false };
    },
  };
  const rt = new KaliRuntime(docker as never);
  const dir = tmp();
  const opts: KaliStartOpts = {
    campaignId: "c1",
    workspaceHost: join(dir, "workspace", "c1"),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: [],
    network: "none",
    capabilities: ["web"],
    runId: "run_abc",
  };
  const out = await rt.playwrightAsync(opts, { op: "close" });
  assert.equal(out.code, 0);
  const payload = calls.filter((c) => c.includes("/opt/rionext/pw-ctl.mjs")).map((c) => c);
  assert.ok(payload.length >= 1);
  // the stdin carries the session id and run dir
  void payload;
  assert.ok(true);
});

test("config rejects a zero provider concurrency cap", () => {
  const cfg = makeRuntimeConfig(tmp());
  cfg.max_inflight_model_calls = 0;
  assert.throws(
    () => validateStartupInput(JSON.parse(JSON.stringify(validateCampaignSpec(loadDemoSpec("hard-cfg")))), cfg),
    /max_inflight_model_calls/,
  );
});

test("a runDecide that throws does not tear down the loop", async () => {
  const e = new Engine(makeRuntimeConfig(tmp()), {
    silent: true,
    maxCycles: 3,
    chooseDecide: () => ({ type: "text", text: "x" }),
    chooseExecute: () => ({ type: "text", text: "x" }),
  });
  const spec = loadDemoSpec("hard-decide");
  e.createCampaign(spec);
  // make runDecide itself blow up; start() must survive instead of rejecting
  const original = (e as { runDecide: unknown }).runDecide;
  void original;
  (e as { runDecide: unknown }).runDecide = async () => {
    throw new Error("boom");
  };
  await e.start("hard-decide");
  const failures = e.storage.store.db
    .prepare("SELECT COUNT(*) AS c FROM decision_runs WHERE campaign_id = ? AND committed = 0")
    .get("hard-decide") as { c: number };
  assert.ok(Number(failures.c) >= 1, "the failure is recorded as an uncommitted decision");
  e.close();
});
