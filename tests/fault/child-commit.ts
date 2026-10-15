import { readFileSync } from "node:fs";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";

const data = process.argv[2]!;
const spec = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as { campaign_id: string };
const e = new Engine(makeRuntimeConfig(data), { silent: true, maxCycles: 1 });
e.createCampaign(spec);
const run = e.storage.claimDecideAsOwner(spec.campaign_id, "child")!;
e.storage.recordObservation({
  campaign_id: spec.campaign_id,
  producer_id: "child",
  submission_id: "child-obs",
  run_id: run.run_id,
  attempt_id: run.run_id,
  subject: "desk",
  body: { committed: true },
  artifact_refs: [],
  conditions: {},
  env_rev: "env-1",
});
e.close();
process.stdout.write("COMMITTED\n");
