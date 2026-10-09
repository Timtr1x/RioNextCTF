import type { StorageService } from "../storage/service.ts";

export function markFactsStaleForEnv(storage: StorageService, campaignId: string, newEnvRev: string): number {
  const rows = storage.store.db
    .prepare("SELECT id, env_rev FROM facts WHERE campaign_id = ? AND validity = 'current'")
    .all(campaignId) as { id: string; env_rev: string | null }[];
  let n = 0;
  for (const r of rows) {
    if (r.env_rev && r.env_rev !== newEnvRev) {
      storage.store.db
        .prepare("UPDATE facts SET validity = 'stale', epistemic_status = CASE WHEN epistemic_status = 'accepted' THEN 'stale' ELSE epistemic_status END, revision = revision + 1 WHERE id = ?")
        .run(r.id);
      storage.appendEvent(campaignId, "fact.invalidated", { fact_id: r.id, reason: "env_revision", newEnvRev }, { kind: "controller", id: "stale" }, r.id);
      n += 1;
    }
  }
  storage.recomputeStepReadiness(campaignId);
  const readyButStale = storage.store.db
    .prepare("SELECT id, preconditions_json FROM steps WHERE campaign_id = ? AND status = 'ready'")
    .all(campaignId) as { id: string; preconditions_json: string }[];
  for (const s of readyButStale) {
    storage.recomputeStepReadiness(campaignId);
  }
  void sCount(readyButStale.length);
  return n;
}

function sCount(n: number): number {
  return n;
}
