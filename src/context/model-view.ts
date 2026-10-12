/**
 * Model-facing projection of the campaign graph. The database keeps the full
 * rows (revisions, JSON columns, control fields); this module turns them into
 * the compact objects the model actually reads, and computes honest
 * total/included/omitted counts when the view does not fit the soft budget.
 *
 * Presentation only: no new state machine. accepted+current reads as "known"
 * (not "verified"), proposed/derived reads as "hypothesis", disputed keeps its
 * counter evidence, anything not validity=current is "stale" and can never be
 * summarized as known.
 */
import type { ReadSetEntry } from "../domain/types.ts";
import type { StorageService } from "../storage/service.ts";

export interface ModelFact {
  id: string;
  claim: string;
  state: "known" | "hypothesis" | "disputed" | "stale";
  evidence_refs: string[];
  counter_refs: string[];
}

export interface ModelStep {
  id: string;
  question: string;
  status: string;
  priority: number;
  method_family?: string;
  next_action?: string;
  last_failure?: string;
}

export interface ModelFinding {
  id: string;
  claim: string;
  status: string;
  evidence_refs: string[];
}

export interface ModelGoal {
  id: string;
  statement: string;
  is_root: boolean;
  status: string;
  parent_id?: string;
}

export interface OmittedEntry {
  kind: string;
  total: number;
  included: number;
  omitted: number;
  /** graph_query paging order matches this view; ids=[...] reads by id. */
  read_more: { entity: string; order: "desc" | "asc"; ids_param: true };
}

export interface ModelGraphView {
  goals: ModelGoal[];
  steps: ModelStep[];
  facts: ModelFact[];
  findings: ModelFinding[];
  omitted: OmittedEntry[];
  /** Internal: real revisions of the included rows, for the context manifest. */
  includedRevisions: ReadSetEntry[];
}

const ACTIVE_STEP_STATUSES = new Set(["proposed", "ready", "leased", "running", "awaiting", "deferred", "blocked"]);

const CLAIM_CAP = 400;
const QUESTION_CAP = 300;
const STATEMENT_CAP = 400;
const FACT_CAP = 60;
const FINDING_CAP = 40;

interface FactRow {
  id: string;
  revision: number;
  proposition: string;
  epistemic_status: string;
  validity: string;
  support_refs_json: string;
  counter_refs_json: string;
}

