import { createHash } from "node:crypto";
import type { ContextPack } from "../contracts/worker-runtime.ts";
import { SKILL_BY_METHOD_FAMILY } from "../domain/challenge-kind.ts";
import { hashJson } from "../domain/fingerprint.ts";
import type { ContextManifest, RunLease } from "../domain/types.ts";
import type { StorageService } from "../storage/service.ts";
import {
  binGroupsForCaps,
  CTF_PY_LIBS,
  isKaliProfile,
  KALI_BACKGROUND_BINS,
  resolveToolCapabilities,
} from "../tools/kali-profile.ts";
import { buildModelGraphView } from "./model-view.ts";
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

/** Any prompt-tree file (briefs/, env index), same dual-base lookup. */
function loadPromptFile(rel: string): string | null {
  for (const base of [join(here, "../../../prompts"), join(process.cwd(), "prompts")]) {
    try {
      const text = readFileSync(join(base, rel), "utf8").trim();
      if (text) return text;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * System prompt composition: generic mode prompt + task brief + (execute-only,
 * kali-only) environment index. The brief is derived from contract fields, not
 * from prompt text: assessment mode gets the assessment brief, a challenge
 * record or flag_recovered predicate gets the CTF brief, anything else stays
 * generic. The web brief rides on the resolved web capability. Domain skill
 * references stay in the user payload (skill_pack), never in the system text.
 */
export function composeSystemPrompt(
  mode: "decide" | "execute" | "finalize",
  spec: {
    mode: string;
    execution_profile: string;
    root_goal: { success_predicate_ref: string };
    challenge?: { kind: string; web_url?: string };
    scope: { entries: string[] };
  },
): string {
  const base = loadPrompt(mode);
  if (mode === "finalize") return base;
  const parts = [base];
  const briefRel =
    spec.mode === "assessment"
      ? "briefs/assessment.txt"
      : spec.challenge || spec.root_goal.success_predicate_ref === "flag_recovered"
        ? "briefs/ctf.txt"
        : null;
  if (briefRel) {
    const brief = loadPromptFile(briefRel);
    if (brief) parts.push(brief);
  }
  if (resolveToolCapabilities(spec).capabilities.includes("web")) {
    const web = loadPromptFile("briefs/web.txt");
    if (web) parts.push(web);
  }
  if (mode === "execute" && isKaliProfile(spec.execution_profile)) {
    const env = loadPromptFile("env-kali.txt");
    if (env) parts.push(env);
  }
  return parts.join("\n\n");
}

/**
 * Execute-only, kali-only, input-campaigns-only. The step's method_family picks
 * one skill file; the header lists the campaign's resolved capability set by
 * purpose so the model sees what exists without probing (unlisted tools are
 * banned), flags the background scanners, and names the ctf-python libraries.
 * The challenge kind only marks the recommended group; every listed group is
 * actually allowed. Web campaigns carry no spec.challenge and always get
 * skill_pack: null.
 */
function buildSkillPack(
  camp: {
    spec: {
      execution_profile: string;
      challenge?: { kind: string; seed_method_family: string; web_url?: string };
      scope: { entries: string[] };
    };
  },
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
  const resolved = resolveToolCapabilities(camp.spec);
  const caps = resolved.capabilities;
  const lines = [
    `# ${family}（${challenge.kind}）`,
    "本战役可用工具（未列出的一律不可用，禁止 apt/pip 安装；标注（推荐）只是按当前分类的建议，证据指向哪里就用哪组）：",
  ];
  const background: string[] = [];
  for (const [label, bins] of binGroupsForCaps(caps, challenge.kind)) {
    const list = [...bins].sort();
    lines.push(`- ${label}: ${list.join(" ")}`);
    for (const b of list) if (KALI_BACKGROUND_BINS.has(b)) background.push(b);
  }
  if (background.length > 0) {
    lines.push(`后台执行（返回 execution_id，勿轮询）: ${[...new Set(background)].sort().join(" ")}`);
  }
  if (caps.includes("ctf")) {
    const libs = new Set<string>();
    for (const group of Object.values(CTF_PY_LIBS)) group.forEach((l) => libs.add(l));
    lines.push(`ctf-python 已装库: ${[...libs].sort().join(" ")}`);
  }
  lines.push("", text);
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
/** Soft budget for the graph overview itself; observation previews get the rest. */
const SOFT_GRAPH_BUDGET = 120_000;

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
  // One short transaction: the whole initial view is a consistent snapshot.
  const view = storage.store.transaction(() =>
    buildModelGraphView(storage, lease.campaign_id, { currentStepId: lease.step_id ?? null, softBudget: SOFT_GRAPH_BUDGET }),
  );
  const observations = storage.graphQuery(lease.campaign_id, { entity: "observations", limit: 20, order: "desc" });
  const totalObservations = Number(
    (
      storage.store.db.prepare("SELECT COUNT(*) AS c FROM observations WHERE campaign_id = ?").get(lease.campaign_id) as {
        c: number;
      }
    ).c,
  );
  const hints = storage.listHints(lease.campaign_id);
  const checkpoint = storage.latestCheckpoint(lease.campaign_id, { runId: lease.run_id, stepId: lease.step_id });
  const budgetRow = storage.store.db
    .prepare("SELECT free_calls, free_tokens FROM budget_accounts WHERE campaign_id = ?")
    .get(lease.campaign_id) as { free_calls: number; free_tokens: number } | undefined;

  // Coverage only burdens models when the task actually carries coverage
  // obligations: assessment mode, or user-declared mandatory ids.
  const showCoverage = camp.spec.mode === "assessment" || camp.spec.coverage_policy.mandatory_ids.length > 0;
  const coverage = showCoverage
    ? storage.graphQuery(lease.campaign_id, { entity: "coverage", limit: 20 })
    : null;

  const omitted = [...view.omitted];
  const obsOmitted = totalObservations - observations.items.length;
  if (obsOmitted > 0) {
    omitted.push({
      kind: "observations",
      total: totalObservations,
      included: observations.items.length,
      omitted: obsOmitted,
      read_more: { entity: "observations", order: "desc", ids_param: true },
    });
  }

  const payload: Record<string, unknown> = {
    campaign_id: lease.campaign_id,
    run_id: lease.run_id,
    mode: lease.mode,
    goal: { statement: camp.spec.root_goal.statement, completion: camp.spec.root_goal.success_predicate_ref },
    scope: {
      assets: camp.spec.scope.assets,
      entries: camp.spec.scope.entries,
      exclusions: camp.spec.scope.exclusions,
    },
    resources: {
      remaining_calls: budgetRow?.free_calls ?? null,
      remaining_tokens: budgetRow?.free_tokens ?? null,
    },
    graph: {
      goals: view.goals,
      steps: view.steps,
      facts: view.facts,
      findings: view.findings,
      ...(coverage ? { coverage: coverage.items } : {}),
      observations: observations.items,
    },
    recent_results: recentResults(storage, lease.campaign_id),
    hints,
    pending_goal_claim: storage.pendingGoalClaim(lease.campaign_id),
    checkpoint,
    omitted,
    ...extra,
  };
  if (lease.step_id) {
    const step = storage.store.db.prepare("SELECT * FROM steps WHERE id = ?").get(lease.step_id) as
      | Record<string, unknown>
      | undefined;
    payload.current_step = step ? projectCurrentStep(step) : null;
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
    selected_entity_revisions: view.includedRevisions,
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
    system_prompt: composeSystemPrompt(lease.mode, camp.spec),
    user_payload: payload,
    tool_names,
  };
}

/** Current step projected for the model: parsed columns, no control fields. */
function projectCurrentStep(row: Record<string, unknown>): Record<string, unknown> {
  const parse = (key: string): unknown => {
    try {
      return JSON.parse(String(row[key] ?? "null"));
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    question: row.question,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    method_family: row.method_family,
    completion_criteria: row.completion_criteria,
    preconditions: parse("preconditions_json"),
    input_refs: parse("input_refs_json") ?? [],
    goal_refs: parse("goal_refs_json") ?? [],
    expected_observations: parse("expected_observations_json") ?? [],
    attempt_count: row.attempt_count,
    next_action: row.next_action ?? null,
    last_failure: row.last_failure ?? null,
    blocked_reason: row.blocked_reason ?? null,
  };
}

/** Recent execute results per §5.7: what the last runs concluded and proposed. */
function recentResults(storage: StorageService, campaignId: string, limit = 6): Record<string, unknown>[] {
  const rows = storage.store.db
    .prepare(
      `SELECT tr.step_id, tr.attempt_no, tr.end_reason, tr.outcome_json,
              s.question, s.next_action AS step_next_action, s.attempt_count
       FROM task_runs tr JOIN steps s ON s.id = tr.step_id
       WHERE tr.campaign_id = ? AND tr.step_id IS NOT NULL AND tr.outcome_json IS NOT NULL
       ORDER BY tr.rowid DESC LIMIT ?`,
    )
    .all(campaignId, limit) as {
    step_id: string;
    attempt_no: number;
    end_reason: string | null;
    outcome_json: string;
    question: string;
    step_next_action: string | null;
    attempt_count: number;
  }[];
  return rows.map((r) => {
    let outcome: { summary?: string; next_action?: string | null; reason?: string } = {};
    try {
      outcome = JSON.parse(r.outcome_json) as typeof outcome;
    } catch {
      // keep the empty outcome; the framework reason still shows
    }
    return {
      step_id: r.step_id,
      question: r.question.length > 200 ? `${r.question.slice(0, 200)}…` : r.question,
      attempt: r.attempt_no,
      attempt_count: r.attempt_count,
      summary: (outcome.summary ?? "").slice(0, 400),
      next_action: outcome.next_action ?? r.step_next_action ?? null,
      disposition: outcome.reason ?? null,
      end_reason: r.end_reason,
    };
  });
}
