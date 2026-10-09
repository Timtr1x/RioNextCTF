import { randomUUID } from "node:crypto";

export type IdPrefix =
  | "camp"
  | "goal"
  | "obs"
  | "fact"
  | "step"
  | "run"
  | "inv"
  | "find"
  | "cov"
  | "art"
  | "evt"
  | "sub"
  | "dec"
  | "ver"
  | "snap"
  | "corr"
  | "lock"
  | "op"
  | "br"
  | "prv"
  | "mdl"
  | "ckpt";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

export function newCorrelationId(): string {
  return newId("corr");
}
