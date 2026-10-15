import { readFileSync } from "node:fs";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";

const data = process.argv[2]!;
const spec = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as { campaign_id: string };
const e = new Engine(makeRuntimeConfig(data), { silent: true, maxCycles: 1 });
e.createCampaign(spec);
const decide = e.storage.claimDecideAsOwner(spec.campaign_id, "child")!;
const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
e.storage.proposeStepDirect({
  campaign_id: spec.campaign_id,
  producer_id: "child",
  submission_id: "child-step",
  run_id: decide.run_id,
  question: "f21 persist finish",
  kind: "explore",
  goal_refs: [root],
  preconditions: { op: "all", of: [] },
  method_family: "f21",
  expected_observations: ["marker"],
  completion_criteria: "observe",
  fingerprint: "f21-fp",
  reopen_rule: { kind: "always" },
});
e.storage.finishRun(spec.campaign_id, decide.run_id, {
  run_id: decide.run_id,
  step_id: null,
  mode: "decide",
  reason: "resolved",
  summary: "seeded",
  observation_ids: [],
  fact_ids: [],
  finding_ids: [],
  blocked_on: null,
  reopen_rule: null,
  finish_requested: true,
  protocol_error: null,
});
const obs = e.storage.recordObservation({
  campaign_id: spec.campaign_id,
  producer_id: "child",
  submission_id: "child-obs",
  run_id: decide.run_id,
  attempt_id: decide.run_id,
  subject: "f21-ev",
  body: { ok: true },
  artifact_refs: [],
  conditions: {},
  env_rev: "env-1",
});
const claimed = e.storage.claimNextStepAsOwner(spec.campaign_id, "child", e.storage.getCampaign(spec.campaign_id).epoch)!;
const submitted = e.storage.submitRunOutcome({
  campaign_id: spec.campaign_id,
  run_id: claimed.run_id,
  fence: claimed.fence,
  submission_id: "f21-sub",
  payload: {
    disposition: "resolved",
    summary: "persisted before finishRun",
    evidence_refs: [obs.canonical_ids.observation_id!],
  },
  observation_ids: [obs.canonical_ids.observation_id!],
  fact_ids: [],
  finding_ids: [],
  source: "primary",
});
if (!submitted.accepted) {
  process.stderr.write(`SUBMIT_FAIL ${submitted.error}\n`);
  process.exit(2);
}
process.stdout.write(`RUN ${claimed.run_id}\nSTEP ${claimed.step_id}\nCOMMITTED\n`);
e.close();
