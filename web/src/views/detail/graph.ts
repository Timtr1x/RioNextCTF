import type { PendingClaim, Row, SpecSummary } from "../../api/types";
import { trunc } from "../../format";

export interface Entity {
  t: "goal" | "step" | "obs" | "fact" | "finding";
  id: string;
  label: string;
  sub: string;
  st: string;
  full: Record<string, unknown>;
}

export interface GraphData {
  cols: [string, number][];
  rows: Record<string, Entity[]>;
  centers: Record<string, { x: number; y: number }>;
  edges: [string, string][];
  byId: Record<string, Entity>;
  scale: number;
  maxH: number;
}

export function j(text: unknown, fallback: unknown): unknown {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Compose graph entities from the raw storage lists. Mirrors the mock's
 * entity model; obs→step goes through task_runs (observations only know
 * their source run).
 */
export function composeEntities(input: {
  spec: SpecSummary;
  steps: Row[];
  observations: Row[];
  facts: Row[];
  findings: Row[];
  goals: Row[];
  runs: Row[];
  pending: PendingClaim | null;
}): Entity[] {
  const out: Entity[] = [];
  const runStep = new Map<string, string>();
  for (const r of input.runs) {
    if (r.id && r.step_id) runStep.set(String(r.id), String(r.step_id));
  }

  const root = input.goals.find((g) => Number(g.is_root) === 1);
  out.push({
    t: "goal",
    id: str(root?.id) || "goal_root",
    label: `根目标：${trunc(input.spec.statement, 26)}`,
    sub: `success_predicate ${str(root?.success_predicate_ref) || "flag_recovered"}`,
    st: str(root?.status) || "active",
    full: {
      statement: input.spec.statement,
      success_predicate_ref: str(root?.success_predicate_ref) || "flag_recovered",
      source_run_id: root?.source_run_id ?? null,
      revision: root?.revision ?? 1,
    },
  });

  for (const s of input.steps) {
    out.push({
      t: "step",
      id: str(s.id),
      label: trunc(s.question, 30),
      sub: `${str(s.kind)} · ${str(s.method_family)}`,
      st: str(s.status),
      full: { ...s, reopen_rule: j(s.reopen_rule_json, null), preconditions: j(s.preconditions_json, null), goal_refs: j(s.goal_refs_json, []) },
    });
  }

  for (const o of input.observations) {
    const body = j(o.body_json, {});
    const summary =
      typeof (body as Record<string, unknown>).summary === "string"
        ? str((body as Record<string, unknown>).summary)
        : trunc(JSON.stringify(body), 80);
    out.push({
      t: "obs",
      id: str(o.id),
      label: trunc(o.subject, 30),
      sub: trunc(summary, 34),
      st: "recorded",
      full: {
        subject: str(o.subject),
        env_rev: str(o.env_rev),
        producer: runStep.get(str(o.source_run_id)) ?? str(o.source_run_id),
        summary,
        artifact_refs: j(o.artifact_refs_json, []),
        source_run_id: o.source_run_id ?? null,
        source_submission_id: o.source_submission_id ?? null,
        revision: o.revision ?? 1,
        observed_at: o.observed_at,
      },
    });
  }

  for (const f of input.facts) {
    const isPending = input.pending?.id === str(f.id);
    out.push({
      t: "fact",
      id: str(f.id),
      label: trunc(f.proposition, 30),
      sub: `key ${str(f.fact_key)} · ${str(f.source_grade)}`,
      st: isPending ? "pending" : str(f.epistemic_status),
      full: {
        ...f,
        support: j(f.support_refs_json, j(f.support_json, [])),
        pending_goal_claim: isPending,
      },
    });
  }

  for (const g of input.findings) {
    out.push({
      t: "finding",
      id: str(g.id),
      label: trunc(g.claim, 30),
      sub: str(g.status),
      st: str(g.status),
      full: { ...g, evidence: j(g.evidence_refs_json, []) },
    });
  }
  return out.filter((e) => e.id);
}

/** Layout port of the mock's buildGraph: fixed column widths, 92px row pitch. */
export function buildGraph(es: Entity[]): GraphData {
  const rows: Record<string, Entity[]> = { goal: [], step: [], obs: [], fact: [], finding: [] };
  es.forEach((e) => rows[e.t]!.push(e));
  const cols: [string, number][] = [
    ["goal", 260],
    ["step", 330],
    ["obs", 430],
    ["fact", 330],
    ["finding", 260],
  ];
  const byId = Object.fromEntries(es.map((e) => [e.id, e]));
  const centers: Record<string, { x: number; y: number }> = {};
  const W = 1100;
  let x = 50;
  const scale = Math.min(1.15, (W - 40) / Math.max(cols.reduce((a, [, w]) => a + w + 46, 0), 700));
  cols.forEach(([t, w]) => {
    rows[t]!.forEach((e, i) => {
      centers[e.id] = { x: x + (w * scale) / 2, y: 60 + i * 92 + 26 };
    });
    x += w * scale + 36;
  });

  const edges: [string, string][] = [];
  const goal = es.find((e) => e.t === "goal");
  if (goal) es.filter((e) => e.t === "step").forEach((s) => edges.push([goal.id, s.id]));
  es.filter((e) => e.t === "obs").forEach((o) => {
    const p = String(o.full.producer ?? "").trim();
    if (p && byId[p]) edges.push([p, o.id]);
  });
  es.filter((e) => e.t === "fact").forEach((f) => {
    const support = Array.isArray(f.full.support) ? (f.full.support as unknown[]) : [];
    support.forEach((r) => {
      if (byId[String(r)]) edges.push([String(r), f.id]);
    });
  });
  es.filter((e) => e.t === "finding").forEach((f) => {
    const evidence = Array.isArray(f.full.evidence) ? (f.full.evidence as unknown[]) : [];
    evidence.forEach((r) => {
      if (byId[String(r)]) edges.push([String(r), f.id]);
    });
  });
  es.filter((e) => e.t === "step").forEach((s) => {
    const rule = s.full.reopen_rule as { kind?: string; key?: string } | null;
    if (rule?.kind === "fact_key" && rule.key) {
      const tgt = es.find((e) => e.t === "fact" && str((e.full as Record<string, unknown>).fact_key) === rule.key);
      if (tgt) edges.push([tgt.id, s.id]);
    }
  });

  return { cols, rows, centers, edges, byId, scale, maxH: Math.max(420, ...Object.values(centers).map((p) => p.y + 60)) };
}
