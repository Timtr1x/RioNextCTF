import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { usePoll } from "../../hooks/usePoll";
import { useStore } from "../../store";
import { KV, ActionButton } from "../../components/ui";
import { trunc, fmtM, fmtTime } from "../../format";
import type { CampaignView } from "../../api/types";
import { buildGraph, composeEntities, type Entity } from "./graph";

const RING: Record<string, string> = {
  resolved: "#166534",
  running: "#1d4ed8",
  ready: "#8a8272",
  blocked: "#b91c1c",
  accepted: "#166534",
  disputed: "#b91c1c",
  pending: "#b45309",
  achieved: "#166534",
  active: "#1d4ed8",
  confirmed: "#166534",
  suspected: "#b45309",
  validating: "#b45309",
  recorded: "#0f766e",
  proposed: "#8a8272",
  stale: "#8a8272",
  refuted: "#b91c1c",
  retired: "#8a8272",
};

const COL_LABEL: Record<string, string> = { goal: "目标", step: "STEP", obs: "观察", fact: "事实", finding: "发现" };
const COL_FILL: Record<string, string> = { goal: "#faf5ff", step: "#eff6ff", obs: "#f0fdfa", fact: "#fffbeb", finding: "#fff1f2" };

export function GraphTab({ view }: { view: CampaignView }): JSX.Element {
  const id = view.campaign_id;
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const { data: steps } = usePoll(() => api.list(id, "steps"), 4000, [id]);
  const { data: observations } = usePoll(() => api.list(id, "observations"), 4000, [id]);
  const { data: facts } = usePoll(() => api.list(id, "facts"), 4000, [id]);
  const { data: findings } = usePoll(() => api.list(id, "findings"), 4000, [id]);
  const { data: goals } = usePoll(() => api.list(id, "goals"), 4000, [id]);
  const { data: runs } = usePoll(() => api.list(id, "task_runs"), 4000, [id]);

  const entities = useMemo(
    () =>
      composeEntities({
        spec: view.spec,
        steps: steps?.rows ?? [],
        observations: observations?.rows ?? [],
        facts: facts?.rows ?? [],
        findings: findings?.rows ?? [],
        goals: goals?.rows ?? [],
        runs: runs?.rows ?? [],
        pending: view.pending_goal_claim,
      }),
    [view.spec, view.pending_goal_claim, steps, observations, facts, findings, goals, runs],
  );
  const g = useMemo(() => buildGraph(entities), [entities]);
  const sel = selNode ? g.byId[selNode] : null;

  const W = 1100;
  const H = g.maxH;
  let colX = 50;

  return (
    <>
      <div className="detail-pane">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMin meet">
          {g.cols.map(([t, w]) => {
            const x = colX;
            colX += w * g.scale + 36;
            return (
              <g key={t}>
                <text x={x + (w * g.scale) / 2} y={30} textAnchor="middle" style={{ fill: "#8a8272", letterSpacing: ".18em" }}>
                  {COL_LABEL[t]}
                </text>
                <rect x={x - 12} y={42} width={w * g.scale + 24} height={H - 54} rx={8} fill={COL_FILL[t]} stroke="#e2dccd" />
              </g>
            );
          })}
          {g.edges.map(([a, b]) => {
            const A = g.centers[a];
            const B = g.centers[b];
            if (!A || !B) return null;
            const sx = A.x + (a.startsWith("goal") ? 60 : a.startsWith("step") ? 76 : 50);
            const ex = B.x - 50;
            const key = `${a}|${b}`;
            return (
              <path
                key={key}
                className={`edge ${selEdge === key ? "sel" : ""}`}
                onClick={() => setSelEdge(key)}
                d={`M ${sx} ${A.y} C ${(A.x + B.x) / 2} ${A.y}, ${(A.x + B.x) / 2} ${B.y}, ${ex} ${B.y}`}
              />
            );
          })}
          {g.cols.map(([t, w]) =>
            (g.rows[t] ?? []).map((e) => {
              const p = g.centers[e.id];
              if (!p) return null;
              const h = 52;
              const bw = w * g.scale;
              return (
                <g
                  key={e.id}
                  className={`node ${selNode === e.id ? "sel" : ""}`}
                  transform={`translate(${p.x - bw / 2},${p.y - h / 2})`}
                  onClick={() => {
                    setSelNode(e.id);
                    setSelEdge(null);
                  }}
                >
                  <rect width={bw} height={h} rx={7} fill="#fff" />
                  <circle cx={13} cy={h / 2} r={4.5} fill={RING[e.st] ?? "#8a8272"} />
                  <text x={26} y={20} fontSize={11}>
                    {trunc(e.label, Math.floor((bw - 64) / 6.4))}
                  </text>
                  <text x={26} y={37} style={{ fill: "#8a8272" }}>
                    {trunc(e.sub, Math.floor((bw - 64) / 5.4))}
                  </text>
                </g>
              );
            }),
          )}
        </svg>
        <div className="legend">
          <div>
            <i style={{ background: "#6d28d9" }} />目标 <i style={{ background: "#1d4ed8" }} />step <i style={{ background: "#0f766e" }} />
            观察 <i style={{ background: "#b45309" }} />事实 <i style={{ background: "#be123c" }} />发现
          </div>
          <div className="mini mt">边：belongs / produced / supports / evidence / reopens · 点节点看 provenance</div>
        </div>
      </div>
      <Inspector view={view} entity={sel ?? null} />
    </>
  );
}

