import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import type { TaskOutcome } from "../../src/domain/types.ts";
import { loadAssessmentSpec } from "../../src/eval/helpers.ts";
import { applyVerification } from "../../src/verification/verdict.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-cov-"));
}

function toolNamesCalled(messages: unknown[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; toolName?: string };
    if (msg.role === "toolResult" && typeof msg.toolName === "string") out.push(msg.toolName);
  }
  return out;
}

function outcome(runId: string): TaskOutcome {
  return {
    run_id: runId,
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
  };
}

interface Rig {
  e: Engine;
  covId: string;
  runId: string;
  fence: number;
}

/** Assessment campaign with one ready step claimed for execution. */
async function rig(id: string): Promise<Rig> {
  const e = new Engine(makeRuntimeConfig(tmp()), { silent: true, maxCycles: 1 });
  const spec = loadAssessmentSpec(id);
  e.createCampaign(spec);
  e.storage.setCampaignState(id, "active", { kind: "user", id: "t" });
  const decide = e.storage.claimDecideAsOwner(id, "t")!;
  const root = String(e.storage.list("goals", id)[0]!.id);
  const covId = String(e.storage.list("coverage_items", id).find((c) => c.obligation === "inspect-desk")!.id);
  e.storage.proposeStepDirect({
    campaign_id: id,
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
    fingerprint: `${id}-fp`,
    reopen_rule: { kind: "always" },
    input_refs: [{ id: covId, revision: e.storage.entityRevisionFor(id, covId)! }],
  });
  e.storage.finishRun(id, decide.run_id, outcome(decide.run_id));
  const claimed = e.storage.claimNextStepAsOwner(id, "t", 1)!;
  return { e, covId, runId: claimed.run_id, fence: claimed.fence };
}

function obs(e: Engine, campaignId: string, runId: string, envRev = "env-1", submissionTag = "o"): string {
  const o = e.storage.recordObservation({
    campaign_id: campaignId,
    producer_id: "t",
    submission_id: `${submissionTag}-${Math.random().toString(16).slice(2)}`,
    run_id: runId,
    attempt_id: runId,
    subject: "desk",
    body: { note: "test record" },
    artifact_refs: [],
    conditions: {},
    env_rev: envRev,
  });
  return o.canonical_ids.observation_id!;
}

function finishWith(r: Rig, coverageItem: Record<string, unknown>): { rejected: string[] } {
  const campaignId = campaignIdOf(r.e);
  const res = r.e.storage.submitRunOutcome({
    campaign_id: campaignId,
    run_id: r.runId,
    fence: r.fence,
    submission_id: `fin-${Math.random().toString(16).slice(2)}`,
    payload: {
      disposition: "resolved",
      summary: "tested",
      evidence_refs: (coverageItem.evidence_refs as string[]) ?? [],
      coverage_result: [coverageItem as never],
    },
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    source: "primary",
  });
  assert.equal(res.accepted, true, `finish rejected: ${res.error ?? ""}`);
  r.e.storage.finishRun(campaignId, r.runId, res.outcome!);
  const events = r.e.storage
    .list("events", campaignId)
    .filter((ev) => ev.type === "coverage.result_rejected")
    .map((ev) => String(ev.payload_json));
  return { rejected: events };
}

// rig() uses the spec's campaign id; track it per rig via a module map
const rigCampaign = new WeakMap<Engine, string>();
function campaignIdOf(e: Engine): string {
  return rigCampaign.get(e)!;
}

async function rigNamed(id: string): Promise<Rig> {
  const r = await rig(id);
  rigCampaign.set(r.e, id);
  return r;
}

function covState(e: Engine, id: string, covId: string): { execution_state: unknown; outcome: unknown; evidence_state: unknown } {
  const row = e.storage.list("coverage_items", id).find((c) => c.id === covId)!;
  return { execution_state: row.execution_state, outcome: row.outcome, evidence_state: row.evidence_state };
}

test("R03-01: old-env evidence cannot mark an item tested/current", async () => {
  const r = await rigNamed("r03a");
  const staleObs = obs(r.e, "r03a", r.runId, "env-old");
  const { rejected } = finishWith(r, { coverage_id: r.covId, outcome: "no_issue_observed", evidence_refs: [staleObs], note: "old env" });
  assert.ok(rejected.some((x) => x.includes("stale_evidence")), JSON.stringify(rejected));
  assert.notEqual(covState(r.e, "r03a", r.covId).execution_state, "tested");
  r.e.close();
});

