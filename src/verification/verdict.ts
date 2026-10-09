import type { FindingStatus } from "../domain/types.ts";
import type { StorageService } from "../storage/service.ts";

export type VerifyFailClass = "refuted" | "missing_condition" | "stale_evidence" | "tool_error" | "inconclusive";

export function verdictFromFailClass(cls: VerifyFailClass): FindingStatus {
  if (cls === "refuted") return "refuted";
  if (cls === "stale_evidence") return "stale";
  return "inconclusive";
}

export function applyVerification(
  storage: StorageService,
  campaignId: string,
  findingId: string,
  cls: VerifyFailClass | "confirmed",
): FindingStatus {
  const finding = storage.store.db
    .prepare("SELECT status FROM findings WHERE id = ? AND campaign_id = ?")
    .get(findingId, campaignId) as { status: FindingStatus } | undefined;
  if (!finding) throw new Error("finding not found");
  if (finding.status === "suspected") {
    storage.setFindingStatus(campaignId, findingId, "validating", { kind: "controller", id: "verify" });
  }
  const next: FindingStatus = cls === "confirmed" ? "confirmed" : verdictFromFailClass(cls);
  const cur = (storage.store.db.prepare("SELECT status FROM findings WHERE id = ?").get(findingId) as { status: FindingStatus }).status;
  if (cur !== next) {
    storage.setFindingStatus(campaignId, findingId, next, { kind: "controller", id: "verify" });
  }
  if (cls === "missing_condition") {
    storage.updateCoverage(campaignId, "verify", { outcome: "inconclusive", execution_state: "blocked" });
  }
  return next;
}