function Inspector({ view, entity }: { view: CampaignView; entity: Entity | null }): JSX.Element {
  const { openModal } = useStore();
  const id = view.campaign_id;
  if (!entity) {
    return (
      <div className="inspector-col">
        <h2>巡检台</h2>
        <div className="panel">
          <h3>战役速览</h3>
          <KV k="target">{view.spec.assets[0] ?? view.spec.statement}</KV>
          <KV k="profile">
            {view.spec.challenge?.kind ?? view.spec.mode}
            {view.spec.challenge?.overlay ? `/${view.spec.challenge.overlay}` : ""}
          </KV>
          <KV k="budget">
            calls {view.budget.spent_calls}/{view.spec.budget?.max_calls ?? view.budget.total_calls} · tokens{" "}
            {fmtM(view.budget.spent_tokens)}
          </KV>
          <KV k="收卷">
            主动 {view.finalization.finish_primary_total}/{view.finalization.execute_runs_total} · 补交{" "}
            {view.finalization.finalizer_committed_total}/{view.finalization.finalizer_started_total}
          </KV>
          {view.pending_goal_claim ? (
            <KV k="pending">
              <span style={{ color: "var(--accent)" }}>{view.pending_goal_claim.proposition}</span>
            </KV>
          ) : null}
        </div>
        <div className="panel">
          <h3>工具面（Execute 实际可用）</h3>
          <div className="mini">
            {view.spec.assets.some((a) => /^https?:/i.test(a)) || view.spec.challenge
              ? "graph_query · artifact_read（50KB 分页续读）· checkpoint · submit_observation / submit_fact / submit_finding · propose_step · kali_run · kali_write · playwright（goto/snapshot/click/type/press/screenshot/content/wait/back/status）· finish_step"
              : "synthetic：world_inspect / world_act + 共用子集"}
          </div>
        </div>
        <div className="panel">
          <h3>提示</h3>
          <div className="mini">点图谱节点看 provenance（source_run、submission、revision、supersedes）。候选 flag 事实节点可就地人审。</div>
        </div>
      </div>
    );
  }

  const prov = (
    <div className="panel">
      <h3>provenance</h3>
      <KV k="source_run">{String(entity.full.source_run_id ?? "-")}</KV>
      <KV k="submission">{String(entity.full.source_submission_id ?? "-")}</KV>
      <KV k="revision">{String(entity.full.revision ?? 1)}</KV>
    </div>
  );

  return (
    <div className="inspector-col">
      <h2>
        {COL_LABEL[entity.t]} · {entity.id}
      </h2>
      {prov}
      {entity.t === "step" && <StepCard id={id} entity={entity} onExplain={() => openModal(<ExplainModal id={id} step={entity.id} />)} />}
      {entity.t === "fact" && <FactCard view={view} entity={entity} />}
      {entity.t === "finding" && (
        <div className="panel">
          <h3>发现卡</h3>
          <KV k="claim">{String(entity.full.claim ?? entity.label)}</KV>
          <KV k="dedup / status">
            {String(entity.full.dedup_key ?? "-")} · {String(entity.full.status ?? entity.st)}
          </KV>
          <KV k="impact">{String(entity.full.impact ?? "-")}</KV>
        </div>
      )}
      {entity.t === "obs" && (
        <div className="panel">
          <h3>观察卡</h3>
          <KV k="subject">{String(entity.full.subject ?? entity.label)}</KV>
          <KV k="producer / env">
            {String(entity.full.producer || "-")} · {String(entity.full.env_rev || "env-1")}
          </KV>
          <KV k="summary">{String(entity.full.summary ?? "")}</KV>
          <KV k="observed_at">{fmtTime(String(entity.full.observed_at ?? ""))}</KV>
        </div>
      )}
      {entity.t === "goal" && (
        <div className="panel">
          <h3>目标卡</h3>
          <KV k="statement">{String(entity.full.statement ?? "")}</KV>
          <KV k="predicate">{String(entity.full.success_predicate_ref ?? "-")}</KV>
        </div>
      )}
    </div>
  );
}

