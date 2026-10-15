import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { evaluateCompletion, type CompletionSnapshot } from "../../src/domain/completion.ts";
import { loadAssessmentSpec, loadDemoSpec } from "../../src/eval/helpers.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-cpol-"));
}

function baseSnap(over: Partial<CompletionSnapshot>): CompletionSnapshot {
  return {
    mode: "assessment",
    state: "active",
    cancel_epoch: 0,
    in_flight_runs: 0,
    in_flight_invocations: 0,
    unconsumed_events: 0,
    pending_decision: false,
    pending_important_proposals: 0,
    uncertain_invocations: 0,
    empty_reviews: 6,
    max_empty_reviews: 6,
    ready_steps: 0,
    blocked_steps: 0,
    frontier_size: 0,
    new_observation_since_progress: false,
    findings: [],
    coverage: [],
    root_goal_satisfied: false,
    ...over,
  };
}

test("V20: an old assessment spec without the optional fields stays strict", () => {
  const r = evaluateCompletion(
    baseSnap({
      coverage: [
        { id: "c1", mandatory: true, applicability: "applicable", execution_state: "untested", outcome: "none", evidence_state: "missing" },
      ],
    }),
  );
  assert.equal(r.canClose, false);
  assert.ok(r.blockers.includes("mandatory_coverage_untested"));

  const withFindings = evaluateCompletion(baseSnap({ findings: [{ status: "suspected" }] }));
  assert.equal(withFindings.canClose, false);
  assert.ok(withFindings.blockers.includes("findings_pending_verification"));
});

test("V21: a bounded assessment delivers candidates and uncovered items honestly", () => {
  const r = evaluateCompletion(
    baseSnap({
      require_confirmed_findings: false,
      require_complete: false,
      findings: [{ status: "suspected" }],
      coverage: [
        { id: "c1", mandatory: true, applicability: "applicable", execution_state: "untested", outcome: "none", evidence_state: "missing" },
      ],
    }),
  );
  assert.equal(r.canClose, true, "bounded assessment may close with candidates and uncovered items");
});

test("V22: strict findings never close while suspected/inconclusive/stale", () => {
  for (const status of ["suspected", "validating", "inconclusive", "stale"] as const) {
    const r = evaluateCompletion(baseSnap({ findings: [{ status }] }));
    assert.equal(r.canClose, false, status);
  }
});

test("V23: goal_seeking with an explicit findings requirement cannot close on the root goal alone", () => {
  const r = evaluateCompletion(
    baseSnap({
      mode: "goal_seeking",
      root_goal_satisfied: true,
      require_confirmed_findings: true,
      findings: [{ status: "suspected" }],
    }),
  );
  assert.equal(r.canClose, false);
  assert.ok(r.blockers.includes("findings_pending_verification"));
  // and without the explicit requirement it closes as before
  const relaxed = evaluateCompletion(
    baseSnap({ mode: "goal_seeking", root_goal_satisfied: true, findings: [{ status: "suspected" }] }),
  );
  assert.equal(relaxed.canClose, true);
});

