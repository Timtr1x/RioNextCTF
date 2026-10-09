import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { goalFactCanSatisfy } from "../../src/domain/completion.ts";
import type { CampaignSpec, TaskOutcome } from "../../src/domain/types.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-verdict-"));
}

function boot(id: string, specOverrides?: (spec: CampaignSpec) => void): Engine {
  const e = new Engine(makeRuntimeConfig(tmp()), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec(id);
  spec.root_goal = { ...spec.root_goal, success_predicate_ref: "flag_recovered" };
  specOverrides?.(spec);
  e.createCampaign(spec);
  e.storage.setCampaignState(id, "active", { kind: "user", id: "t" });
  return e;
}

function seedEvidence(e: Engine, campaignId: string, runId: string, envRev = "env-1"): string {
  const o = e.storage.recordObservation({
    campaign_id: campaignId,
    producer_id: "t",
    submission_id: `obs-${runId}-${Math.random().toString(16).slice(2)}`,
    run_id: runId,
    attempt_id: runId,
    subject: "evidence",
    body: { note: "raw evidence" },
    artifact_refs: [],
    conditions: {},
    env_rev: envRev,
  });
  return o.canonical_ids.observation_id!;
}

function seedFinding(e: Engine, campaignId: string, runId: string, claim: string, dedup: string): string {
  const obs = seedEvidence(e, campaignId, runId);
  const f = e.storage.submitFinding({
    campaign_id: campaignId,
    producer_id: "t",
    submission_id: `find-${dedup}`,
    run_id: runId,
    claim,
    evidence_refs: [obs],
    dedup_key: dedup,
  });
  return f.canonical_ids.finding_id!;
}

/** Create a targeted verify step on the seeding decide run, finish it, claim the verify run. */
function claimVerifyRun(
  e: Engine,
  campaignId: string,
  targetId: string,
  decideRunId: string,
): { step_id: string; run_id: string; fence: number } {
  e.storage.applyProposalBatch({
    campaign_id: campaignId,
    producer_id: decideRunId,
    submission_id: `ver-${targetId}`,
    run_id: decideRunId,
    operations: [{ op: "request_verification", finding_or_fact_id: targetId, method: "reproduce" }],
  });
  e.storage.finishRun(campaignId, decideRunId, decideOutcome(decideRunId));
  const run = e.storage.claimNextStep(campaignId, "t", 1)!;
  assert.equal(run.kind, "verify");
  return run;
}

function decideOutcome(runId: string): TaskOutcome {
  return {
    run_id: runId,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "planned",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  };
}

function finishVerify(
  e: Engine,
  campaignId: string,
  run: { run_id: string; fence: number },
  payload: Record<string, unknown>,
  source: "primary" | "finalizer" = "primary",
): void {
  const submitted = e.storage.submitRunOutcome({
    campaign_id: campaignId,
    run_id: run.run_id,
    fence: run.fence,
    submission_id: `fin-${run.run_id}`,
    payload: payload as never,
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    source,
  });
  assert.equal(submitted.accepted, true, `finish rejected: ${submitted.error ?? ""}`);
  e.storage.finishRun(campaignId, run.run_id, decideOutcome(run.run_id));
}

function findingStatus(e: Engine, campaignId: string, id: string): string {
  return String(e.storage.list("findings", campaignId).find((f) => f.id === id)?.status);
}

test("V01/V02: goal claim parks only under the independent-verify policy", () => {
  // strict policy: observed goal fact stays proposed and pending
  const strict = boot("v01");
  const r1 = strict.storage.claimDecide("v01", "t")!;
  strict.storage.submitFact({
    campaign_id: "v01",
    producer_id: "t",
    submission_id: "f1",
    run_id: r1.run_id,
    proposition: "flag{xyz}",
    fact_key: "flag_recovered",
    support_refs: [seedEvidence(strict, "v01", r1.run_id)],
    conditions: {},
  });
  assert.ok(strict.storage.pendingGoalClaim("v01"), "strict policy parks the claim");
  const snapStrict = strict.snapshot("v01");
  assert.equal(snapStrict.root_goal_satisfied, false);
  strict.close();

  // observed-only policy: same fact is accepted and satisfies the goal
  const open = boot("v02", (spec) => {
    spec.verification_policy = { require_independent_verify: false, oracle_id: "none" };
  });
  const r2 = open.storage.claimDecide("v02", "t")!;
  open.storage.submitFact({
    campaign_id: "v02",
    producer_id: "t",
    submission_id: "f1",
    run_id: r2.run_id,
    proposition: "flag{xyz}",
    fact_key: "flag_recovered",
    support_refs: [seedEvidence(open, "v02", r2.run_id)],
    conditions: {},
  });
  assert.equal(open.storage.pendingGoalClaim("v02"), null, "no pending claim under observed-only");
  const fact = open.storage.list("facts", "v02").find((f) => f.fact_key === "flag_recovered")!;
  assert.equal(fact.epistemic_status, "accepted");
  assert.equal(fact.source_grade, "observed", "never auto-verified");
  assert.equal(open.snapshot("v02").root_goal_satisfied, true);
  open.close();
});

test("V03/V04: derived, stale and disputed facts never satisfy the goal", () => {
  const e = boot("v03", (spec) => {
    spec.verification_policy = { require_independent_verify: false, oracle_id: "none" };
  });
  const run = e.storage.claimDecide("v03", "t")!;
  e.storage.submitFact({
    campaign_id: "v03",
    producer_id: "t",
    submission_id: "fd",
    run_id: run.run_id,
    proposition: "flag{inferred}",
    fact_key: "flag_recovered",
    support_refs: [seedEvidence(e, "v03", run.run_id)],
    conditions: {},
    source_grade: "derived",
  });
  assert.equal(e.storage.pendingGoalClaim("v03"), null, "derived claims never park for review");
  assert.equal(e.snapshot("v03").root_goal_satisfied, false);

  const spec = e.storage.getCampaign("v03").spec;
  assert.equal(
    goalFactCanSatisfy(spec, { fact_key: "flag_recovered", epistemic_status: "accepted", validity: "stale", source_grade: "observed" }),
    false,
  );
  assert.equal(
    goalFactCanSatisfy(spec, { fact_key: "flag_recovered", epistemic_status: "disputed", validity: "current", source_grade: "observed" }),
    false,
  );
  e.close();
});

test("V08: a verify run that resolves without a verdict confirms nothing", () => {
  const e = boot("v08");
  const decide = e.storage.claimDecide("v08", "t")!;
  const findingId = seedFinding(e, "v08", decide.run_id, "misleading code path", "v08-a");
  const run = claimVerifyRun(e, "v08", findingId, decide.run_id);
  const fresh = seedEvidence(e, "v08", run.run_id);
  finishVerify(e, "v08", run, { disposition: "resolved", summary: "looked fine, no explicit verdict", evidence_refs: [fresh] });
  assert.equal(findingStatus(e, "v08", findingId), "suspected");
  e.close();
});

test("V09/V14: a verdict applies to its named target only, with fresh in-run evidence", () => {
  const e = boot("v09");
  const decide = e.storage.claimDecide("v09", "t")!;
  const a = seedFinding(e, "v09", decide.run_id, "backup leak", "v09-a");
  const b = seedFinding(e, "v09", decide.run_id, "weak crypto", "v09-b");
  const c = seedFinding(e, "v09", decide.run_id, "open debug", "v09-c");
  const run = claimVerifyRun(e, "v09", a, decide.run_id);
  // evidence produced inside THIS verify run
  const fresh = seedEvidence(e, "v09", run.run_id);
  finishVerify(e, "v09", run, {
    disposition: "resolved",
    summary: "reproduced the leak",
    evidence_refs: [fresh],
    verification_result: { target_id: a, verdict: "confirmed", evidence_refs: [fresh], rationale: "reproduced against the live target" },
  });
  assert.equal(findingStatus(e, "v09", a), "confirmed");
  assert.equal(findingStatus(e, "v09", b), "suspected");
  assert.equal(findingStatus(e, "v09", c), "suspected");
  const applied = e.storage.list("events", "v09").filter((ev) => ev.type === "verification.applied");
  assert.equal(applied.length, 1);
  e.close();
});

test("V10: a verdict naming another campaign's entity is rejected, not applied", () => {
  const e = boot("v10");
  const other = boot("v10b");
  try {
    const decide = e.storage.claimDecide("v10", "t")!;
    const mine = seedFinding(e, "v10", decide.run_id, "mine", "v10-a");
    const otherDecide = other.storage.claimDecide("v10b", "t")!;
    const foreign = seedFinding(other, "v10b", otherDecide.run_id, "foreign", "v10-b");
    // craft a verify step whose declared target is `mine`, then lie about it
    const run = claimVerifyRun(e, "v10", mine, decide.run_id);
    const fresh = seedEvidence(e, "v10", run.run_id);
    finishVerify(e, "v10", run, {
      disposition: "resolved",
      summary: "attempt",
      evidence_refs: [fresh],
      verification_result: { target_id: foreign, verdict: "confirmed", evidence_refs: [fresh], rationale: "wrong target" },
    });
    assert.equal(findingStatus(e, "v10", mine), "suspected");
    assert.equal(findingStatus(other, "v10b", foreign), "suspected");
    const rejected = e.storage.list("events", "v10").filter((ev) => ev.type === "verification.rejected");
    assert.equal(rejected.length, 1);
  } finally {
    e.close();
    other.close();
  }
});

test("V11/V12: confirm needs fresh-env evidence produced by the verify run itself", () => {
  const e = boot("v11");
  const decide = e.storage.claimDecide("v11", "t")!;
  const findingId = seedFinding(e, "v11", decide.run_id, "stale target", "v11-a");
  const run = claimVerifyRun(e, "v11", findingId, decide.run_id);

  // stale env evidence → rejected
  const staleObs = seedEvidence(e, "v11", run.run_id, "env-old");
  finishVerify(e, "v11", run, {
    disposition: "resolved",
    summary: "stale attempt",
    evidence_refs: [staleObs],
    verification_result: { target_id: findingId, verdict: "confirmed", evidence_refs: [staleObs], rationale: "old env" },
  });
  assert.equal(findingStatus(e, "v11", findingId), "suspected");
});

test("V12: re-citing the original claim's evidence is not independent reproduction", () => {
  const e = boot("v12");
  const decide = e.storage.claimDecide("v12", "t")!;
  const origEvidence = seedEvidence(e, "v12", decide.run_id);
  const f = e.storage.submitFinding({
    campaign_id: "v12",
    producer_id: "t",
    submission_id: "find-v12",
    run_id: decide.run_id,
    claim: "needs repro",
    evidence_refs: [origEvidence],
    dedup_key: "v12",
  });
  const findingId = f.canonical_ids.finding_id!;
  const run = claimVerifyRun(e, "v12", findingId, decide.run_id);
  finishVerify(e, "v12", run, {
    disposition: "resolved",
    summary: "just re-read the original evidence",
    evidence_refs: [origEvidence],
    verification_result: { target_id: findingId, verdict: "confirmed", evidence_refs: [origEvidence], rationale: "same evidence" },
  });
  assert.equal(findingStatus(e, "v12", findingId), "suspected");
  const rejected = e.storage
    .list("events", "v12")
    .filter((ev) => ev.type === "verification.rejected" && String(ev.payload_json).includes("not_independent"));
  assert.equal(rejected.length, 1);
  e.close();
});

test("V13: Finalize never mints a first-time verdict", () => {
  const e = boot("v13");
  const decide = e.storage.claimDecide("v13", "t")!;
  const findingId = seedFinding(e, "v13", decide.run_id, "finalize bait", "v13-a");
  const run = claimVerifyRun(e, "v13", findingId, decide.run_id);
  const fresh = seedEvidence(e, "v13", run.run_id);
  finishVerify(
    e,
    "v13",
    run,
    {
      disposition: "resolved",
      summary: "finalizer summary",
      evidence_refs: [fresh],
      verification_result: { target_id: findingId, verdict: "confirmed", evidence_refs: [fresh], rationale: "finalizer hallucination" },
    },
    "finalizer",
  );
  assert.equal(findingStatus(e, "v13", findingId), "suspected");
  const dropped = e.storage.list("events", "v13").filter((ev) => ev.type === "verification.dropped_finalizer");
  assert.equal(dropped.length, 1);
  e.close();
});

test("V15: the same verdict re-applied is idempotent", () => {
  const e = boot("v15");
  const decide = e.storage.claimDecide("v15", "t")!;
  const findingId = seedFinding(e, "v15", decide.run_id, "dup", "v15-a");
  const run = claimVerifyRun(e, "v15", findingId, decide.run_id);
  const fresh = seedEvidence(e, "v15", run.run_id);
  finishVerify(e, "v15", run, {
    disposition: "resolved",
    summary: "reproduced",
    evidence_refs: [fresh],
    verification_result: { target_id: findingId, verdict: "confirmed", evidence_refs: [fresh], rationale: "r" },
  });
  const eventsBefore = e.storage.list("events", "v15").filter((ev) => ev.type === "verification.applied").length;
  // replay the stored finish (recovery path): the run is already finished, the
  // CAS rejects it, and the verdict is not re-applied
  e.storage.finishRun("v15", run.run_id, decideOutcome(run.run_id));
  const eventsAfter = e.storage.list("events", "v15").filter((ev) => ev.type === "verification.applied").length;
  assert.equal(findingStatus(e, "v15", findingId), "confirmed");
  assert.equal(eventsAfter, eventsBefore, "replayed finish does not re-apply the verdict");
  e.close();
});
