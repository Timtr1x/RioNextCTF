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
  const decide = e.storage.claimDecide("v19", "t")!;
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
  const claimed = e.storage.claimNextStep("v19", "t", 1)!;
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
