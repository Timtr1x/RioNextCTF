import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig, validateStartupInput } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { validateCampaignSpec } from "../../src/domain/spec.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-cap-"));
}

function boot(id: string, workers?: number): Engine {
  const e = new Engine(makeRuntimeConfig(tmp()), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec(id);
  if (workers !== undefined) spec.execution_policy = { max_execute_workers: workers };
  e.createCampaign(spec);
  e.storage.setCampaignState(id, "active", { kind: "user", id: "t" });
  return e;
}

function seedSteps(e: Engine, campaignId: string, n: number): void {
  const root = String(e.storage.list("goals", campaignId)[0]!.id);
  for (let i = 0; i < n; i++) {
    e.storage.proposeStepDirect({
      campaign_id: campaignId,
      producer_id: "t",
      submission_id: `seed-${i}`,
      question: `direction ${i}`,
      kind: "explore",
      goal_refs: [root],
      preconditions: { op: "all", of: [] },
      method_family: "generic",
      expected_observations: [],
      completion_criteria: "done",
      fingerprint: `fp-${campaignId}-${i}`,
      reopen_rule: { kind: "always" },
    });
  }
}

test("M01: capacity 2 starts two runs; the third step waits", () => {
  const e = boot("cap-2", 2);
  seedSteps(e, "cap-2", 3);
  const a = e.storage.claimNextStep("cap-2", "w1", 1);
  const b = e.storage.claimNextStep("cap-2", "w2", 1);
  const c = e.storage.claimNextStep("cap-2", "w3", 1);
  assert.ok(a && b, "two slots filled");
  assert.notEqual(a!.step_id, b!.step_id, "different steps");
  assert.equal(c, null, "third claim waits for a free slot");
  // a slot frees when a run settles
  e.storage.finishRun("cap-2", a!.run_id, {
    run_id: a!.run_id,
    step_id: a!.step_id,
    mode: "execute",
    reason: "deferred",
    summary: "partial",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: { kind: "always" },
    next_action: "continue",
    finish_requested: true,
    protocol_error: null,
  });
  const c2 = e.storage.claimNextStep("cap-2", "w3", 1);
  assert.ok(c2, "the freed slot admits the waiting step");
  e.close();
});

test("M02: two claimers racing one step — exactly one wins the CAS", () => {
  const e = boot("cap-1", 2);
  seedSteps(e, "cap-1", 1);
  const a = e.storage.claimNextStep("cap-1", "w1", 1);
  assert.ok(a);
  // a second engine on the same DB tries the same step
  const e2 = new Engine(makeRuntimeConfig(e.config.data_dir), { silent: true, maxCycles: 1 });
  const b = e2.storage.claimNextStep("cap-1", "w2", 1);
  assert.equal(b, null, "running steps are not re-claimed");
  e.close();
  e2.close();
});

test("legacy specs without execution_policy keep the single slot", () => {
  const e = boot("cap-old");
  seedSteps(e, "cap-old", 2);
  const a = e.storage.claimNextStep("cap-old", "w1", 1);
  const b = e.storage.claimNextStep("cap-old", "w2", 1);
  assert.ok(a);
  assert.equal(b, null, "old spec, one execute slot");
  e.close();
});

test("execution_policy validates and round-trips", () => {
  const spec = loadDemoSpec("cap-rt");
  spec.execution_policy = { max_execute_workers: 2 };
  const parsed = validateCampaignSpec(JSON.parse(JSON.stringify(spec)));
  assert.equal(parsed.execution_policy?.max_execute_workers, 2);
  assert.throws(() =>
    validateCampaignSpec(JSON.parse(JSON.stringify({ ...spec, execution_policy: { max_execute_workers: 0 } }))),
  );
  assert.throws(() =>
    validateCampaignSpec(JSON.parse(JSON.stringify({ ...spec, execution_policy: { max_execute_workers: 9 } }))),
  );
  // host config accepts integers >= 1
  const cfg = makeRuntimeConfig(tmp());
  cfg.max_concurrent_execute = 2;
  assert.doesNotThrow(() => validateStartupInput(JSON.parse(JSON.stringify(spec)), cfg));
  cfg.max_concurrent_execute = 0;
  assert.throws(() => validateStartupInput(JSON.parse(JSON.stringify(spec)), cfg));
});
