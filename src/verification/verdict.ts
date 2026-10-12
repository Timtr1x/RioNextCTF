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
  evidenceRefs: string[] = [],
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
  // The verdict's evidence persists on the finding, not only in the event log.
  if (evidenceRefs.length > 0) {
    const row = storage.store.db.prepare("SELECT verification_refs_json FROM findings WHERE id = ?").get(findingId) as {
      verification_refs_json: string;
    };
    const cur2 = new Set(JSON.parse(row.verification_refs_json) as string[]);
    for (const r of evidenceRefs) cur2.add(r);
    storage.store.db
      .prepare("UPDATE findings SET verification_refs_json = ?, revision = revision + 1, updated_seq = updated_seq WHERE id = ?")
      .run(JSON.stringify([...cur2]), findingId);
  }
  if (cls === "missing_condition") {
    storage.updateCoverage(campaignId, "verify", { outcome: "inconclusive", execution_state: "blocked" });
  }
  return next;
}

/**
 * Fact-side verdict application, the controlled counterpart of submitFact
 * (which can never write verified). confirmed marks the fact verified and
 * merges the new evidence into its support refs; refuted disputes it and
 * records the counter evidence; inconclusive changes nothing. The caller
 * (applyTargetedVerification) is responsible for the event trail.
 */
export function applyFactVerdict(
  storage: StorageService,
  campaignId: string,
  factId: string,
  verdict: "confirmed" | "refuted" | "inconclusive",
  evidenceRefs: string[],
): { epistemic_status: string; source_grade: string } {
  const row = storage.store.db
    .prepare("SELECT epistemic_status, source_grade, support_refs_json, counter_refs_json FROM facts WHERE id = ? AND campaign_id = ?")
    .get(factId, campaignId) as
    | { epistemic_status: string; source_grade: string; support_refs_json: string; counter_refs_json: string }
    | undefined;
  if (!row) throw new Error("fact not found");
  const merge = (json: string, refs: string[]): string => {
    const cur = new Set(JSON.parse(json) as string[]);
    for (const r of refs) cur.add(r);
    return JSON.stringify([...cur]);
  };
  if (verdict === "confirmed") {
    storage.store.db
      .prepare("UPDATE facts SET source_grade = 'verified', epistemic_status = 'accepted', support_refs_json = ?, revision = revision + 1, updated_seq = ? WHERE id = ?")
      .run(merge(row.support_refs_json, evidenceRefs), nextSeq(storage, campaignId), factId);
    return { epistemic_status: "accepted", source_grade: "verified" };
  }
  if (verdict === "refuted") {
    storage.store.db
      .prepare("UPDATE facts SET epistemic_status = 'disputed', counter_refs_json = ?, revision = revision + 1, updated_seq = ? WHERE id = ?")
      .run(merge(row.counter_refs_json, evidenceRefs), nextSeq(storage, campaignId), factId);
    return { epistemic_status: "disputed", source_grade: row.source_grade };
  }
  return { epistemic_status: row.epistemic_status, source_grade: row.source_grade };
}

function nextSeq(storage: StorageService, campaignId: string): number {
  return storage.getCampaign(campaignId).event_head;
}