test("V19: a coverage_result without evidence is rejected and marks nothing", async () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadAssessmentSpec("v19");
  e.createCampaign(spec);
  const covId = String(e.storage.list("coverage_items", "v19").find((c) => c.obligation === "inspect-desk")!.id);
  const decide = e.storage.claimDecideAsOwner("v19", "t")!;
  const root = String(e.storage.list("goals", "v19")[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: "v19",
    producer_id: "t",
    submission_id: "s",
    run_id: decide.run_id,
    question: "desk work",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "inspect-desk",
    expected_observations: [],
    completion_criteria: "done",
    fingerprint: "v19-fp",
    reopen_rule: { kind: "always" },
  });
  e.storage.finishRun("v19", decide.run_id, {
    run_id: decide.run_id,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "seed",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  const claimed = e.storage.claimNextStepAsOwner("v19", "t", 1)!;
  const res = e.storage.submitRunOutcome({
    campaign_id: "v19",
    run_id: claimed.run_id,
    fence: claimed.fence,
    submission_id: "v19-sub",
    payload: {
      disposition: "resolved",
      summary: "claims without proof",
      evidence_refs: [],
      coverage_result: [{ coverage_id: covId, outcome: "no_issue_observed", evidence_refs: [], note: "trust me" }],
    },
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    source: "primary",
  });
  // the finish itself is rejected for resolved without evidence at all
  assert.equal(res.accepted, false);
  const cov = e.storage.list("coverage_items", "v19").find((c) => c.id === covId);
  assert.notEqual(cov?.execution_state, "tested");
  e.close();
});

test("demo specs round-trip the optional delivery fields", () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadAssessmentSpec("v-rt");
  spec.verification_policy = { ...spec.verification_policy, require_confirmed_findings: false };
  spec.coverage_policy = { ...spec.coverage_policy, require_complete: false };
  e.createCampaign(spec);
  const read = e.storage.getCampaign("v-rt");
  assert.equal(read.spec.verification_policy.require_confirmed_findings, false);
  assert.equal(read.spec.coverage_policy.require_complete, false);
  // absent stays absent (legacy strict default lives at read time)
  const e2 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec2 = loadDemoSpec("v-rt2");
  e2.createCampaign(spec2);
  const read2 = e2.storage.getCampaign("v-rt2");
  assert.equal(read2.spec.verification_policy.require_confirmed_findings, undefined);
  assert.equal(read2.spec.coverage_policy.require_complete, undefined);
  e.close();
  e2.close();
});

// --- R02: assessment never parks at the root-goal human review ---

