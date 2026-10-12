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
  method = "reproduce",
): { step_id: string; run_id: string; fence: number } {
  e.storage.applyProposalBatch({
    campaign_id: campaignId,
    producer_id: decideRunId,
    submission_id: `ver-${targetId}-${method}`,
    run_id: decideRunId,
    operations: [{ op: "request_verification", finding_or_fact_id: targetId, method }],
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

// --- R01: fact-targeted verdicts and run settlement ---

function seedGoalFact(e: Engine, campaignId: string, runId: string, factKey: string, proposition: string): string {
  const obs = seedEvidence(e, campaignId, runId);
  const f = e.storage.submitFact({
    campaign_id: campaignId,
    producer_id: "t",
    submission_id: `fact-${factKey}-${Math.random().toString(16).slice(2)}`,
    run_id: runId,
    proposition,
    fact_key: factKey,
    support_refs: [obs],
    conditions: {},
  });
  return f.canonical_ids.fact_id!;
}

test("R01-01/02: fact verdicts apply through the fact path and settle the run", () => {
  const e = boot("r01a", (spec) => {
    spec.verification_policy = { require_independent_verify: false, oracle_id: "none" };
  });
  const decide = e.storage.claimDecide("r01a", "t")!;
  const factId = seedGoalFact(e, "r01a", decide.run_id, "backup_readable", "backup endpoint is readable");
  const run = claimVerifyRun(e, "r01a", factId, decide.run_id);
  const fresh = seedEvidence(e, "r01a", run.run_id);
  finishVerify(e, "r01a", run, {
    disposition: "resolved",
    summary: "reproduced",
    evidence_refs: [fresh],
    verification_result: { target_id: factId, verdict: "confirmed", evidence_refs: [fresh], rationale: "reproduced" },
  });
  const fact = e.storage.list("facts", "r01a").find((f) => f.id === factId)!;
  assert.equal(fact.source_grade, "verified", "controlled path may mark verified");
  assert.equal(fact.epistemic_status, "accepted");
  assert.match(String(fact.support_refs_json), new RegExp(fresh));
  // the run settled instead of wedging on 'finding not found'
  assert.equal(e.storage.getRun(run.run_id).end_reason, "resolved");
  e.close();

  // refuted / inconclusive take the fact path too
  const e2 = boot("r01b", (spec) => {
    spec.verification_policy = { require_independent_verify: false, oracle_id: "none" };
  });
  const d2 = e2.storage.claimDecide("r01b", "t")!;
  const factId2 = seedGoalFact(e2, "r01b", d2.run_id, "xss_present", "xss exists");
  const r2 = claimVerifyRun(e2, "r01b", factId2, d2.run_id);
  const fresh2 = seedEvidence(e2, "r01b", r2.run_id);
  finishVerify(e2, "r01b", r2, {
    disposition: "resolved",
    summary: "counter evidence",
    evidence_refs: [fresh2],
    verification_result: { target_id: factId2, verdict: "refuted", evidence_refs: [fresh2], rationale: "payload escaped" },
  });
  const fact2 = e2.storage.list("facts", "r01b").find((f) => f.id === factId2)!;
  assert.equal(fact2.epistemic_status, "disputed");
  assert.match(String(fact2.counter_refs_json), new RegExp(fresh2));
  e2.close();
});

test("R01-04: a verdict against a stale target revision is rejected, the run still settles", () => {
  const e = boot("r01c", (spec) => {
    spec.verification_policy = { require_independent_verify: false, oracle_id: "none" };
  });
  const decide = e.storage.claimDecide("r01c", "t")!;
  const factId = seedGoalFact(e, "r01c", decide.run_id, "key_x", "claim v1");
  const run = claimVerifyRun(e, "r01c", factId, decide.run_id);
  // target moved on between request and finish
  e.storage.store.db.prepare("UPDATE facts SET revision = revision + 1 WHERE id = ?").run(factId);
  const fresh = seedEvidence(e, "r01c", run.run_id);
  finishVerify(e, "r01c", run, {
    disposition: "resolved",
    summary: "stale verdict",
    evidence_refs: [fresh],
    verification_result: { target_id: factId, verdict: "confirmed", evidence_refs: [fresh], rationale: "stale" },
  });
  const rejected = e.storage.list("events", "r01c").filter((ev) => ev.type === "verification.rejected");
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]!.payload_json), /target_revision_changed/);
  const fact = e.storage.list("facts", "r01c").find((f) => f.id === factId)!;
  assert.equal(fact.source_grade, "observed", "untouched by the stale verdict");
  assert.equal(e.storage.getRun(run.run_id).state, "finished");
  e.close();
});

