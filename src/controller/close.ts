import { evaluateCompletion } from "../domain/completion.ts";
import { DomainError } from "../domain/errors.ts";
import type { Engine } from "./engine.ts";

export function enterClosing(engine: Engine, campaignId: string): { H: number } {
  const camp = engine.storage.getCampaign(campaignId);
  if (camp.state !== "closing") {
    engine.storage.setCampaignState(campaignId, "closing", { kind: "controller", id: "close" });
  }
  engine.storage.store.db
    .prepare("UPDATE campaigns SET admission_open = 0, updated_at = datetime('now') WHERE id = ?")
    .run(campaignId);
  const H = engine.storage.getCampaign(campaignId).event_head;
  engine.storage.store.db
    .prepare("UPDATE campaigns SET reviewed_seq = ?, updated_at = datetime('now') WHERE id = ?")
    .run(H, campaignId);
  return { H };
}

export function commitCompletion(engine: Engine, campaignId: string, expectedH: number): { ok: true; snapshot_id: string } | { ok: false; reason: string } {
  return engine.storage.store.transaction(() => {
    const camp = engine.storage.getCampaign(campaignId);
    if (camp.event_head > expectedH) {
      return { ok: false as const, reason: "event_head_advanced" };
    }
    const snap = engine.snapshot(campaignId);
    if (snap.uncertain_invocations > 0) {
      // E19: name the unresolved calls — a plain count is not actionable.
      const ids = engine.invocations
        .nonTerminal(campaignId)
        .filter((i) => i.state === "uncertain")
        .map((i) => `${String(i.id)}(${String(i.error_json ?? "uncertain").slice(0, 80)})`)
        .slice(0, 8)
        .join(",");
      return { ok: false as const, reason: `uncertain_invocations:${ids}` };
    }
    if (camp.event_head !== expectedH) {
      return { ok: false as const, reason: "cas_conflict" };
    }
    const decision = evaluateCompletion(snap);
    if (!decision.canClose) {
      return { ok: false as const, reason: decision.blockers.join(",") || decision.suggestedState };
    }
    if (camp.state === "closing") {
      engine.storage.store.db.prepare("UPDATE campaigns SET state = 'completed', updated_at = datetime('now') WHERE id = ?").run(campaignId);
      engine.storage.appendEvent(campaignId, "campaign.state_changed", { from: "closing", to: "completed" }, { kind: "controller", id: "close" });
    } else if (camp.state !== "completed") {
      throw new DomainError("not_closing", "commitCompletion requires closing", "invalid_input");
    }
    const report = engine.writeReport(campaignId, "completed");
    const snapshot_id = String(engine.storage.latestReport(campaignId) ? engine.storage.getCampaign(campaignId).id : "");
    void report;
    return { ok: true as const, snapshot_id: snapshot_id || campaignId };
  });
}

export function regenerateReportFromSnapshot(
  engine: Engine,
  campaignId: string,
  destPath: string,
): { report: unknown; modelSends: number; toolSends: number } {
  const beforeModel = engine.modelSends;
  const beforeTool = engine.toolSends;
  const existing = engine.storage.latestReport(campaignId);
  if (!existing) throw new DomainError("no_snapshot", "no completion snapshot", "invalid_input");
  engine.writeReportFile(destPath, existing);
  return { report: existing, modelSends: engine.modelSends - beforeModel, toolSends: engine.toolSends - beforeTool };
}
