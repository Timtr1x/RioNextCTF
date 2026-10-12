import type { PredicateExpr, TriValue } from "./types.ts";

export type FactLookup = (ref: { fact_id?: string; key?: string }) => TriValue;

export function evalPredicate(expr: PredicateExpr, lookup: FactLookup): TriValue {
  switch (expr.op) {
    case "atom":
      return lookup({ fact_id: expr.fact_id, key: expr.key });
    case "all":
      return evalAll(expr.of.map((child) => evalPredicate(child, lookup)));
    case "any":
      return evalAny(expr.of.map((child) => evalPredicate(child, lookup)));
  }
}

export function evalAll(values: TriValue[]): TriValue {
  if (values.some((v) => v === "false")) return "false";
  if (values.some((v) => v === "unknown")) return "unknown";
  return "true";
}

export function evalAny(values: TriValue[]): TriValue {
  if (values.some((v) => v === "true")) return "true";
  if (values.some((v) => v === "unknown")) return "unknown";
  return "false";
}

export function unknownNeverAdmits(value: TriValue): boolean {
  return value === "true";
}

/** Collect fact references from a PredicateExpr: atom.fact_id → ids, atom.key → keys, recursing all/any. */
export function collectFactRefs(expr: unknown): { ids: string[]; keys: string[] } {
  const ids: string[] = [];
  const keys: string[] = [];
  const walk = (e: unknown): void => {
    if (!e || typeof e !== "object") return;
    const x = e as { op?: unknown; fact_id?: unknown; key?: unknown; of?: unknown };
    if (x.op === "atom") {
      if (typeof x.fact_id === "string" && x.fact_id) ids.push(x.fact_id);
      if (typeof x.key === "string" && x.key) keys.push(x.key);
      return;
    }
    if ((x.op === "all" || x.op === "any") && Array.isArray(x.of)) {
      for (const sub of x.of) walk(sub);
    }
  };
  walk(expr);
  return { ids: [...new Set(ids)], keys: [...new Set(keys)] };
}
