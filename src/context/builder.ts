import { createHash } from "node:crypto";
import type { ContextPack } from "../contracts/worker-runtime.ts";
import { SKILL_BY_METHOD_FAMILY } from "../domain/challenge-kind.ts";
import { hashJson } from "../domain/fingerprint.ts";
import type { ContextManifest, ReadSetEntry, RunLease } from "../domain/types.ts";
import type { StorageService } from "../storage/service.ts";
import { binGroupsFor, isKaliProfile, KALI_BACKGROUND_BINS, pyLibsFor } from "../tools/kali-profile.ts";
import { PROMPT_VERSION } from "../version.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadPrompt(mode: "decide" | "execute" | "finalize"): string {
  const name = mode === "decide" ? "decide.txt" : mode === "finalize" ? "finalize-execute.txt" : "execute.txt";
  const candidates = [
    join(here, "../../../prompts", name),
    join(process.cwd(), "prompts", name),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      // try next
    }
  }
  if (mode === "decide") return "Propose typed plan operations, then finish_decision. Do not complete the campaign.";
  if (mode === "finalize") {
    return "当前 Execute 片段已经停止，必须立即提交片段结果。你只能调用 finish_step，不能继续探索。";
  }
  return "Solve the current step with approved tools, submit observations, then finish_step.";
}