test("R03-02/03: evidence must be this run's own test observation", async () => {
  const r = await rigNamed("r03b");
  // an artifact from another run is not a test record
  const art = await r.e.storage.putArtifact("r03b", "script contents", "text/plain", "run_other");
  const { rejected } = finishWith(r, { coverage_id: r.covId, outcome: "no_issue_observed", evidence_refs: [art.id], note: "script only" });
  assert.ok(rejected.some((x) => x.includes("not_this_run")), JSON.stringify(rejected));
  assert.notEqual(covState(r.e, "r03b", r.covId).execution_state, "tested");
  r.e.close();
});

test("R03-05: this run's fresh observation supports a bounded negative result", async () => {
  const r = await rigNamed("r03c");
  const good = obs(r.e, "r03c", r.runId);
  const { rejected } = finishWith(r, { coverage_id: r.covId, outcome: "no_issue_observed", evidence_refs: [good], note: "looked, nothing" });
  assert.deepEqual(rejected, []);
  const state = covState(r.e, "r03c", r.covId);
  assert.equal(state.execution_state, "tested");
  assert.equal(state.outcome, "no_issue_observed");
  r.e.close();
});

test("R03-06a: confirmed without finding_id is rejected", async () => {
  const r = await rigNamed("r03d1");
  const good = obs(r.e, "r03d1", r.runId);
  const out = finishWith(r, { coverage_id: r.covId, outcome: "confirmed", evidence_refs: [good], note: "no link" });
  assert.ok(out.rejected.some((x) => x.includes("finding_required")), JSON.stringify(out.rejected));
  assert.notEqual(covState(r.e, "r03d1", r.covId).execution_state, "tested");
  r.e.close();
});

test("R03-06b: confirmed with a merely-suspected finding is rejected", async () => {
  const r = await rigNamed("r03d2");
  const good = obs(r.e, "r03d2", r.runId);
  const f = r.e.storage.submitFinding({
    campaign_id: "r03d2",
    producer_id: "t",
    submission_id: "f1",
    run_id: r.runId,
    claim: "desk leak",
    evidence_refs: [good],
    dedup_key: "desk",
  });
  const out = finishWith(r, {
    coverage_id: r.covId,
    outcome: "confirmed",
    evidence_refs: [good],
    note: "suspected finding",
    finding_id: f.canonical_ids.finding_id!,
  });
  assert.ok(out.rejected.some((x) => x.includes("finding_not_confirmed")), JSON.stringify(out.rejected));
  assert.notEqual(covState(r.e, "r03d2", r.covId).execution_state, "tested");
  r.e.close();
});

test("R03-08: a finding from another campaign is rejected", async () => {
  const r = await rigNamed("r03f");
  const other = await rigNamed("r03g");
  const good = obs(r.e, "r03f", r.runId);
  const foreign = r.e.storage.submitFinding({
    campaign_id: "r03f",
    producer_id: "t",
    submission_id: "f1",
    run_id: r.runId,
    claim: "mine",
    evidence_refs: [good],
    dedup_key: "mine",
  });
  applyVerification(r.e.storage, "r03f", foreign.canonical_ids.finding_id!, "confirmed");
  // point at the OTHER campaign's finding id (exists there, not here)
  const foreignCovId = (await other.e.storage.list("coverage_items", "r03g")).map((c) => String(c.id));
  const out = finishWith(r, {
    coverage_id: r.covId,
    outcome: "confirmed",
    evidence_refs: [good],
    note: "cross campaign",
    finding_id: foreignCovId[0]!,
  });
  assert.ok(out.rejected.length > 0, "cross-campaign finding_id must be rejected");
  assert.notEqual(covState(r.e, "r03f", r.covId).execution_state, "tested");
  r.e.close();
  other.e.close();
});

test("R03-07: a legally confirmed finding with shared evidence backs a confirmed coverage result", async () => {
  const r = await rigNamed("r03e");
  const good = obs(r.e, "r03e", r.runId);
  const f = r.e.storage.submitFinding({
    campaign_id: "r03e",
    producer_id: "t",
    submission_id: "f1",
    run_id: r.runId,
    claim: "desk leak",
    evidence_refs: [good],
    dedup_key: "desk",
  });
  const findingId = f.canonical_ids.finding_id!;
  applyVerification(r.e.storage, "r03e", findingId, "confirmed");
  const { rejected } = finishWith(r, { coverage_id: r.covId, outcome: "confirmed", evidence_refs: [good], note: "confirmed via finding", finding_id: findingId });
  assert.deepEqual(rejected, []);
  const state = covState(r.e, "r03e", r.covId);
  assert.equal(state.execution_state, "tested");
  assert.equal(state.outcome, "confirmed");
  r.e.close();
});

