import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { usePoll } from "../../hooks/usePoll";
import { useStore } from "../../store";
import { ActionButton, Donut, ErrorLine, KV, Tag } from "../../components/ui";
import { fmtBytes, fmtNum, fmtTime, trunc } from "../../format";
import { j } from "./graph";
import type { CampaignView, EventRow, Row } from "../../api/types";

/* ---------- 看板 ---------- */

const KANBAN_COLS: [string, string][] = [
  ["running", "运行中"],
  ["ready", "就绪"],
  ["blocked", "受阻"],
  ["resolved", "已解决"],
  ["deferred", "延迟"],
  ["retired", "已退役"],
];

export function KanbanTab({ view }: { view: CampaignView }): JSX.Element {
  const id = view.campaign_id;
  const { openModal } = useStore();
  const { data } = usePoll(() => api.list(id, "steps"), 3000, [id]);
  const steps = data?.rows ?? [];
  const bucket = (st: string): Row[] => steps.filter((s) => String(s.status) === st);
  return (
    <div className="detail-pane" style={{ gridColumn: "1/-1", padding: 14 }}>
      <div className="kanban">
        {KANBAN_COLS.map(([st, label]) => {
          const arr = bucket(st);
          return (
            <div className="kcol" key={st}>
              <h4>
                {label}
                <span>{arr.length}</span>
              </h4>
              {arr.map((s) => (
                <div className="kcard" key={String(s.id)} onClick={() => openModal(<StepModal id={id} step={String(s.id)} />)}>
                  <div className="t">{trunc(s.question, 60)}</div>
                  <div className="m">
                    {String(s.id)} · {String(s.kind)} · {String(s.method_family)}
                    {Number(s.attempt_count) ? ` · 第 ${Number(s.attempt_count)} 次尝试` : ""}
                  </div>
                  {s.blocked_reason ? <div className="m" style={{ color: "var(--accent)" }}>{String(s.blocked_reason)}</div> : null}
                  {s.next_action ? <div className="m" style={{ color: "var(--blue)" }}>next: {String(s.next_action)}</div> : null}
                </div>
              ))}
              {!arr.length ? <div className="mini">—</div> : null}
            </div>
          );
        })}
      </div>
      <div className="mini mt">
        proposed→ready→leased→running→resolved / deferred / blocked；deferred 带 next_action 下一周期再派发；点卡片看 explain-step。
      </div>
    </div>
  );
}

function StepModal({ id, step }: { id: string; step: string }): JSX.Element {
  const { data, error } = usePoll(() => api.explainStep(id, step), 0, [id, step]);
  return (
    <>
      <h2>explain-step · {step}</h2>
      <ErrorLine error={error} />
      <pre>{data ? JSON.stringify(data, null, 2) : "加载中…"}</pre>
    </>
  );
}

/* ---------- 观察流 ---------- */

export function ObsTab({ view }: { view: CampaignView }): JSX.Element {
  const id = view.campaign_id;
  const { openModal } = useStore();
  const { data } = usePoll(() => api.list(id, "observations"), 3000, [id]);
  const rows = (data?.rows ?? []).slice().reverse();
  return (
    <div className="detail-pane" style={{ gridColumn: "1/-1", padding: 14 }}>
      <table>
        <thead>
          <tr>
            <th>obs</th>
            <th>subject</th>
            <th>时间</th>
            <th>摘要</th>
            <th>产物</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const body = j(o.body_json, {}) as Record<string, unknown>;
            const summary = typeof body.summary === "string" ? body.summary : trunc(JSON.stringify(body), 90);
            const arts = (j(o.artifact_refs_json, []) as unknown[]).map(String);
            return (
              <tr key={String(o.id)} className="click" onClick={() => openModal(<ObsModal id={id} row={o} />)}>
                <td className="mini">{String(o.id)}</td>
                <td>{String(o.subject)}</td>
                <td className="mini">{fmtTime(String(o.observed_at))}</td>
                <td>{summary}</td>
                <td className="mini">{arts.join("，") || "-"}</td>
              </tr>
            );
          })}
          {!rows.length ? (
            <tr>
              <td colSpan={5} className="mini">
                （无观察）
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="mini mt">上下文包注入最近 20 条 observation；更早的用 graph_query entity=observations offset 翻页。</div>
    </div>
  );
}

