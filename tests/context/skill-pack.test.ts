import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildContextPack } from "../../src/context/builder.ts";
import { openEngine, type Engine } from "../../src/controller/engine.ts";
import { buildInputFlagSpec, buildKaliFlagSpec } from "../../src/domain/quick-spec.ts";
import type { RunLease } from "../../src/domain/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-skill-"));
}

function payload(pack: { user_payload: unknown }): Record<string, unknown> {
  return pack.user_payload as Record<string, unknown>;
}

function lease(campaignId: string, mode: "decide" | "execute", stepId: string | null): RunLease {
  return {
    run_id: `run_${campaignId}_${mode}`,
    campaign_id: campaignId,
    step_id: stepId,
    mode,
    kind: mode === "decide" ? "decide" : "explore",
    attempt_no: 1,
    fence: 1,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "test",
    continuation_of: null,
  };
}

function seedStep(e: Engine, campaignId: string, family: string): string {
  const root = e.storage.store.db
    .prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1")
    .get(campaignId) as { id: string };
  const result = e.storage.proposeStepDirect({
    campaign_id: campaignId,
    producer_id: "test",
    submission_id: `seed-${family}`,
    question: "solve",
    kind: "explore",
    goal_refs: [root.id],
    preconditions: { op: "all", of: [] },
    method_family: family,
    expected_observations: [],
    completion_criteria: "done",
    fingerprint: `fp-${family}`,
    reopen_rule: { kind: "always" },
  });
  return String(result.canonical_ids.step_id);
}

const PROVIDER = { provider: "prv_test", model: "test-model" };

test("giant observation bodies are capped so the context pack always fits", () => {
  const dir = tmp();
  const e = openEngine(dir, { silent: true, maxCycles: 1 });
  try {
    const spec = buildInputFlagSpec({
      ...PROVIDER,
      campaign_id: "camp_fat",
      triage: { kind: "misc", confidence: "medium", evidence: [], seed_method_family: "ctf-misc" },
      input: { source_name: "white", files: 1, total_bytes: 100, sha256: "cd".repeat(32) },
    });
    e.createCampaign(spec);
    e.storage.setCampaignState("camp_fat", "active", { kind: "user", id: "t" });
    const run = e.storage.claimDecide("camp_fat", "t")!;
    // 20 observations with 100k bodies each: 2MB of raw bodies, 5x the global cap.
    for (let i = 0; i < 20; i++) {
      e.storage.recordObservation({
        campaign_id: "camp_fat",
        producer_id: "test",
        submission_id: `fat-${i}`,
        run_id: run.run_id,
        attempt_id: run.run_id,
        subject: "tool_raw:kali_run",
        body: { dump: "x".repeat(100_000) },
        artifact_refs: [],
        conditions: {},
        env_rev: "env-1",
      });
    }
    const pack = buildContextPack(e.storage, lease("camp_fat", "execute", null));
    const graph = payload(pack).graph as { observations: Array<{ body_json: string }> };
    assert.equal(graph.observations.length, 20);
    for (const obs of graph.observations) {
      // Adaptive cap: leftover budget / 20, clamped to [2k, 64k], plus marker.
      assert.ok(obs.body_json.length < 65_000, `body not capped: ${obs.body_json.length}`);
      assert.ok(obs.body_json.includes("[truncated"), "missing truncation marker");
      assert.ok(obs.body_json.includes("graph_query"), "marker must say how to fetch the full body");
    }
    // The pack as a whole stays inside the 400k budget.
    assert.ok(JSON.stringify(payload(pack)).length <= 400_000, "pack exceeds 400k budget");
    // And the full body is still intact in storage.
    const full = e.storage.list("observations", "camp_fat") as Array<{ body_json: string }>;
    assert.ok(full.every((o) => o.body_json.length > 100_000));
  } finally {
    e.close();
  }
});