test("R02-01/02: assessment matching facts are ordinary facts, derived stays inference", () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadAssessmentSpec("r02");
  spec.verification_policy = { ...spec.verification_policy, require_independent_verify: true };
  e.createCampaign(spec);
  e.storage.setCampaignState("r02", "active", { kind: "user", id: "t" });
  const run = e.storage.claimDecideAsOwner("r02", "t")!;
  const obs = e.storage.recordObservation({
    campaign_id: "r02",
    producer_id: "t",
    submission_id: "o1",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "note",
    body: { ok: true },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  const obsId = obs.canonical_ids.observation_id!;
  const matched = e.storage.submitFact({
    campaign_id: "r02",
    producer_id: "t",
    submission_id: "m1",
    run_id: run.run_id,
    proposition: "coverage complete per evidence",
    fact_key: "coverage_complete", // the assessment success predicate
    support_refs: [obsId],
    conditions: {},
  });
  assert.equal(matched.extra?.submit_status, "accepted_as_observation", "no parking for assessments");
  assert.equal(e.storage.pendingGoalClaim("r02"), null);
  assert.equal(e.storage.getCampaign("r02").state, "active");

  const derived = e.storage.submitFact({
    campaign_id: "r02",
    producer_id: "t",
    submission_id: "d1",
    run_id: run.run_id,
    proposition: "inferred, not observed",
    fact_key: "coverage_complete",
    support_refs: [obsId],
    conditions: {},
    source_grade: "derived",
  });
  assert.equal(derived.extra?.submit_status, "pending_verification", "derived still parks as inference");
  assert.equal(e.storage.pendingGoalClaim("r02"), null, "derived inferences never reach the review queue");
  e.close();
});

test("R02-03: a strict goal_seeking flag claim still parks", () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec("r02c");
  spec.root_goal = { ...spec.root_goal, success_predicate_ref: "flag_recovered" };
  e.createCampaign(spec);
  e.storage.setCampaignState("r02c", "active", { kind: "user", id: "t" });
  const run = e.storage.claimDecideAsOwner("r02c", "t")!;
  const obs = e.storage.recordObservation({
    campaign_id: "r02c",
    producer_id: "t",
    submission_id: "o1",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "note",
    body: { flag: "flag{x}" },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  e.storage.submitFact({
    campaign_id: "r02c",
    producer_id: "t",
    submission_id: "f1",
    run_id: run.run_id,
    proposition: "flag{x}",
    fact_key: "flag_recovered",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
  });
  assert.ok(e.storage.pendingGoalClaim("r02c"), "CTF claim still parks for external acceptance");
  e.close();
});

test("R02-06/07: repair un-parks a mis-parked assessment, never a CTF flag campaign", () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadAssessmentSpec("r02r");
  e.createCampaign(spec);
  e.storage.setCampaignState("r02r", "active", { kind: "user", id: "t" });
  // simulate the old mis-park: awaiting_verify with no real review intent
  e.storage.persistPause("r02r", { kind: "controller", id: "engine" }, "awaiting_verify");
  const repaired = e.repair("r02r");
  assert.equal(repaired.repaired, true);
  assert.equal(e.storage.getCampaign("r02r").state, "active");
  const events = e.storage.list("events", "r02r").filter((ev) => ev.type === "campaign.repaired");
  assert.equal(events.length, 1);

  // a CTF goal campaign at awaiting_verify is not touched
  const ctf = loadDemoSpec("r02ctf");
  ctf.root_goal = { ...ctf.root_goal, success_predicate_ref: "flag_recovered" };
  e.createCampaign(ctf);
  e.storage.setCampaignState("r02ctf", "active", { kind: "user", id: "t" });
  e.storage.persistPause("r02ctf", { kind: "controller", id: "engine" }, "awaiting_verify");
  const refused = e.repair("r02ctf");
  assert.equal(refused.repaired, false);
  assert.equal(e.storage.getCampaign("r02ctf").state, "awaiting_verify");
  e.close();
});

// --- R04: one gate for every success path, with freshness ---

test("R04-01: tested coverage with stale evidence does not close a strict task", () => {
  const r = evaluateCompletion(
    baseSnap({
      mode: "goal_seeking",
      root_goal_satisfied: true,
      require_complete: true,
      coverage: [
        { id: "c1", mandatory: true, applicability: "applicable", execution_state: "tested", outcome: "no_issue_observed", evidence_state: "stale" },
      ],
    }),
  );
  assert.equal(r.canClose, false);
  assert.ok(r.blockers.includes("coverage_evidence_not_current"));
});

test("R04-02: tested but inconclusive coverage is not a strict completion", () => {
  const r = evaluateCompletion(
    baseSnap({
      mode: "goal_seeking",
      root_goal_satisfied: true,
      require_complete: true,
      coverage: [
        { id: "c1", mandatory: true, applicability: "applicable", execution_state: "tested", outcome: "inconclusive", evidence_state: "current" },
      ],
    }),
  );
  assert.equal(r.canClose, false);
  assert.ok(r.blockers.includes("coverage_inconclusive"));
});

test("R04-03: applicable mandatory obligations blocked or untested do not close", () => {
  for (const execution_state of ["blocked", "untested", "in_progress"] as const) {
    const r = evaluateCompletion(
      baseSnap({
        mode: "goal_seeking",
        root_goal_satisfied: true,
        require_complete: true,
        coverage: [{ id: "c1", mandatory: true, applicability: "applicable", execution_state, outcome: "none", evidence_state: "missing" }],
      }),
    );
    assert.equal(r.canClose, false, execution_state);
  }
});

test("R04-04: undecided applicability is not a silent skip under strict coverage", () => {
  const r = evaluateCompletion(
    baseSnap({
      mode: "goal_seeking",
      root_goal_satisfied: true,
      require_complete: true,
      coverage: [{ id: "c1", mandatory: true, applicability: "unknown", execution_state: "untested", outcome: "none", evidence_state: "missing" }],
    }),
  );
  assert.equal(r.canClose, false);
  assert.ok(r.blockers.includes("coverage_applicability_undecided"));
});

test("R04-05: not_applicable and waived obligations pass with their reasons intact", () => {
  const r = evaluateCompletion(
    baseSnap({
      mode: "goal_seeking",
      root_goal_satisfied: true,
      require_complete: true,
      coverage: [
        { id: "c1", mandatory: true, applicability: "not_applicable", execution_state: "untested", outcome: "none", evidence_state: "missing" },
        { id: "c2", mandatory: true, applicability: "applicable", execution_state: "waived", outcome: "none", evidence_state: "missing" },
      ],
    }),
  );
  assert.equal(r.canClose, true);
});