test("R01-05: a missing target is rejected with an event and the slot frees", () => {
  const e = boot("r01d", (spec) => {
    spec.verification_policy = { require_independent_verify: false, oracle_id: "none" };
  });
  const decide = e.storage.claimDecide("r01d", "t")!;
  const factId = seedGoalFact(e, "r01d", decide.run_id, "key_y", "claim");
  const run = claimVerifyRun(e, "r01d", factId, decide.run_id);
  const fresh = seedEvidence(e, "r01d", run.run_id);
  finishVerify(e, "r01d", run, {
    disposition: "resolved",
    summary: "wrong target",
    evidence_refs: [fresh],
    verification_result: { target_id: "fact_missing", verdict: "confirmed", evidence_refs: [fresh], rationale: "gone" },
  });
  const rejected = e.storage.list("events", "r01d").filter((ev) => ev.type === "verification.rejected");
  assert.equal(rejected.length, 1);
  assert.equal(e.storage.getRun(run.run_id).state, "finished");
  e.close();
});

test("R01-08: a model verdict never substitutes for external flag acceptance", () => {
  const e = boot("r01e"); // strict policy: require_independent_verify = true
  const decide = e.storage.claimDecide("r01e", "t")!;
  const flagFact = seedGoalFact(e, "r01e", decide.run_id, "flag_recovered", "flag{maybe}");
  const run = claimVerifyRun(e, "r01e", flagFact, decide.run_id);
  const fresh = seedEvidence(e, "r01e", run.run_id);
  finishVerify(e, "r01e", run, {
    disposition: "resolved",
    summary: "model says the flag works",
    evidence_refs: [fresh],
    verification_result: { target_id: flagFact, verdict: "confirmed", evidence_refs: [fresh], rationale: "looks right" },
  });
  const fact = e.storage.list("facts", "r01e").find((f) => f.id === flagFact)!;
  assert.notEqual(fact.source_grade, "verified", "model verdict does not verify the goal flag");
  const rejected = e.storage.list("events", "r01e").filter((ev) => ev.type === "verification.rejected");
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]!.payload_json), /goal_external_acceptance/);
  e.close();
});

// --- C0 boundary: F01/F02 ---

test("F01: a refuted verdict on a confirmed finding is rejected, the run still settles", () => {
  const e = boot("f01");
  const decide = e.storage.claimDecide("f01", "t")!;
  const findingId = seedFinding(e, "f01", decide.run_id, "already confirmed", "f01-a");
  // legally confirm it first
  const v1 = claimVerifyRun(e, "f01", findingId, decide.run_id);
  const fresh1 = seedEvidence(e, "f01", v1.run_id);
  finishVerify(e, "f01", v1, {
    disposition: "resolved",
    summary: "confirmed",
    evidence_refs: [fresh1],
    verification_result: { target_id: findingId, verdict: "confirmed", evidence_refs: [fresh1], rationale: "reproduced" },
  });
  assert.equal(findingStatus(e, "f01", findingId), "confirmed");

  // now a refuted verdict arrives; confirmed → refuted is not a legal transition
  const decide2 = e.storage.claimDecide("f01", "t")!;
  const v2 = claimVerifyRun(e, "f01", findingId, decide2.run_id, "re-verify");
  const fresh2 = seedEvidence(e, "f01", v2.run_id);
  finishVerify(e, "f01", v2, {
    disposition: "resolved",
    summary: "disagree",
    evidence_refs: [fresh2],
    verification_result: { target_id: findingId, verdict: "refuted", evidence_refs: [fresh2], rationale: "cannot reproduce" },
  });
  assert.equal(findingStatus(e, "f01", findingId), "confirmed", "state survives the illegal transition");
  assert.equal(e.storage.getRun(v2.run_id).state, "finished", "the run still settles");
  const rejected = e.storage.list("events", "f01").filter((ev) => ev.type === "verification.rejected");
  assert.ok(rejected.some((ev) => String(ev.payload_json).includes("illegal_transition")));
  e.close();
});

test("F02: a confirmed finding persists its verification evidence refs", () => {
  const e = boot("f02");
  const decide = e.storage.claimDecide("f02", "t")!;
  const findingId = seedFinding(e, "f02", decide.run_id, "claim", "f02-a");
  const run = claimVerifyRun(e, "f02", findingId, decide.run_id);
  const fresh = seedEvidence(e, "f02", run.run_id);
  finishVerify(e, "f02", run, {
    disposition: "resolved",
    summary: "confirmed",
    evidence_refs: [fresh],
    verification_result: { target_id: findingId, verdict: "confirmed", evidence_refs: [fresh], rationale: "reproduced" },
  });
  const row = e.storage.list("findings", "f02").find((f) => f.id === findingId)!;
  const verificationRefs = JSON.parse(String(row.verification_refs_json)) as string[];
  assert.deepEqual(verificationRefs, [fresh], "verification evidence lands on the finding, not only in events");
  e.close();
});
