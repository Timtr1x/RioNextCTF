/**
 * Counting semaphore for shared async resources (provider calls).
 *
 * Invariants (see docs/multiworker-stabilization.md H01):
 *  - 0 <= active <= capacity at all times.
 *  - The queue holds only waiters that are not yet granted, not yet cancelled
 *    and not yet expired; cancelled/expired waiters are spliced out at once.
 *  - Handoff is atomic: release() grants the slot to the next valid waiter in
 *    the same synchronous turn (active stays constant); only when no valid
 *    waiter exists does active decrease.
 *  - Every Permit releases at most once; permits are the only way to release.
 */
import { invalidInput } from "../domain/errors.ts";

export interface Permit {
  release(): void;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Wall-clock deadline (Date.now() epoch ms) after which the wait fails. */
  deadlineAt?: number;
}

export class QueueDeadlineError extends Error {
  readonly code = "queue_deadline";
  constructor() {
    super("queue_deadline");
    this.name = "QueueDeadlineError";
  }
}

export function queueAbortError(): Error {
  const err = new Error("queue_aborted");
  err.name = "AbortError";
  return err;
}

type WaiterState = "queued" | "granted" | "cancelled";

interface Waiter {
  state: WaiterState;
  resolve: (permit: Permit) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  deadlineAt?: number;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
}

export class Semaphore {
  private activeCount = 0;
  private readonly waiters: Waiter[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1) {
      throw invalidInput("semaphore_capacity", `semaphore capacity must be a safe integer >= 1, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  get active(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(options: AcquireOptions = {}): Promise<Permit> {
    if (options.signal?.aborted) return Promise.reject(queueAbortError());
    if (options.deadlineAt != null && options.deadlineAt <= Date.now()) {
      return Promise.reject(new QueueDeadlineError());
    }
    if (this.activeCount < this.capacity) {
      this.activeCount += 1;
      return Promise.resolve(this.newPermit());
    }
    return new Promise<Permit>((resolve, reject) => {
      const waiter: Waiter = { state: "queued", resolve, reject, signal: options.signal, deadlineAt: options.deadlineAt };
      if (options.deadlineAt != null) {
        waiter.timer = setTimeout(() => this.cancel(waiter, new QueueDeadlineError()), options.deadlineAt - Date.now());
        // A forgotten waiter must not keep the process alive.
        waiter.timer.unref?.();
      }
      if (options.signal) {
        waiter.onAbort = () => this.cancel(waiter, queueAbortError());
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private newPermit(): Permit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.handoff();
      },
    };
  }

  /** Drop a queued waiter: out of the queue, timers/listeners cleaned, promise settles once. */
  private cancel(waiter: Waiter, err: Error): void {
    if (waiter.state !== "queued") return;
    waiter.state = "cancelled";
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
    this.detach(waiter);
    waiter.reject(err);
  }

  private detach(waiter: Waiter): void {
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.onAbort = undefined;
    }
  }

  /**
   * Atomic handoff: in one synchronous turn, skip dead waiters and grant the
   * slot to the first live one — active does not change in that case. Only a
   * queue with no live waiters frees the slot (active -= 1).
   */
  private handoff(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0]!;
      if (next.signal?.aborted) {
        this.cancel(next, queueAbortError());
        continue;
      }
      if (next.deadlineAt != null && next.deadlineAt <= Date.now()) {
        this.cancel(next, new QueueDeadlineError());
        continue;
      }
      next.state = "granted";
      this.waiters.shift();
      this.detach(next);
      next.resolve(this.newPermit());
      return;
    }
    this.activeCount -= 1;
  }
}
