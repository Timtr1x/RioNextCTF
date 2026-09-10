import { useEffect, useRef, useState } from "react";

export interface PollState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refresh: () => void;
}

/**
 * Poll `fn` every `ms`. Immediately fires once on mount and whenever deps
 * change. Never overlaps in-flight calls; stops on unmount. `ms <= 0` means
 * fetch once, no interval.
 */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): PollState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let dead = false;
    let inFlight = false;
    const run = async (): Promise<void> => {
      if (inFlight || dead) return;
      inFlight = true;
      try {
        const value = await fnRef.current();
        if (!dead) {
          setData(value);
          setError(undefined);
          setLoading(false);
        }
      } catch (err) {
        if (!dead) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      } finally {
        inFlight = false;
      }
    };
    void run();
    const timer = ms > 0 ? setInterval(() => void run(), ms) : null;
    return () => {
      dead = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ms, tick]);

  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}
