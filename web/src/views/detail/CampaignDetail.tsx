import { useState } from "react";
import { api } from "../../api/client";
import { usePoll } from "../../hooks/usePoll";
import { useStore } from "../../store";
import { ActionButton, Badge, ErrorLine, Gauge } from "../../components/ui";
import { BudgetForm, HintForm, ReconcilePanel, RejectForm } from "../../components/verify";
import { fmtM, fmtNum, fmtTime, kindLabel, targetLabel } from "../../format";
import { GraphTab } from "./GraphTab";
import { TimelineTab } from "./TimelineTab";
import { CoverageTab, EventsTab, KanbanTab, ObsTab, ReportTab } from "./otherTabs";

const TABS: [string, string][] = [
  ["graph", "图谱"],
  ["timeline", "时间线"],
  ["kanban", "看板"],
  ["obs", "观察流"],
  ["coverage", "覆盖"],
  ["events", "事件"],
  ["report", "报告"],
];

export function CampaignDetail({ id }: { id: string }): JSX.Element {
  const { openModal } = useStore();
  const [tab, setTab] = useState("graph");
  const { data: view, error, refresh } = usePoll(() => api.campaign(id), 2000, [id]);

  if (error && !view) {
    return (
      <div className="card">
        <ErrorLine error={error} />
        <div className="mini">战役 {id} 读不到。</div>
      </div>
    );
  }
  if (!view) return <div className="mini">加载中…</div>;

  const fin = view.finalization;
  const finPct = fin.protocol_complete_rate == null ? 0 : Math.round(fin.protocol_complete_rate * 100);
  const maxCalls = view.spec.budget?.max_calls ?? view.budget.total_calls;
  const maxTokens = view.spec.budget?.max_tokens ?? view.budget.total_tokens;
  const solo = tab !== "graph";

  return (
    <>
      {view.pending_goal_claim ? (
        <div className="banner">
          <span className="t">待人审 flag</span>
          <span className="code">{view.pending_goal_claim.proposition}</span>
          <span className="spacer" />
          <ActionButton
            label="accept"
            className="sm"
            cli={`rionext accept ${id}`}
            cap="accept · 关战役"
            onRun={() => api.verify(id, { accept: true })}
            onDone={() => refresh()}
          />
          <button className="ghost sm" onClick={() => openModal(<RejectForm id={id} proposition={view.pending_goal_claim!.proposition} onDone={() => refresh()} />)}>
            reject --text …
          </button>
        </div>
      ) : null}
      {view.state === "budget_paused" ? (
        <div className="banner blue">
          <span className="t">预算触顶</span>
          <span className="mini">calls/tokens 用完，停在 budget_paused。可以 revise-budget 追加。</span>
          <span className="spacer" />
          <button className="ghost sm" onClick={() => openModal(<BudgetForm id={id} onDone={() => refresh()} />)}>
            revise-budget
          </button>
        </div>
      ) : null}

      <div className="card">
        <div className="flex" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ fontSize: 15 }}>
              {id} <Badge state={view.state} />
            </h2>
            <div className="mini mt">
              {kindLabel(view.spec)} · {targetLabel(view.spec)} · thinking 见 spec · solver {view.spec.model?.model ?? "scripted"}
              {view.spec.capabilities?.length ? ` · 工具能力 ${view.spec.capabilities.join("+")}` : ""}
            </div>
          </div>
          <div className="flex">
            {!view.running && !["cancelled", "completed"].includes(view.state) ? (
              <ActionButton label="start" cli={`rionext start ${id}`} onRun={() => api.start(id)} onDone={() => refresh()} />
            ) : null}
            {view.running ? (
              <ActionButton label="pause" cli={`rionext pause ${id}`} onRun={() => api.pause(id)} onDone={() => refresh()} />
            ) : null}
            {!view.running && ["paused", "budget_paused", "blocked", "plateau", "waiting"].includes(view.state) ? (
              <ActionButton label="resume" cli={`rionext resume ${id} && rionext start ${id}`} onRun={() => api.resume(id)} onDone={() => refresh()} />
            ) : null}
            {!["cancelled", "completed"].includes(view.state) ? (
              <ActionButton
                label="cancel"
                className="danger sm"
                cli={`rionext cancel ${id}`}
                cap="cancel 会 docker rm 克隆容器，已发包不收回"
                confirm={`确定 cancel ${id}？克隆容器会被 docker rm。`}
                onRun={() => api.cancel(id)}
                onDone={() => refresh()}
              />
            ) : null}
            <button className="ghost sm" onClick={() => openModal(<HintForm id={id} onDone={() => refresh()} />)}>
              hint…
            </button>
            <button className="ghost sm" onClick={() => openModal(<ReconcilePanel id={id} uncertain={view.uncertain_invocations} onDone={() => refresh()} />)}>
              reconcile{view.uncertain_invocations.length ? ` (${view.uncertain_invocations.length})` : ""}…
            </button>
          </div>
        </div>
        <div className="grid g3 mt">
          <div>
            <div className="mini">calls</div>
            <div style={{ fontSize: 17 }}>
              {fmtNum(view.budget.spent_calls)}
              <span className="mini"> / {fmtNum(maxCalls)}</span>
            </div>
            <Gauge value={view.budget.spent_calls} max={maxCalls} />
          </div>
          <div>
            <div className="mini">tokens</div>
            <div style={{ fontSize: 17 }}>
              {fmtM(view.budget.spent_tokens)}
              <span className="mini"> / {fmtM(maxTokens)}</span>
            </div>
            <Gauge value={view.budget.spent_tokens} max={maxTokens} tone="t" />
          </div>
          <div>
            <div className="mini">收卷</div>
            <div style={{ fontSize: 17 }}>{finPct}%</div>
            <div className="mini">
              主动 {fin.finish_primary_total}/{fin.execute_runs_total} · 补交 {fin.finalizer_committed_total}/{fin.finalizer_started_total} · 协议完整率 {finPct}%
            </div>
          </div>
        </div>
        <div className="mini mt">
          {view.running ? `本进程运行中 · ${view.running.instance_id}（${fmtTime(view.running.started_at)} 起跑）` : "本进程未在跑"}
          {" · "}epoch {view.progress_epoch} · {view.active_run ? `active run ${view.active_run.mode} ${view.active_run.id}` : "idle"}
          {" · "}更新于 {fmtTime(view.updated_at)}
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([k, label]) => (
          <div key={k} className={`t ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
            {label}
          </div>
        ))}
      </div>
      <div className={`detail-wrap ${solo ? "solo" : ""}`}>
        {tab === "graph" && <GraphTab view={view} />}
        {tab === "timeline" && <TimelineTab view={view} />}
        {tab === "kanban" && <KanbanTab view={view} />}
        {tab === "obs" && <ObsTab view={view} />}
        {tab === "coverage" && <CoverageTab view={view} />}
        {tab === "events" && <EventsTab view={view} />}
        {tab === "report" && <ReportTab view={view} />}
      </div>
    </>
  );
}
