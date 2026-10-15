/**
 * S01–S09, S16: semaphore permit lifecycle — atomic handoff, cancellable queue,
 * FIFO fairness, capacity validation, mixed stress.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { QueueDeadlineError, Semaphore, type Permit } from "../../src/gateway/semaphore.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("S01: release hands the slot to a queued waiter before a new acquire in the same stack", async () => {
  const sem = new Semaphore(1);
  const pa = await sem.acquire();
  let bGranted: Permit | null = null;
  const pb = sem.acquire().then((p) => {
    bGranted = p;
    return p;
  });
  await tick(); // B is queued now
  assert.equal(sem.queued, 1);
  // The old bug: release() dropped active to 0 and only woke B later, so a
  // synchronous new acquire() here stole the slot. Now the handoff is atomic.
  pa.release();
  const pc = sem.acquire();
  await tick();
  assert.ok(bGranted, "B must have been granted by the handoff");
  assert.equal(sem.active, 1, "the slot stayed with B; C did not steal it");
  assert.equal(sem.queued, 1, "C queues behind the granted slot");
  (bGranted as Permit).release();
  const permitC = await pc;
  assert.equal(sem.active, 1);
  permitC.release();
  assert.equal(sem.active, 0);
  assert.equal(sem.queued, 0);
  await pb;
});

test("S02: a queued waiter that times out never wakes with a slot", async () => {
  const sem = new Semaphore(1);
  const pa = await sem.acquire();
  const outcome = sem
    .acquire({ deadlineAt: Date.now() + 30 })
    .then(() => "granted" as const)
    .catch((err) => (err instanceof QueueDeadlineError ? ("deadline" as const) : ("other" as const)));
  await tick();
  assert.equal(sem.queued, 1);
  assert.equal(await outcome, "deadline");
  assert.equal(sem.queued, 0, "timed-out waiter leaves the queue");
  pa.release();
  await tick();
  assert.equal(sem.active, 0, "no unmanaged holder survives");
  assert.equal(sem.queued, 0);
});

test("S03: acquire with an already-aborted signal rejects without queueing or holding a slot", async () => {
  const sem = new Semaphore(1);
  const pa = await sem.acquire();
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(sem.acquire({ signal: ctl.signal }), /queue_aborted/);
  assert.equal(sem.queued, 0);
  assert.equal(sem.active, 1);
  pa.release();
  assert.equal(sem.active, 0);
});

test("S04: aborting a queued waiter settles its promise and frees the queue", async () => {
  const sem = new Semaphore(1);
  const pa = await sem.acquire();
  const ctl = new AbortController();
  const outcome = sem.acquire({ signal: ctl.signal }).then(
    () => "granted" as const,
    (err) => (err?.name === "AbortError" ? ("aborted" as const) : ("other" as const)),
  );
  await tick();
  assert.equal(sem.queued, 1);
  ctl.abort();
  assert.equal(await outcome, "aborted");
  assert.equal(sem.queued, 0);
  pa.release();
  assert.equal(sem.active, 0, "slot frees normally; nobody stole it");
});

test("S05: grant vs abort in the same scheduling turn has exactly one winner", async () => {
  // abort first, then release -> the waiter is cancelled, the slot frees
  {
    const sem = new Semaphore(1);
    const pa = await sem.acquire();
    const ctl = new AbortController();
    const p = sem.acquire({ signal: ctl.signal }).then(
      () => "granted" as const,
      () => "aborted" as const,
    );
    await tick();
    ctl.abort();
    pa.release();
    assert.equal(await p, "aborted");
    assert.equal(sem.active, 0);
    assert.equal(sem.queued, 0);
  }
  // release first, then abort -> the waiter is already granted, abort is a no-op
  {
    const sem = new Semaphore(1);
    const pa = await sem.acquire();
    const ctl = new AbortController();
    let granted: Permit | null = null;
    const p = sem.acquire({ signal: ctl.signal }).then((x) => {
      granted = x;
      return "granted" as const;
    });
    await tick();
    pa.release();
    ctl.abort();
    assert.equal(await p, "granted");
    assert.ok(granted);
    assert.equal(sem.active, 1);
    (granted as Permit).release();
    assert.equal(sem.active, 0);
  }
});

test("S06: grant vs deadline in the same turn has exactly one winner", async () => {
  // deadline already past when the slot frees -> the waiter is expired, slot frees
  const sem = new Semaphore(1);
  const pa = await sem.acquire();
  const deadlineAt = Date.now() + 25;
  const p = sem.acquire({ deadlineAt }).then(
    () => "granted" as const,
    (err) => (err instanceof QueueDeadlineError ? ("deadline" as const) : ("other" as const)),
  );
  await tick();
  await new Promise((r) => setTimeout(r, 40)); // let the deadline pass while queued
  pa.release();
  assert.equal(await p, "deadline");
  assert.equal(sem.active, 0);
  assert.equal(sem.queued, 0);
  // a deadline in the past at acquire time rejects immediately
  await assert.rejects(sem.acquire({ deadlineAt: Date.now() - 1 }), QueueDeadlineError);
});

test("S07: double release does not go negative or wake extra waiters", async () => {
  const sem = new Semaphore(1);
  const pa = await sem.acquire();
  let grants = 0;
  const pb = sem.acquire().then((p) => {
    grants += 1;
    return p;
  });
  await tick();
  pa.release();
  pa.release(); // second release is a no-op
  const permitB = await pb;
  assert.equal(grants, 1);
  assert.equal(sem.active, 1);
  permitB.release();
  permitB.release();
  assert.equal(sem.active, 0);
});

test("S08: multiple waiters are granted FIFO, no queue-jumping", async () => {
  const sem = new Semaphore(1);
  const pa = await sem.acquire();
  const order: string[] = [];
  const mk = (name: string) =>
    sem.acquire().then((p) => {
      order.push(name);
      return p;
    });
  const p1 = mk("w1");
  const p2 = mk("w2");
  const p3 = mk("w3");
  await tick();
  assert.equal(sem.queued, 3);
  pa.release();
  (await p1).release();
  (await p2).release();
  (await p3).release();
  assert.deepEqual(order, ["w1", "w2", "w3"]);
  assert.equal(sem.active, 0);
  assert.equal(sem.queued, 0);
});

test("S09: invalid capacities are rejected", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new Semaphore(bad), /semaphore capacity/);
  }
});

test("S16: 200 rounds of mixed queue/timeout/cancel/handoff end with no leaks", async () => {
  const sem = new Semaphore(2);
  const dangling: Promise<unknown>[] = [];
  for (let round = 0; round < 200; round += 1) {
    const mode = round % 4;
    const hold = await sem.acquire();
    if (mode === 0) {
      // plain queue + release
      const p = sem.acquire();
      hold.release();
      (await p).release();
    } else if (mode === 1) {
      // queue with a deadline that fires while queued
      const outcome = sem
        .acquire({ deadlineAt: Date.now() + 5 })
        .then((p) => {
          p.release();
          return "granted" as const;
        })
        .catch(() => "deadline" as const);
      // sometimes the holder releases after the deadline
      await new Promise((r) => setTimeout(r, 10));
      hold.release();
      await outcome;
    } else if (mode === 2) {
      // queue then abort
      const ctl = new AbortController();
      const outcome = sem.acquire({ signal: ctl.signal }).then(
        (p) => {
          p.release();
          return "granted" as const;
        },
        () => "aborted" as const,
      );
      ctl.abort();
      hold.release();
      await outcome;
    } else {
      // grant races abort: abort after the handoff must not free the slot
      const ctl = new AbortController();
      const p = sem.acquire({ signal: ctl.signal });
      hold.release();
      const permit = await p;
      ctl.abort();
      permit.release();
    }
    // collect and forget settled promises so unhandled rejections would surface
    dangling.push(Promise.resolve().then(() => undefined));
  }
  // drain any stragglers
  await Promise.allSettled(dangling);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sem.active, 0, "no leaked slots");
  assert.equal(sem.queued, 0, "no leaked waiters");
});