test("execute on an input campaign gets the family skill; web gets null", () => {
  const dir = tmp();
  const e = openEngine(dir, { silent: true, maxCycles: 1 });
  try {
    // input campaign: reverse
    const inputSpec = buildInputFlagSpec({
      ...PROVIDER,
      campaign_id: "camp_rev",
      triage: { kind: "reverse", confidence: "high", evidence: [], seed_method_family: "reverse-native" },
      input: { source_name: "crackme", files: 1, total_bytes: 100, sha256: "ab".repeat(32) },
    });
    e.createCampaign(inputSpec);
    const stepId = seedStep(e, "camp_rev", "reverse-native");
    const pack = buildContextPack(e.storage, lease("camp_rev", "execute", stepId));
    const skill = payload(pack).skill_pack as string;
    assert.ok(skill, "reverse campaign should carry a skill pack");
    assert.match(skill, /逆向/);
    assert.match(skill, /\bgdb\b/);
    assert.match(skill, /r2/);
    assert.match(skill, /未列出的一律不可用/);
    assert.match(skill, /- 逆向\/利用: /);
    assert.match(skill, /ctf-python 已装库: .*pwntools/);
    assert.equal(pack.system_prompt.includes("kali_run"), true); // execute prompt unchanged location

    // same campaign, step from another family keeps campaign bins but swaps text
    const miscStep = seedStep(e, "camp_rev", "ctf-misc");
    const miscPack = buildContextPack(e.storage, lease("camp_rev", "execute", miscStep));
    assert.match(payload(miscPack).skill_pack as string, /Misc/);

    // decide never sees skill text
    const decidePack = buildContextPack(e.storage, lease("camp_rev", "decide", null));
    assert.equal("skill_pack" in payload(decidePack), false);

    // web campaign: no challenge record, skill_pack explicitly null
    const webSpec = buildKaliFlagSpec({ url: "http://target.example/", ...PROVIDER });
    e.createCampaign(webSpec);
    const webStep = seedStep(e, webSpec.campaign_id, "http-probe");
    const webPack = buildContextPack(e.storage, lease(webSpec.campaign_id, "execute", webStep));
    assert.equal(payload(webPack).skill_pack, null);
  } finally {
    e.close();
  }
});

test("pwn skill mentions the endpoint workflow; crypto skill mentions RSA discipline", () => {
  const dir = tmp();
  const e = openEngine(dir, { silent: true, maxCycles: 1 });
  try {
    const pwnSpec = buildInputFlagSpec({
      ...PROVIDER,
      campaign_id: "camp_pwn",
      triage: { kind: "pwn", confidence: "high", evidence: [], seed_method_family: "pwn-chain" },
      input: { source_name: "chall", files: 1, total_bytes: 100, sha256: "cd".repeat(32) },
      endpoint: { host: "pwn.example", port: 31337 },
    });
    e.createCampaign(pwnSpec);
    const pwnStep = seedStep(e, "camp_pwn", "pwn-chain");
    const pwnPack = buildContextPack(e.storage, lease("camp_pwn", "execute", pwnStep));
    assert.match(payload(pwnPack).skill_pack as string, /pwntools/);

    const cryptoSpec = buildInputFlagSpec({
      ...PROVIDER,
      campaign_id: "camp_crypto",
      triage: { kind: "crypto", confidence: "medium", evidence: [], seed_method_family: "ctf-crypto" },
      input: { source_name: "cipher.txt", files: 1, total_bytes: 100, sha256: "ef".repeat(32) },
    });
    e.createCampaign(cryptoSpec);
    const cryptoStep = seedStep(e, "camp_crypto", "ctf-crypto");
    const cryptoPack = buildContextPack(e.storage, lease("camp_crypto", "execute", cryptoStep));
    assert.match(payload(cryptoPack).skill_pack as string, /RSA/);
  } finally {
    e.close();
  }
});

test("input campaign without a mapped family falls back to the seed family", () => {
  const dir = tmp();
  const e = openEngine(dir, { silent: true, maxCycles: 1 });
  try {
    const spec = buildInputFlagSpec({
      ...PROVIDER,
      campaign_id: "camp_gen",
      triage: { kind: "generic", confidence: "low", evidence: [], seed_method_family: "ctf-triage" },
      input: { source_name: "blob", files: 1, total_bytes: 8, sha256: "aa".repeat(32) },
    });
    e.createCampaign(spec);
    const stepId = seedStep(e, "camp_gen", "ctf-triage");
    const pack = buildContextPack(e.storage, lease("camp_gen", "execute", stepId));
    const genSkill = payload(pack).skill_pack as string;
    assert.match(genSkill, /侦察/);
    assert.match(genSkill, /后台执行（返回 execution_id，勿轮询）: wget/);
    assert.match(genSkill, /- 网络: curl wget/);
  } finally {
    e.close();
  }
});