/** Skill text is optional and file-backed; a missing file never fails a run. */
export function loadSkill(file: string): string | null {
  for (const base of [join(here, "../../../prompts/skills"), join(process.cwd(), "prompts/skills")]) {
    try {
      const text = readFileSync(join(base, file), "utf8").trim();
      if (text) return text;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Execute-only, kali-only, input-campaigns-only. The step's method_family picks
 * one skill file; the header lists the kind's allowlist by purpose so the model
 * sees what exists without probing (unlisted tools are banned), flags the
 * background scanners, and names the ctf-python libraries. Web campaigns carry
 * no spec.challenge and always get skill_pack: null.
 */
function buildSkillPack(
  camp: { spec: { execution_profile: string; challenge?: { kind: string; seed_method_family: string } } },
  step: unknown,
): string | null {
  const challenge = camp.spec.challenge;
  if (!challenge || challenge.kind === "web") return null;
  if (!isKaliProfile(camp.spec.execution_profile)) return null;
  const family =
    step && typeof step === "object" && typeof (step as { method_family?: unknown }).method_family === "string"
      ? ((step as { method_family: string }).method_family as string)
      : "";
  const file = SKILL_BY_METHOD_FAMILY[family] ?? SKILL_BY_METHOD_FAMILY[challenge.seed_method_family];
  if (!file) return null;
  const text = loadSkill(file);
  if (!text) return null;
  const lines = [`# ${family}（${challenge.kind}）`, "本战役可用工具（未列出的一律不可用，禁止 apt/pip 安装）："];
  const background: string[] = [];
  for (const [label, bins] of binGroupsFor(challenge.kind)) {
    const list = [...bins].sort();
    lines.push(`- ${label}: ${list.join(" ")}`);
    for (const b of list) if (KALI_BACKGROUND_BINS.has(b)) background.push(b);
  }
  if (background.length > 0) {
    lines.push(`后台执行（返回 execution_id，勿轮询）: ${background.sort().join(" ")}`);
  }
  lines.push(`ctf-python 已装库: ${pyLibsFor(challenge.kind).join(" ")}`, "", text);
  return lines.join("\n");
}

/**
 * Adaptive observation-body fit for the context pack. A worker that dumps a
 * whole file into one observation (tool_raw with a huge body) must not brick
 * the campaign, but a fixed small cap also starves the model of context: the
 * pack has a 400k budget, so we measure everything else first and split what
 * is left across the newest-20 observation window (clamped to [MIN, MAX] per
 * item). Truncated bodies point at graph_query so the worker can page the
 * full text itself; the observations table always keeps the untruncated copy.
 */
const PACK_HARD_LIMIT = 400_000;
const PACK_SAFETY_MARGIN = 20_000;
const OBS_ITEM_MIN = 2_000;
const OBS_ITEM_MAX = 64_000;

function fitObservationBodies(payload: Record<string, unknown>, items: unknown[]): void {
  if (items.length === 0) return;
  const bodies = items.map((item) => {
    const body = (item as { body_json?: unknown }).body_json;
    return typeof body === "string" ? body : "";
  });
  const totalBodies = bodies.reduce((sum, body) => sum + body.length, 0);
  if (totalBodies === 0) return;
  // The serialized payload already contains the bodies; subtracting their raw
  // lengths slightly underestimates the stripped size (JSON escaping), which
  // makes the budget conservative.
  const strippedLen = JSON.stringify(payload).length - totalBodies;
  const budget = PACK_HARD_LIMIT - PACK_SAFETY_MARGIN - strippedLen;
  const cap = Math.max(OBS_ITEM_MIN, Math.min(OBS_ITEM_MAX, Math.floor(budget / items.length)));
  for (let i = 0; i < items.length; i++) {
    const body = bodies[i] ?? "";
    if (body.length > cap) {
      (items[i] as { body_json: string }).body_json =
        body.slice(0, cap) +
        `...[truncated ${body.length - cap} chars in context pack; full body via graph_query(entity="observations", order="desc") with offset paging]`;
    }
  }
}

export function buildContextPack(storage: StorageService, lease: RunLease, extra: Record<string, unknown> = {}): ContextPack {
  const camp = storage.getCampaign(lease.campaign_id);
  const facts = storage.graphQuery(lease.campaign_id, { entity: "facts", limit: 30 });
  const steps = storage.graphQuery(lease.campaign_id, { entity: "steps", limit: 30 });
  const goals = storage.graphQuery(lease.campaign_id, { entity: "goals", limit: 20 });
  const findings = storage.graphQuery(lease.campaign_id, { entity: "findings", limit: 20 });
  const coverage = storage.graphQuery(lease.campaign_id, { entity: "coverage", limit: 20 });
  const observations = storage.graphQuery(lease.campaign_id, { entity: "observations", limit: 20, order: "desc" });
  const hints = storage.listHints(lease.campaign_id);
  const checkpoint = storage.latestCheckpoint(lease.campaign_id, { runId: lease.run_id, stepId: lease.step_id });
  const payload: Record<string, unknown> = {
    campaign_id: lease.campaign_id,
    mode: lease.mode,
    run_id: lease.run_id,
    fence: lease.fence,
    cancel_epoch: lease.cancel_epoch,
    root_goal: camp.spec.root_goal,
    scope: camp.spec.scope,
    policy_version: camp.spec.policy_version,
    scope_version: camp.spec.scope_version,
    goal_version: camp.spec.goal_version,
    remaining_budget: {
      calls: storage.store.db.prepare("SELECT free_calls FROM budget_accounts WHERE campaign_id = ?").get(lease.campaign_id),
    },
    graph: { facts: facts.items, steps: steps.items, goals: goals.items, findings: findings.items, coverage: coverage.items, observations: observations.items },
    hints,
    pending_goal_claim: storage.pendingGoalClaim(lease.campaign_id),
    checkpoint,
    omitted: [facts, steps, goals, findings, coverage, observations].filter((g) => g.truncated).map((g) => ({ truncated: true })),
    ...extra,
  };
  if (lease.step_id) {
    const step = storage.store.db.prepare("SELECT * FROM steps WHERE id = ?").get(lease.step_id);
    payload.current_step = step;
    if (lease.mode === "execute") {
      payload.skill_pack = buildSkillPack(camp, step);
    }
  }
  fitObservationBodies(payload, observations.items);
  const encoded = JSON.stringify(payload);
  if (encoded.length > PACK_HARD_LIMIT) {
    throw new Error("context_capacity: required invariant content does not fit");
  }
  const manifest: ContextManifest = {
    run_id: lease.run_id,
    mode: lease.mode,
    prompt_version: PROMPT_VERSION,
    tool_schema_hash: hashJson(lease.mode),
    graph_snapshot_seq: camp.event_head,
    root_goal_version: camp.spec.goal_version,
    scope_version: camp.spec.scope_version,
    policy_version: camp.spec.policy_version,
    model_id: camp.spec.model_policy.model,
    selected_entity_revisions: entityRevisions(facts.items, steps.items, goals.items),
    artifact_slices: [],
    omitted_items: payload.omitted as ContextManifest["omitted_items"],
    estimated_tokens: Math.ceil(encoded.length / 4),
    context_hash: createHash("sha256").update(encoded).digest("hex"),
  };
  storage.saveManifest(lease.run_id, manifest);
  const baseNames =
    lease.mode === "decide"
      ? ["graph_query", "artifact_read", "propose_plan", "checkpoint", "finish_decision"]
      : isKaliProfile(camp.spec.execution_profile)
        ? [
            "graph_query",
            "artifact_read",
            "submit_observation",
            "submit_fact",
            "submit_finding",
            "propose_step",
            "checkpoint",
            "finish_step",
            "kali_run",
            "kali_write",
            "playwright",
          ]
        : [
            "graph_query",
            "artifact_read",
            "submit_observation",
            "submit_fact",
            "submit_finding",
            "propose_step",
            "checkpoint",
            "finish_step",
            "world_inspect",
            "world_act",
          ];
  const allow = camp.spec.tool_allowlist;
  const tool_names = allow.length ? baseNames.filter((n) => allow.includes(n)) : baseNames;
  return {
    manifest,
    system_prompt: loadPrompt(lease.mode),
    user_payload: payload,
    tool_names,
  };
}

function entityRevisions(facts: unknown[], steps: unknown[], goals: unknown[]): ReadSetEntry[] {
  const out: ReadSetEntry[] = [];
  const take = (table: string, rows: unknown[]) => {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as { id?: unknown; revision?: unknown };
      if (typeof r.id === "string") out.push({ table, id: r.id, revision: Number(r.revision ?? 1) });
    }
  };
  take("facts", facts);
  take("steps", steps);
  take("goals", goals);
  return out;
}
