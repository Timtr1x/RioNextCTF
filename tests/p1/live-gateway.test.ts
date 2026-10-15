import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { ModelGateway } from "../../src/gateway/gateways.ts";
import { InvocationBook } from "../../src/gateway/invocation.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";
import { createCataloguedProviderStream } from "../../src/provider/stream.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";
import type { RunLease } from "../../src/domain/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-live-"));
}

test("Q09 live ModelGateway settle is skipped unless RIONEXT_LIVE_PROVIDER=1", async (t) => {
  if (process.env.RIONEXT_LIVE_PROVIDER !== "1") {
    t.skip("set RIONEXT_LIVE_PROVIDER=1 and a catalogued provider to run a live gateway send");
    return;
  }
  const dataDir = process.env.RIONEXT_DATA;
  if (!dataDir) {
    t.skip("RIONEXT_DATA is required for the live gateway test");
    return;
  }
  const catalog = new ProviderCatalog(dataDir);
  const providers = catalog.listProviders();
  const provider = providers[0];
  if (!provider) {
    t.skip("no catalogued provider in RIONEXT_DATA");
    return;
  }
  const models = catalog.listModels(String(provider.id));
  const model = models[0];
  if (!model) {
    t.skip("provider has no model");
    return;
  }
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec("camp_live_gw");
  e.createCampaign(spec);
  e.storage.setCampaignState(spec.campaign_id, "active", { kind: "user", id: "t" });
  const run = e.storage.claimDecideAsOwner(spec.campaign_id, "live")!;
  const lease: RunLease = {
    run_id: run.run_id,
    campaign_id: spec.campaign_id,
    step_id: null,
    mode: "decide",
    kind: "decide",
    attempt_no: 1,
    fence: run.fence,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "live",
    controller_generation: null,
    continuation_of: null,
  };
  const { stream } = createCataloguedProviderStream({
    catalog,
    providerId: String(provider.id),
    modelName: String(model.name),
    fetchFn: (url, init) => fetch(url, init),
    maxRetries: 0,
    timeoutMs: 20_000,
  });
  const gw = new ModelGateway(e.storage, e.budget, new InvocationBook(e.storage), stream, lease, String(model.name), String(provider.id));
  const s = await Promise.resolve(
    gw.stream(SCRIPTED_MODEL, {
      systemPrompt: "Reply with the single word pong.",
      messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
    }),
  );
  const msg = await s.result();
  assert.ok(msg.stopReason === "stop" || msg.stopReason === "error" || msg.stopReason === "aborted");
  const rows = e.storage.list("invocations", spec.campaign_id);
  const modelInv = rows.find((r) => r.kind === "model");
  assert.ok(modelInv);
  const blob = JSON.stringify({ logs: e.logs, inv: modelInv });
  assert.equal(/sk-|api_key|Bearer /i.test(blob), false);
  e.close();
});
