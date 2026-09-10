import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { usePoll } from "../../hooks/usePoll";
import { ActionButton, KV } from "../../components/ui";
import { fmtNum, fmtTime, trunc } from "../../format";
import type { CampaignView, Row } from "../../api/types";

interface Bar {
  id: string;
  lane: "model" | "tool";
  label: string;
  startMs: number;
  endMs: number;
  cls: "m" | "t" | "unc" | "fin";
  tokens: number;
  state: string;
  exec: string | null;
  err: string | null;
}

function toBar(row: Row, t0: number): Bar {
  const created = Date.parse(String(row.created_at ?? "")) || t0;
  const updated = Date.parse(String(row.updated_at ?? "")) || created;
  const kind = String(row.kind ?? "tool");
  const state = String(row.state ?? "");
  const purpose = String(row.purpose ?? row.call_id ?? kind);
  const isFinalize = /finaliz/i.test(purpose) || String(row.status ?? "") === "finalized";
  let cls: Bar["cls"] = kind === "model" ? "m" : "t";
  if (state === "uncertain") cls = "unc";
  else if (isFinalize && kind === "model") cls = "fin";
  let err: string | null = null;
  if (row.error_json) {
    try {
      const parsed = JSON.parse(String(row.error_json)) as { message?: string };
      err = parsed.message ?? String(row.error_json).slice(0, 120);
    } catch {
      err = String(row.error_json).slice(0, 120);
    }
  }
  return {
    id: String(row.id),
    lane: kind === "model" ? "model" : "tool",
    label: trunc(purpose, 40),
    startMs: created,
    endMs: Math.max(updated, created + 1500),
    cls,
    tokens: Number(row.actual_tokens ?? 0),
    state,
    exec: row.external_id ? String(row.external_id) : null,
    err,
  };
}

export function TimelineTab({ view }: { view: CampaignView }): JSX.Element {
  const id = view.campaign_id;
  const { data } = usePoll(() => api.list(id, "invocations"), 3000, [id]);
  const [sel, setSel] = useState<Bar | null>(null);

  const { bars, t0, span } = useMemo(() => {
    const rows = (data?.rows ?? []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const t0 = rows.length ? Date.parse(String(rows[0]!.created_at)) || Date.now() : Date.now();
    const bars = rows.map((r) => toBar(r, t0));
    const end = bars.reduce((a, b) => Math.max(a, b.endMs), t0 + 60_000);
    return { bars, t0, span: Math.max(end - t0, 60_000) };
  }, [data]);

  if (!bars.length) {
    return <div className="detail-pane" style={{ gridColumn: "1/-1", padding: 14 }}><div className="timeline mini">该战役还没有调用记录。</div></div>;
  }

  const tickCount = 7;
  const tickMs = span / (tickCount - 1);
  const fmtTick = (ms: number): string => {
    const min = Math.round(ms / 60000);
    return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}m`;
  };

  return (
    <div className="detail-pane" style={{ gridColumn: "1/-1" }}>
      <div className="timeline">
        <div className="mini" style={{ marginBottom: 8 }}>
          Execute 调用流 · model/tool 泳道 · 起点 {fmtTime(new Date(t0).toISOString())} · 截断、后台、补交都标在条上
        </div>
        <div className="ticks">
          {Array.from({ length: tickCount }, (_, i) => (
            <span key={i}>+{fmtTick(i * tickMs)}</span>
          ))}
        </div>
        {bars.map((b) => (
          <div className="lane" key={b.id}>
            <div className="name">{b.lane}</div>
            <div className="track">
              <div
                className={`bar ${b.cls}`}
                style={{
                  left: `${((b.startMs - t0) / span) * 100}%`,
                  width: `${Math.max(((b.endMs - b.startMs) / span) * 100, 3)}%`,
                }}
                title={b.label}
                onClick={() => setSel(b)}
              >
                {b.label}
                {b.tokens ? ` · ${fmtNum(b.tokens)} tok` : ""}
                {b.state === "uncertain" ? " · uncertain" : ""}
                {b.state === "failed" ? " · failed" : ""}
                {b.exec?.startsWith("kali_") ? ` · ${b.exec}` : ""}
              </div>
            </div>
          </div>
        ))}
        <div className="card mt">
          <h3>图例</h3>
          <KV k="蓝 / 绿">model / tool 正常完成</KV>
          <KV k="红虚线">uncertain 或 failed → 点条 reconcile</KV>
          <KV k="琥珀">finalize 补交（finish_step 未交时控制器补一轮）</KV>
          <KV k="kali_inv_*">后台扫描，控制器按 execution_id 收 stdout</KV>
        </div>
      </div>
      {sel && <BarModal view={view} bar={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function BarModal({ view, bar, onClose }: { view: CampaignView; bar: Bar; onClose: () => void }): JSX.Element {
  const id = view.campaign_id;
  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <span className="close" onClick={onClose}>✕</span>
        <h2>invocation · {bar.id}</h2>
        <KV k="lane / purpose">{bar.lane} · {bar.label}</KV>
        <KV k="state">{bar.state}</KV>
        {bar.tokens ? <KV k="usage">{fmtNum(bar.tokens)} tokens</KV> : null}
        {bar.exec ? <KV k="execution_id">{bar.exec}（后台扫描，控制器收 stdout）</KV> : null}
        {bar.err ? (
          <KV k="error">
            <span style={{ color: "var(--red)" }}>{bar.err}</span>
          </KV>
        ) : null}
        <KV k="开始 / 结束">
          {fmtTime(new Date(bar.startMs).toISOString())} → {fmtTime(new Date(bar.endMs).toISOString())}
        </KV>
        <div className="flex mt">
          {bar.state === "uncertain" ? (
            <ActionButton
              label="reconcile 该条"
              className="sm"
              cli={`rionext reconcile ${id} --invocation ${bar.id}`}
              onRun={() => api.reconcile(id, bar.id)}
              onDone={onClose}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
