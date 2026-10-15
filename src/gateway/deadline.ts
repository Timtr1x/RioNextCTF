export interface DeadlineResult<T> {
  ok: boolean;
  value?: T;
  residual: "none" | "uncertain" | "timeout";
}

export interface RunDeadlineSource {
  getRun(runId: string): Record<string, unknown>;
}

/**
 * An AbortSignal that fires when the run's DATABASE lease actually lapses —
 * not when a snapshot taken at call time says so. A live worker's heartbeats
 * keep moving the row, so a long call or a long queue wait is never truncated
 * by a stale initial TTL; a dead worker's calls still die within one poll of
 * the real expiry.
 */
export function leaseWatchSignal(
  storage: RunDeadlineSource,
  runId: string,
  pollMs = 2_000,
): { signal: AbortSignal; stop: () => void } {
  const ctrl = new AbortController();
  const poll = setInterval(() => {
    try {
      const dl = Number(storage.getRun(runId).deadline_ms);
      if (Date.now() >= dl) ctrl.abort();
    } catch {
      ctrl.abort();
    }
  }, pollMs);
  poll.unref();
  return { signal: ctrl.signal, stop: () => clearInterval(poll) };
}

export async function runWithOuterDeadline<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  ignoresAbort = false,
): Promise<DeadlineResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const work = fn(ctrl.signal);
    const raced = await Promise.race([
      work.then((value) => ({ tag: "ok" as const, value })),
      new Promise<{ tag: "timeout" }>((resolve) => {
        ctrl.signal.addEventListener("abort", () => resolve({ tag: "timeout" }));
      }),
    ]);
    if (raced.tag === "timeout") {
      if (!ignoresAbort) {
        return { ok: false, residual: "timeout" };
      }
      return { ok: false, residual: "uncertain" };
    }
    return { ok: true, value: raced.value, residual: "none" };
  } finally {
    clearTimeout(timer);
  }
}

/** Tool-dispatch guard: aborts the invocation when the run's real lease
 *  lapses (polled), leaving per-call timeouts to the container-side caps. */
export async function runWithLeaseWatch<T>(
  storage: RunDeadlineSource,
  runId: string,
  fn: (signal: AbortSignal) => Promise<T>,
  ignoresAbort = false,
): Promise<DeadlineResult<T>> {
  const watch = leaseWatchSignal(storage, runId);
  try {
    const work = fn(watch.signal);
    const raced = await Promise.race([
      work.then((value) => ({ tag: "ok" as const, value })),
      new Promise<{ tag: "timeout" }>((resolve) => {
        watch.signal.addEventListener("abort", () => resolve({ tag: "timeout" }));
      }),
    ]);
    if (raced.tag === "timeout") {
      if (!ignoresAbort) return { ok: false, residual: "timeout" };
      return { ok: false, residual: "uncertain" };
    }
    return { ok: true, value: raced.value, residual: "none" };
  } finally {
    watch.stop();
  }
}