function StepCard({ id, entity, onExplain }: { id: string; entity: Entity; onExplain: () => void }): JSX.Element {
  const rule = entity.full.reopen_rule as { kind?: string; key?: string } | null;
  return (
    <div className="panel">
      <h3>explain-step 输出</h3>
      <KV k="attempt_count">{String(entity.full.attempt_count ?? 0)}</KV>
      <KV k="priority">{String(entity.full.priority ?? "-")}</KV>
      <KV k="reopen_rule">{rule ? `${rule.kind}${rule.key ? `:${rule.key}` : ""}` : "never"}</KV>
      <KV k="blocked">{String(entity.full.blocked_reason ?? entity.full.next_action ?? "-")}</KV>
      <div className="flex mt">
        <button className="ghost sm" onClick={onExplain}>
          explain-step
        </button>
        <span className="mini">rionext explain-step {id} --step {entity.id}</span>
      </div>
    </div>
  );
}

function FactCard({ view, entity }: { view: CampaignView; entity: Entity }): JSX.Element {
  const { go } = useStore();
  const id = view.campaign_id;
  const support = Array.isArray(entity.full.support) ? (entity.full.support as unknown[]).join("，") : "-";
  const isPending = entity.full.pending_goal_claim === true;
  return (
    <div className="panel">
      <h3>事实卡</h3>
      <KV k="proposition">{String(entity.full.proposition ?? entity.label)}</KV>
      <KV k="fact_key / 状态">
        {String(entity.full.fact_key ?? "-")} · {String(entity.full.epistemic_status ?? entity.st)}
      </KV>
      <KV k="grade / validity">
        {String(entity.full.source_grade ?? "-")} / {String(entity.full.validity ?? "-")}
      </KV>
      <KV k="support">{support}</KV>
      {isPending ? (
        <div className="flex mt">
          <ActionButton
            label="accept"
            className="sm"
            cli={`rionext accept ${id}`}
            cap="accept · 关战役"
            onRun={() => api.verify(id, { accept: true, fact_id: entity.id })}
          />
          <ActionButton
            label="reject --text …"
            className="danger sm"
            cli={`rionext reject ${id}`}
            cap="驳回需写原因；请到审查中心或横幅操作"
            onRun={async () => go("review")}
          />
        </div>
      ) : null}
    </div>
  );
}

function ExplainModal({ id, step }: { id: string; step: string }): JSX.Element {
  const { data, error } = usePoll(() => api.explainStep(id, step), 0, [id, step]);
  return (
    <>
      <h2>explain-step · {step}</h2>
      {error ? <div className="mini" style={{ color: "var(--red)" }}>{error.message}</div> : null}
      <pre>{data ? JSON.stringify(data, null, 2) : "加载中…"}</pre>
    </>
  );
}
