import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CampaignSpec } from "../domain/types.ts";

function projectRoot(): string {
  const candidates = [
    process.cwd(),
    join(process.cwd(), ".."),
    join(dirname(fileURLToPath(import.meta.url)), "../.."),
    join(dirname(fileURLToPath(import.meta.url)), "../../.."),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "profiles/demo-lab.json"))) return c;
  }
  return process.cwd();
}

const root = projectRoot();

export function loadDemoSpec(id = "camp_demo_lab"): CampaignSpec {
  const raw = JSON.parse(readFileSync(join(root, "profiles/demo-lab.json"), "utf8")) as CampaignSpec;
  return { ...raw, campaign_id: id };
}

export function loadAssessmentSpec(id = "camp_demo_assessment"): CampaignSpec {
  const raw = JSON.parse(readFileSync(join(root, "profiles/demo-assessment.json"), "utf8")) as CampaignSpec;
  return { ...raw, campaign_id: id };
}

export function loadKaliSpec(id = "camp_kali_lab"): CampaignSpec {
  const raw = JSON.parse(readFileSync(join(root, "profiles/kali-lab.json"), "utf8")) as CampaignSpec;
  return { ...raw, campaign_id: id };
}