function ObsModal({ id, row }: { id: string; row: Row }): JSX.Element {
  const body = j(row.body_json, {});
  const arts = (j(row.artifact_refs_json, []) as unknown[]).map(String);
  const { openModal } = useStore();
  return (
    <>
      <h2>观察 · {String(row.id)}</h2>
      <KV k="subject">{String(row.subject)}</KV>
      <KV k="observed_at">{fmtTime(String(row.observed_at))}</KV>
      <KV k="env_rev">{String(row.env_rev ?? "-")}</KV>
      <pre>{JSON.stringify(body, null, 2)}</pre>
      {arts.length ? (
        <div className="flex">
          {arts.map((a) => (
            <button key={a} className="ghost sm" onClick={() => openModal(<ArtifactModal id={id} aid={a} />)}>
              读 {a}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function ArtifactModal({ id, aid }: { id: string; aid: string }): JSX.Element {
  const [offset, setOffset] = useState(0);
  const { data, error } = usePoll(() => api.artifactContent(id, aid, offset), 0, [id, aid, offset]);
  return (
    <>
      <h2>artifact · {aid}</h2>
      <ErrorLine error={error} />
      {data ? (
        <>
          <div className="mini">
            {data.mime} · {fmtBytes(data.size)} · offset {data.offset}
            {data.has_more ? "（截断续读）" : ""}
          </div>
          <pre style={{ maxHeight: "46vh" }}>{data.text}</pre>
          <div className="flex">
            {offset > 0 ? (
              <button className="ghost sm" onClick={() => setOffset(Math.max(0, offset - 262144))}>
                上一段
              </button>
            ) : null}
            {data.has_more ? (
              <button className="ghost sm" onClick={() => setOffset(offset + data.length)}>
                下一段（截断续读）
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="mini">加载中…</div>
      )}
    </>
  );
}

/* ---------- 覆盖 ---------- */

export function CoverageTab({ view }: { view: CampaignView }): JSX.Element {
  const id = view.campaign_id;
  const { data } = usePoll(() => api.list(id, "coverage_items"), 4000, [id]);
  const rows = data?.rows ?? [];
  const mand = rows.filter((x) => Number(x.mandatory) === 1 || x.mandatory === true);
  const done = mand.filter((x) => String(x.execution_state) === "tested" && String(x.evidence_state) === "current").length;
  return (
    <div className="detail-pane" style={{ gridColumn: "1/-1", padding: 14 }}>
      <div className="grid g2">
        <div>
          <div className="mini" style={{ textAlign: "center" }}>
            必查覆盖
          </div>
          <Donut done={done} total={mand.length} />
          <div className="mini" style={{ textAlign: "center" }}>
            {done}/{mand.length} 项 mandatory 已测且证据 current
          </div>
        </div>
        <div>
          <table>
            <thead>
              <tr>
                <th>obligation</th>
                <th>execution</th>
                <th>outcome</th>
                <th>evidence</th>
                <th>必查</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x, i) => (
                <tr key={i}>
                  <td>{String(x.obligation ?? x.id)}</td>
                  <td>
                    <Tag tone={String(x.execution_state) === "tested" ? "ok" : String(x.execution_state) === "untested" ? "bad" : "warn"}>
                      {String(x.execution_state ?? "-")}
                    </Tag>
                  </td>
                  <td>{String(x.outcome ?? "-")}</td>
                  <td>{String(x.evidence_state ?? "-")}</td>
                  <td>{Number(x.mandatory) === 1 || x.mandatory === true ? "✔" : ""}</td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td colSpan={5} className="mini">
                    （goal_seeking 通常不铺 coverage）
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="mini mt">工具成功不自动置 tested，要有 observation 支撑；assessment 模式必查不齐不能关战役。</div>
        </div>
      </div>
    </div>
  );
}

/* ---------- 事件（after=seq 增量） ---------- */

export function EventsTab({ view }: { view: CampaignView }): JSX.Element {
  const id = view.campaign_id;
  const [events, setEvents] = useState<EventRow[]>([]);
  const afterRef = useRef(0);
  const { error } = usePoll(
    async () => {
      const res = await api.events(id, afterRef.current, 500);
      if (res.events.length) {
        afterRef.current = Math.max(...res.events.map((e) => e.seq));
        setEvents((prev) => [...prev, ...res.events].slice(-2000));
      }
      return res.head;
    },
    2000,
    [id],
  );
  useEffect(() => {
    afterRef.current = 0;
    setEvents([]);
  }, [id]);
  const rows = events.slice().reverse();
  return (
    <div className="detail-pane" style={{ gridColumn: "1/-1", padding: 14 }}>
      <ErrorLine error={error} />
      <table>
        <thead>
          <tr>
            <th>seq</th>
            <th>type</th>
            <th>actor</th>
            <th>时间</th>
            <th>payload</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            let actor = e.actor_json;
            try {
              const a = JSON.parse(e.actor_json) as { kind?: string; id?: string };
              actor = `${a.kind}/${a.id}`;
            } catch {
              // keep raw
            }
            return (
              <tr key={e.event_id}>
                <td className="mini">{e.seq}</td>
                <td>{e.type}</td>
                <td className="mini">{actor}</td>
                <td className="mini">{fmtTime(e.recorded_at)}</td>
                <td className="mini">{trunc(e.payload_json, 120)}</td>
              </tr>
            );
          })}
          {!rows.length ? (
            <tr>
              <td colSpan={5} className="mini">
                （还没有事件）
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="mini mt">21 种事件类型 · actor: user/controller/worker/adapter · 2s 增量轮询（after=seq）。</div>
    </div>
  );
}

/* ---------- 报告 ---------- */

export function ReportTab({ view }: { view: CampaignView }): JSX.Element {
  const id = view.campaign_id;
  const { data, error, refresh } = usePoll(() => api.report(id), 0, [id]);
  const fin = view.finalization;
  const report = data?.report as Record<string, unknown> | undefined;
  return (
    <div className="detail-pane" style={{ gridColumn: "1/-1", padding: 14 }}>
      <div className="flex" style={{ justifyContent: "space-between" }}>
        <div className="mini">rionext report {id}</div>
        <ActionButton
          label="重新生成"
          cli={`rionext report ${id} --json`}
          onRun={() => api.regenerateReport(id)}
          onDone={() => refresh()}
        />
      </div>
      <ErrorLine error={error} />
      <pre style={{ maxHeight: "40vh" }}>{report ? JSON.stringify(report, null, 2) : "生成中…"}</pre>
      <div className="grid g2">
        <div className="card">
          <h3>收卷统计</h3>
          <div className="pct-row">
            <span className="n">{fin.primary_finish_rate == null ? "—" : `${Math.round(fin.primary_finish_rate * 100)}%`}</span>
            <span className="d">
              主动交卷 {fin.finish_primary_total}/{fin.execute_runs_total}
            </span>
          </div>
          <div className="pct-row">
            <span className="n">{fin.finalizer_success_rate == null ? "—" : `${Math.round(fin.finalizer_success_rate * 100)}%`}</span>
            <span className="d">
              补交成功 {fin.finalizer_committed_total}/{fin.finalizer_started_total}
            </span>
          </div>
          <div className="pct-row">
            <span className="n">{fin.protocol_complete_rate == null ? "—" : `${Math.round(fin.protocol_complete_rate * 100)}%`}</span>
            <span className="d">最终协议完整率</span>
          </div>
          <div className="mini mt">
            validation error {fin.finish_validation_error_total} · conflict {fin.finish_conflict_total} · incomplete{" "}
            {fin.incomplete_protocol_total}
          </div>
        </div>
        <div className="card">
          <h3>报告要点</h3>
          <KV k="stop_reason">{view.stop_reason}</KV>
          <KV k="unknown_cost">{view.budget.price_version === "unknown" ? "true（price_version=unknown）" : "false"}</KV>
          <KV k="operations_open">{String(view.operations_open)}</KV>
          <KV k="residual">{view.residual.length ? `${view.residual.length} 条可终止` : "无"}</KV>
        </div>
      </div>
    </div>
  );
}
