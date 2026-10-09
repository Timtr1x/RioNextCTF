import { createHash } from "node:crypto";
import { DomainError } from "./errors.ts";
import { ALLOWED_PROPOSAL_OPS, type CampaignState, type ProposalOp } from "./types.ts";

/** Legacy default fingerprint: kind|method|question. Kept for merge compat. */
export function legacyStepFingerprint(kind: string, methodFamily: string, question: string): string {
  return createHash("sha256").update(`${kind}|${methodFamily}|${question}`).digest("hex").slice(0, 32);
}

/** Full default fingerprint: also binds goal refs, evidence refs and preconditions. */
export function defaultStepFingerprint(input: {
  kind: string;
  methodFamily: string;
  question: string;
  goalRefs: string[];
  inputRefs: { id: string }[];
  preconditions: unknown;
}): string {
  const canonical = JSON.stringify({
    kind: input.kind,
    methodFamily: input.methodFamily,
    question: input.question.trim().toLowerCase().replace(/\s+/g, " "),
    goalRefs: [...input.goalRefs].sort(),
    inputRefs: input.inputRefs.map((r) => r.id).sort(),
    preconditions: input.preconditions ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

const FORBIDDEN_ROOT_MUTATIONS = new Set(["set_root_goal", "enlarge_budget", "enlarge_scope", "complete_campaign"]);

export function parseProposalOps(input: unknown): ProposalOp[] {
  const list = Array.isArray(input) ? input : input && typeof input === "object" ? [input] : null;
  if (!list) {
    throw new DomainError("proposal_not_array", "proposal operations must be an array", "invalid_input");
  }
  return list.map((item, index) => parseOne(item, index));
}

function parseOne(item: unknown, index: number): ProposalOp {
  if (!item || typeof item !== "object") {
    throw new DomainError("proposal_op_invalid", `operation ${index} is not an object`, "invalid_input");
  }
  const raw = item as Record<string, unknown>;
  const opName =
    typeof raw.op === "string" && raw.op
      ? raw.op
      : typeof raw.question === "string" && raw.question
        ? "propose_step"
        : "";
  if (!opName) {
    throw new DomainError("proposal_op_missing", `operation ${index} missing op`, "invalid_input");
  }
  if (FORBIDDEN_ROOT_MUTATIONS.has(opName) || opName === "complete_campaign" || opName === "sql" || opName === "json_patch") {
    throw new DomainError("proposal_op_forbidden", `operation ${opName} is not allowed`, "denied", { op: opName });
  }
  if (!(ALLOWED_PROPOSAL_OPS as string[]).includes(opName)) {
    return coerceUnknownToStep(raw, opName);
  }
  const op = opName as ProposalOp["op"];
  switch (op) {
    case "propose_step": {
      const stepRaw = raw.step && typeof raw.step === "object" ? (raw.step as Record<string, unknown>) : raw;
      return { op, step: fillStep(stepRaw) };
    }
    case "revise_step_priority":
      return {
        op,
        step_id: reqStr(raw, "step_id"),
        // optional: the worker fills it from the internal read set
        expected_revision: typeof raw.expected_revision === "number" ? raw.expected_revision : undefined,
        priority: reqInt(raw, "priority"),
      };
    case "retire_step":
      return {
        op,
        step_id: reqStr(raw, "step_id"),
        expected_revision: typeof raw.expected_revision === "number" ? raw.expected_revision : undefined,
        reason: reqStr(raw, "reason"),
      };
    case "propose_subgoal":
      return {
        op,
        statement: reqStr(raw, "statement"),
        parent_id: reqStr(raw, "parent_id"),
        success_predicate_ref: typeof raw.success_predicate_ref === "string" ? raw.success_predicate_ref : undefined,
      };
    case "retire_subgoal":
      return {
        op,
        goal_id: reqStr(raw, "goal_id"),
        expected_revision: typeof raw.expected_revision === "number" ? raw.expected_revision : undefined,
        reason: reqStr(raw, "reason"),
      };
    case "propose_hypothesis":
      return {
        op,
        proposition: reqStr(raw, "proposition"),
        support_refs: strArr(raw, "support_refs"),
        conditions: (raw.conditions as Record<string, unknown>) ?? {},
      };
    case "request_verification":
      return {
        op,
        finding_or_fact_id: reqStr(raw, "finding_or_fact_id"),
        method: reqStr(raw, "method"),
      };
    case "propose_coverage_item":
      return {
        op,
        obligation: reqStr(raw, "obligation"),
        dimensions: (raw.dimensions as Record<string, string>) ?? {},
        mandatory: Boolean(raw.mandatory),
      };
    case "recommend_state": {
      const state = reqStr(raw, "state") as CampaignState;
      if (state === "completed") {
        throw new DomainError(
          "recommend_complete_forbidden",
          "models may recommend_state but completed is decided by the controller",
          "denied",
        );
      }
      return { op, state, reason: reqStr(raw, "reason") };
    }
    default:
      throw new DomainError("proposal_op_unknown", `unknown operation ${op}`, "invalid_input");
  }
}

function coerceUnknownToStep(raw: Record<string, unknown>, op: string): ProposalOp {
  const url = typeof raw.url === "string" ? raw.url : typeof raw.target === "string" ? raw.target : "";
  const question =
    (typeof raw.question === "string" && raw.question) ||
    (url && `${op} ${url}`) ||
    (typeof raw.path === "string" && `${op} ${raw.path}`) ||
    `Investigate authorized target using ${op}`;
  return { op: "propose_step", step: fillStep({ ...raw, question, methodFamily: slug(op) }) };
}

function fillStep(raw: Record<string, unknown>): ProposalOp extends { op: "propose_step" } ? ProposalOp["step"] : never {
  const question = typeof raw.question === "string" && raw.question ? raw.question : "inspect authorized target";
  const kind = raw.kind === "verify" || raw.kind === "reconcile" || raw.kind === "acquire_prerequisite" || raw.kind === "explore" ? raw.kind : "explore";
  const methodFamily =
    (typeof raw.methodFamily === "string" && raw.methodFamily) ||
    (typeof raw.method_family === "string" && raw.method_family) ||
    slug(question);
  return {
    question,
    kind,
    methodFamily,
    expectedObservations: Array.isArray(raw.expectedObservations)
      ? (raw.expectedObservations as string[])
      : Array.isArray(raw.expected_observations)
        ? (raw.expected_observations as string[])
        : [],
    completionCriteria: typeof raw.completionCriteria === "string" ? raw.completionCriteria : typeof raw.completion_criteria === "string" ? raw.completion_criteria : "observe",
    preconditions: (raw.preconditions as ProposalOp extends { op: "propose_step" } ? ProposalOp["step"]["preconditions"] : never) ?? { op: "all", of: [] },
    goalRefs: Array.isArray(raw.goalRefs) ? (raw.goalRefs as string[]) : Array.isArray(raw.goal_refs) ? (raw.goal_refs as string[]) : [],
    inputRefs: Array.isArray(raw.inputRefs) ? (raw.inputRefs as never) : Array.isArray(raw.input_refs) ? (raw.input_refs as never) : [],
    resourceClaims: Array.isArray(raw.resourceClaims) ? (raw.resourceClaims as never) : [],
    budgetHint: (raw.budgetHint as never) ?? {},
    fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : undefined,
    reopenRule: (raw.reopenRule as never) ?? (raw.reopen_rule as never) ?? { kind: "always" },
    branchId: typeof raw.branchId === "string" ? raw.branchId : typeof raw.branch_id === "string" ? raw.branch_id : undefined,
  } as ProposalOp extends { op: "propose_step" } ? ProposalOp["step"] : never;
}

function slug(s: string): string {
  const t = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (t || "explore").slice(0, 40);
}

function reqStr(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v !== "string" || !v) {
    throw new DomainError("proposal_field", `${key} is required`, "invalid_input");
  }
  return v;
}

function reqInt(raw: Record<string, unknown>, key: string): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new DomainError("proposal_field", `${key} must be an integer`, "invalid_input");
  }
  return v;
}

function strArr(raw: Record<string, unknown>, key: string): string[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new DomainError("proposal_field", `${key} must be a string array`, "invalid_input");
  }
  return v as string[];
}
