import { DomainError } from "./errors.ts";

export interface BudgetBuckets {
  total: number;
  free: number;
  reserved_inflight: number;
  unknown_liability: number;
  spent: number;
  uncovered_overrun: number;
}

export function assertConservation(b: BudgetBuckets): void {
  const sum = b.free + b.reserved_inflight + b.unknown_liability + b.spent;
  const expected = b.total + b.uncovered_overrun;
  if (sum !== expected) {
    throw new DomainError("budget_invariant", "budget buckets do not conserve", "protocol_error", {
      sum,
      expected,
      buckets: b,
    });
  }
}

export function reserve(b: BudgetBuckets, amount: number): BudgetBuckets {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new DomainError("invalid_reserve", "reserve amount must be a positive integer", "invalid_input");
  }
  if (b.free < amount) {
    throw new DomainError("budget_exhausted", "insufficient free budget", "budget", {
      free: b.free,
      amount,
    });
  }
  const next = { ...b, free: b.free - amount, reserved_inflight: b.reserved_inflight + amount };
  assertConservation(next);
  return next;
}

export function settle(b: BudgetBuckets, reserved: number, actual: number): BudgetBuckets {
  if (b.reserved_inflight < reserved) {
    throw new DomainError("settle_mismatch", "cannot settle more than reserved", "protocol_error");
  }
  let next: BudgetBuckets = {
    ...b,
    reserved_inflight: b.reserved_inflight - reserved,
  };
  if (actual <= reserved) {
    next.spent += actual;
    next.free += reserved - actual;
  } else {
    next.spent += actual;
    const extra = actual - reserved;
    if (next.free >= extra) {
      next.free -= extra;
    } else {
      next.uncovered_overrun += extra - next.free;
      next.free = 0;
    }
  }
  assertConservation(next);
  return next;
}