interface StepRow {
  id: string;
  revision: number;
  question: string;
  status: string;
  priority: number;
  method_family: string | null;
  next_action: string | null;
  last_failure: string | null;
}

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…[${text.length - cap} more]` : text;
}

function parseRefs(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function projectFact(row: FactRow): ModelFact {
  const state: ModelFact["state"] =
    row.validity !== "current"
      ? "stale"
      : row.epistemic_status === "disputed"
        ? "disputed"
        : row.epistemic_status === "accepted"
          ? "known"
          : "hypothesis";
  return {
    id: row.id,
    claim: clip(row.proposition, CLAIM_CAP),
    state,
    evidence_refs: parseRefs(row.support_refs_json),
    counter_refs: parseRefs(row.counter_refs_json),
  };
}

export function projectStep(row: StepRow): ModelStep {
  const out: ModelStep = {
    id: row.id,
    question: clip(row.question, QUESTION_CAP),
    status: row.status,
    priority: row.priority,
  };
  if (row.method_family) out.method_family = row.method_family;
  if (row.next_action) out.next_action = clip(row.next_action, 200);
  if (row.last_failure) out.last_failure = clip(row.last_failure, 200);
  return out;
}

function omittedEntry(kind: string, total: number, included: number): OmittedEntry | null {
  if (included >= total) return null;
  return {
    kind,
    total,
    included,
    omitted: total - included,
    read_more: { entity: kind, order: kind === "facts" || kind === "observations" ? "desc" : "asc", ids_param: true },
  };
}

/** Fact selectors referenced by the current step. input_refs are EntityRef
 *  objects ({id, revision}) in production; legacy string arrays still read as
 *  ids. Preconditions are PredicateExpr: recurse all/any.of, collecting
 *  atom.fact_id as ids and atom.key as fact keys. No regex on free text. */
function linkedFactSelectors(storage: StorageService, stepId: string | null): { ids: string[]; keys: string[] } {
  if (!stepId) return { ids: [], keys: [] };
  const row = storage.store.db
    .prepare("SELECT input_refs_json, preconditions_json FROM steps WHERE id = ?")
    .get(stepId) as { input_refs_json: string; preconditions_json: string } | undefined;
  if (!row) return { ids: [], keys: [] };
  const ids = parseRefIds(row.input_refs_json);
  const keys: string[] = [];
  const walk = (expr: unknown): void => {
    if (!expr || typeof expr !== "object") return;
    const e = expr as { op?: unknown; fact_id?: unknown; key?: unknown; of?: unknown };
    if (e.op === "atom") {
      if (typeof e.fact_id === "string" && e.fact_id) ids.push(e.fact_id);
      if (typeof e.key === "string" && e.key) keys.push(e.key);
      return;
    }
    if ((e.op === "all" || e.op === "any") && Array.isArray(e.of)) {
      for (const sub of e.of) walk(sub);
    }
  };
  try {
    walk(JSON.parse(row.preconditions_json));
  } catch {
    // malformed preconditions yield no links
  }
  return { ids: [...new Set(ids)], keys: [...new Set(keys)] };
}

/** input_refs entries: production EntityRef objects, plus the legacy string form. */
function parseRefIds(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
        out.push((item as { id: string }).id);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Active-first graph overview. Retired/resolved history never crowds out the
 * live frontier; facts run linked → newest → older-fill, deduped; every omitted
 * class reports real counts. All reads happen in the caller's transaction.
 */
export function buildModelGraphView(
  storage: StorageService,
  campaignId: string,
  opts: { currentStepId?: string | null; softBudget: number },
): ModelGraphView {
  const db = storage.store.db;
  const revisions: ReadSetEntry[] = [];
  const omitted: OmittedEntry[] = [];

  const goalRows = db
    .prepare("SELECT id, revision, statement, is_root, status, parent_id FROM goals WHERE campaign_id = ? ORDER BY is_root DESC, created_seq ASC")
    .all(campaignId) as { id: string; revision: number; statement: string; is_root: number; status: string; parent_id: string | null }[];
  const goals: ModelGoal[] = goalRows.map((g) => {
    revisions.push({ table: "goals", id: g.id, revision: g.revision });
    const out: ModelGoal = { id: g.id, statement: clip(g.statement, STATEMENT_CAP), is_root: g.is_root === 1, status: g.status };
    if (g.parent_id) out.parent_id = g.parent_id;
    return out;
  });

  const stepRows = db
    .prepare(
      "SELECT id, revision, question, status, priority, method_family, next_action, last_failure FROM steps WHERE campaign_id = ? ORDER BY priority ASC, updated_seq DESC, id ASC",
    )
    .all(campaignId) as unknown as StepRow[];
  // the whole active frontier fits the soft budget in practice; retired and
  // resolved history never occupies the overview
  const activeSteps = stepRows.filter((s) => ACTIVE_STEP_STATUSES.has(s.status));
  const shownSteps = activeSteps.slice();
  for (const s of shownSteps) revisions.push({ table: "steps", id: s.id, revision: s.revision });

  const totalFacts = Number((db.prepare("SELECT COUNT(*) AS c FROM facts WHERE campaign_id = ?").get(campaignId) as { c: number }).c);
  const factById = new Map<string, FactRow>();
  const takeFacts = (rows: FactRow[], cap: number) => {
    for (const r of rows) {
      if (factById.size >= cap) break;
      if (!factById.has(r.id)) factById.set(r.id, r);
    }
  };
  const sel = `SELECT id, revision, proposition, epistemic_status, validity, support_refs_json, counter_refs_json FROM facts WHERE campaign_id = ?`;
  const linked = linkedFactSelectors(storage, opts.currentStepId ?? null);
  if (linked.ids.length > 0) {
    const marks = linked.ids.map(() => "?").join(",");
    takeFacts(
      db.prepare(`${sel} AND id IN (${marks})`).all(campaignId, ...linked.ids) as unknown as FactRow[],
      FACT_CAP,
    );
  }
  if (linked.keys.length > 0) {
    const marks = linked.keys.map(() => "?").join(",");
    takeFacts(
      db.prepare(`${sel} AND fact_key IN (${marks})`).all(campaignId, ...linked.keys) as unknown as FactRow[],
      FACT_CAP,
    );
  }
  // newest changes first, then older fill — disputed/stale stay visible
  takeFacts(
    db.prepare(`${sel} ORDER BY updated_seq DESC LIMIT ?`).all(campaignId, FACT_CAP * 2) as unknown as FactRow[],
    FACT_CAP,
  );
  const facts = [...factById.values()].map((f) => {
    revisions.push({ table: "facts", id: f.id, revision: f.revision });
    return projectFact(f);
  });

  const findingRows = db
    .prepare("SELECT id, revision, claim, status, evidence_refs_json FROM findings WHERE campaign_id = ? ORDER BY created_seq DESC LIMIT ?")
    .all(campaignId, FINDING_CAP + 1) as { id: string; revision: number; claim: string; status: string; evidence_refs_json: string }[];
  const totalFindings = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM findings WHERE campaign_id = ?").get(campaignId) as { c: number }).c,
  );
  const shownFindings = findingRows.slice(0, FINDING_CAP);
  const findings: ModelFinding[] = shownFindings.map((f) => {
    revisions.push({ table: "findings", id: f.id, revision: f.revision });
    return { id: f.id, claim: clip(f.claim, CLAIM_CAP), status: f.status, evidence_refs: parseRefs(f.evidence_refs_json) };
  });
  {
    const entry = omittedEntry("findings", totalFindings, findings.length);
    if (entry) omitted.push(entry);
  }

  const view: ModelGraphView = {
    goals,
    steps: shownSteps.map(projectStep),
    facts,
    findings,
    omitted,
    includedRevisions: revisions,
  };

  // Soft budget: shed the oldest fill facts first (linked and newest lanes are
  // protected), then the lowest-priority step tail — never the current step.
  const linkedCount = linked.ids.length + linked.keys.length;
  const factFloor = Math.min(linkedCount + 15, totalFacts);
  let guard = 0;
  while (JSON.stringify(view).length > opts.softBudget && guard < 10_000) {
    if (view.facts.length > factFloor && view.facts.length > 0) {
      const dropped = view.facts.pop()!;
      const i = view.includedRevisions.findIndex((r) => r.table === "facts" && r.id === dropped.id);
      if (i >= 0) view.includedRevisions.splice(i, 1);
    } else if (view.steps.length > 1) {
      const i = [...view.steps.keys()].reverse().find((i) => view.steps[i]!.id !== (opts.currentStepId ?? null));
      if (i === undefined) break;
      const dropped = view.steps.splice(i, 1)[0]!;
      const ri = view.includedRevisions.findIndex((r) => r.table === "steps" && r.id === dropped.id);
      if (ri >= 0) view.includedRevisions.splice(ri, 1);
    } else {
      break;
    }
    guard += 1;
  }
  const omittedFacts = omittedEntry("facts", totalFacts, view.facts.length);
  if (omittedFacts) view.omitted.push(omittedFacts);
  const omittedSteps = omittedEntry("steps", activeSteps.length, view.steps.length);
  if (omittedSteps) view.omitted.push(omittedSteps);
  return view;
}

/**
 * graph_query detail reads share the model field semantics with the overview:
 * business content stays, control columns (source_run_id, revisions, JSON
 * plumbing) do not come back. The worker records revisions from the raw rows
 * before this projection runs.
 */
export function projectGraphItems(entity: string, items: unknown[]): unknown[] {
  switch (entity) {
    case "facts":
      return items.map((i) => projectFact(i as unknown as FactRow));
    case "steps":
      return items.map((i) => projectStep(i as unknown as StepRow));
    case "findings":
      return items.map((i) => {
        const r = i as { id: string; claim: string; status: string; evidence_refs_json: string };
        return { id: r.id, claim: r.claim, status: r.status, evidence_refs: parseRefs(r.evidence_refs_json ?? "[]") };
      });
    case "goals":
      return items.map((i) => {
        const r = i as { id: string; statement: string; is_root: number; status: string; parent_id: string | null };
        return { id: r.id, statement: r.statement, is_root: r.is_root === 1, status: r.status, ...(r.parent_id ? { parent_id: r.parent_id } : {}) };
      });
    case "coverage":
      return items.map((i) => {
        const r = i as Record<string, unknown>;
        return {
          id: r.id,
          obligation: r.obligation,
          applicability: r.applicability,
          execution_state: r.execution_state,
          outcome: r.outcome,
          evidence_state: r.evidence_state,
          mandatory: r.mandatory,
        };
      });
    default:
      return items;
  }
}