test("F03: a fresh observation without the step declaring the obligation is rejected", async () => {
  const r = await rigNamed("f03");
  // strip the declaration: the step no longer names the coverage item
  r.e.storage.store.db.prepare("UPDATE steps SET input_refs_json = '[]'").run();
  const good = obs(r.e, "f03", r.runId);
  const { rejected } = finishWith(r, { coverage_id: r.covId, outcome: "no_issue_observed", evidence_refs: [good], note: "fresh but undeclared" });
  assert.ok(rejected.some((x) => x.includes("coverage_not_declared")), JSON.stringify(rejected));
  assert.notEqual(covState(r.e, "f03", r.covId).execution_state, "tested");
  r.e.close();
});

test("F03 e2e: the model declares the obligation via propose_step input_refs, no SQL needed", async () => {
  const dir = tmp();
  const spec = loadAssessmentSpec("f03e2e");
  if (!spec.tool_allowlist.includes("propose_step")) spec.tool_allowlist = [...spec.tool_allowlist, "propose_step"];
  const covHolder: { id: string } = { id: "" };
  const chooserFor = (e: Engine): import("../../src/runtime/pi/scripted-stream.ts").TurnChooser => {
    return (ctx) => {
      const first = ctx.messages[0] as { content?: { type?: string; text?: string }[] } | undefined;
      const payload = Array.isArray(first?.content) ? String(first.content[0]?.text ?? "") : "";
      const currentQuestion = payload.match(/"current_step":\s*\{[^}]*?"question":"([^"]+)"/)?.[1] ?? "";
      const called = toolNamesCalled(ctx.messages);
      if (currentQuestion === "seed work") {
        // first run: propose the obligation test with the coverage id declared
        if (!called.includes("propose_step")) {
          return {
            type: "tool_calls",
            calls: [
              { name: "propose_step", arguments: { question: "test the desk obligation", input_refs: [covHolder.id] } },
            ],
          };
        }
        return {
          type: "tool_calls",
          calls: [
            { name: "finish_step", arguments: { disposition: "deferred", summary: "proposed", next_action: "run it", reopen_rule: { kind: "always" } } },
          ],
        };
      }
      // second run (the declared step): gather evidence, finish with the result
      if (!called.includes("submit_observation")) {
        return { type: "tool_calls", calls: [{ name: "submit_observation", arguments: { subject: "desk", body: { ok: true } } }] };
      }
      if (!called.includes("finish_step")) {
        const obs = e.storage.list("observations", "f03e2e");
        const last = obs[obs.length - 1]!;
        return {
          type: "tool_calls",
          calls: [
            {
              name: "finish_step",
              arguments: {
                disposition: "resolved",
                summary: "tested",
                evidence_refs: [String(last.id)],
                coverage_result: [{ coverage_id: covHolder.id, outcome: "no_issue_observed", evidence_refs: [String(last.id)], note: "checked" }],
              },
            },
          ],
        };
      }
      return { type: "text", text: "done" };
    };
  };

  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 10 });
  e.createCampaign(spec);
  covHolder.id = String(e.storage.list("coverage_items", "f03e2e").find((c) => c.obligation === "inspect-desk")!.id);
  e.storage.setCampaignState("f03e2e", "active", { kind: "user", id: "t" });
  const chooseDecide = (ctx: { messages: unknown[] }): import("../../src/runtime/pi/scripted-stream.ts").ScriptedTurn => {
    const called = toolNamesCalled(ctx.messages);
    if (called.includes("propose_plan") && !called.includes("finish_decision")) {
      return { type: "tool_calls", calls: [{ name: "finish_decision", arguments: { summary: "ok" } }] };
    }
    if (called.includes("finish_decision")) return { type: "text", text: "done" };
    return { type: "tool_calls", calls: [{ name: "propose_plan", arguments: { operations: [], no_change_reason: "fine" } }] };
  };
  const chooseExecute = chooserFor(e);
  const e2 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 10, pollWaitMs: 20, chooseDecide, chooseExecute });
  void e;
  const root = String(e2.storage.list("goals", "f03e2e")[0]!.id);
  e2.storage.proposeStepDirect({
    campaign_id: "f03e2e",
    producer_id: "t",
    submission_id: "seed",
    question: "seed work",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "generic",
    expected_observations: [],
    completion_criteria: "done",
    fingerprint: "f03e2e-seed",
    reopen_rule: { kind: "always" },
  });
  await e2.start("f03e2e");
  const cov = e2.storage.list("coverage_items", "f03e2e").find((c) => c.id === covHolder.id)!;
  assert.equal(cov.execution_state, "tested", "the declared obligation is testable end to end");
  const step = e2.storage.list("steps", "f03e2e").find((s) => s.question === "test the desk obligation")!;
  assert.match(String(step.input_refs_json), new RegExp(covHolder.id), "input_refs persisted from the tool call");
  e.close();
  e2.close();
});
