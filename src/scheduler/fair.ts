import type { StorageService } from "../storage/service.ts";

export function pickFairReadyStep(storage: StorageService, campaignId: string, exclude?: ReadonlySet<string>): string | null {
  const steps = storage.store.db
    .prepare(
      `SELECT id, branch_id, kind, priority, ready_since, last_served_at FROM steps
       WHERE campaign_id = ? AND status = 'ready'`,
    )
    .all(campaignId)
    .filter((s) => !(exclude?.has(String((s as { id?: unknown }).id)) ?? false)) as {
    id: string;
    branch_id: string;
    kind: string;
    priority: number;
    ready_since: string | null;
    last_served_at: string | null;
  }[];
  if (steps.length === 0) return null;
  const wait = (s: (typeof steps)[0]) => (s.ready_since ? Date.parse(s.ready_since) : 0);
  const served = (s: (typeof steps)[0]) => (s.last_served_at ? Date.parse(s.last_served_at) : 0);
  const byBranch = new Map<string, (typeof steps)[0][]>();
  for (const s of steps) {
    const arr = byBranch.get(s.branch_id) ?? [];
    arr.push(s);
    byBranch.set(s.branch_id, arr);
  }
  const branches = [...byBranch.entries()].map(([id, list]) => ({
    id,
    lastServed: Math.max(...list.map(served)),
    oldest: Math.min(...list.map(wait)),
    best: list.slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.priority - b.priority || wait(a) - wait(b))[0]!,
  }));
  branches.sort((a, b) => a.lastServed - b.lastServed || a.oldest - b.oldest);
  return branches[0]!.best.id;
}

function kindRank(kind: string): number {
  if (kind === "verify") return 0;
  if (kind === "reconcile") return 1;
  if (kind === "acquire_prerequisite") return 2;
  return 3;
}
