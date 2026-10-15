/**
 * Process-wide container init coordination (H02).
 *
 * One entry per real container name merges concurrent cold starts across every
 * KaliRuntime instance in this process: the first caller becomes the creator,
 * later callers with the same fingerprint join the same promise. The entry is
 * registered synchronously before the init runs, and only removed by the entry
 * itself — a stale finally never deletes a newer retry's entry (K08).
 *
 * `verified` remembers which (name, fingerprint) pairs this process has already
 * validated (ownership labels + config), so the per-exec fast path stays one
 * inspect call. Entries are only trusted after an independent "is it running"
 * inspect, so a killed-and-foreign-recreated name is never silently reused.
 */
import { DomainError } from "../domain/errors.ts";

export interface ContainerInitEntry {
  fingerprint: string;
  promise: Promise<unknown>;
}

export class ContainerInitCoordinator {
  private readonly entries = new Map<string, ContainerInitEntry>();
  private readonly verified = new Map<string, string>();

  /** True while an init for `key` is in flight in this process. */
  inFlight(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Join the in-flight init for `key`, or become its creator. A fingerprint
   * mismatch is an explicit conflict — two configs never share one name.
   */
  join<T>(key: string, fingerprint: string, init: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new DomainError(
          "kali_init_conflict",
          `container ${key} is being initialized with a different configuration`,
          "denied",
        );
      }
      return existing.promise as Promise<T>;
    }
    const promise = (async () => init())();
    const entry: ContainerInitEntry = { fingerprint, promise };
    this.entries.set(key, entry);
    const cleanup = (): void => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  verifiedFingerprint(key: string): string | undefined {
    return this.verified.get(key);
  }

  markVerified(key: string, fingerprint: string): void {
    this.verified.set(key, fingerprint);
  }

  invalidate(key: string): void {
    this.verified.delete(key);
  }
}

/** Shared default: every KaliRuntime without an explicit coordinator uses this. */
export const processInitCoordinator = new ContainerInitCoordinator();
