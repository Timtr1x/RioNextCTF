import { api } from "../api/client";
import { usePoll } from "../hooks/usePoll";
import { useStore } from "../store";
import { Badge, ErrorLine, Gauge } from "../components/ui";
import { fmtM, fmtNum, kindLabel, pct, targetLabel } from "../format";

export function Dashboard(): JSX.Element {
  const { go } = useStore();
  const { data, error } = usePoll(() => api.campaigns(), 3000);
  const camps = data?.campaigns ?? [];
  const open = camps.filter((c) => ["active", "awaiting_verify"].includes(c.state)).length;
  const pending = camps.filter((c) => c.pending_goal_claim).length;
  const tokens = camps.reduce((a, c) => a + (c.budget?.spent_tokens ?? 0), 0);
  const calls = camps.reduce((a, c) => a + (c.budget?.spent_calls ?? 0), 0);

  return (
    <>
      <div className="grid g3" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>进行中战役</h3>
          <div style={{ fontSize: 22 }}>{open}</div>
          <div className="mini">
            共 {camps.length} 个战役 · {pending} 个待人审
          </div>
        </div>
        <div className="card">
          <h3>预算消耗（全部战役）</h3>
          <div style={{ fontSize: 22 }}>{fmtM(tokens)}</div>
          <div className="mini">tokens · calls {fmtNum(calls)}</div>
        </div>
        <FinalizeHealth />
      </div>
      <h2 style={{ fontSize: 14, margin: "6px 0 10px" }}>战役</h2>
      <ErrorLine error={error} />
      <div className="cards-grid">
        {camps.map((c) => {
          const maxCalls = c.spec.budget?.max_calls ?? c.budget?.total_calls ?? 0;
          const maxTokens = c.spec.budget?.max_tokens ?? c.budget?.total_tokens ?? 0;
          return (
            <div key={c.id} className="ccard" onClick={() => go("detail", c.id)}>
              <div className="head">
                <span className="id">{c.id}</span>
                <Badge state={c.state} />
              </div>
              <div className="meta">
                {kindLabel(c.spec)} · {targetLabel(c.spec)}
                {c.running ? " · 本进程运行中" : ""}
              </div>
              <div className="progress">
                <i style={{ width: `${pct(c.budget?.spent_calls ?? 0, maxCalls)}%` }} />
                <i className="t" style={{ width: `${pct(c.budget?.spent_tokens ?? 0, maxTokens)}%` }} />
              </div>
              <div className="meta flex" style={{ justifyContent: "space-between" }}>
                <span>
                  calls {c.budget?.spent_calls ?? 0}/{maxCalls}
                </span>
                <span>
                  tokens {fmtM(c.budget?.spent_tokens ?? 0)}/{fmtM(maxTokens)}
                </span>
              </div>
              {c.pending_goal_claim ? <div className="mt tag warn">⏳ 待人审 flag</div> : null}
            </div>
          );
        })}
        {!camps.length && !error ? <div className="mini">还没有战役。右上角「＋ 新战役」开打。</div> : null}
      </div>
    </>
  );
}

function FinalizeHealth(): JSX.Element {
  const { data } = usePoll(async () => {
    const { campaigns } = await api.campaigns();
    const views = await Promise.all(
      campaigns.slice(0, 20).map(async (c) => {
        try {
          return await api.campaign(c.id);
        } catch {
          return null;
        }
      }),
    );
    let runs = 0;
    let ok = 0;
    for (const v of views) {
      if (!v) continue;
      runs += v.finalization.execute_runs_total;
      ok += v.finalization.finish_primary_total + v.finalization.finalizer_committed_total;
    }
    return { runs, ok };
  }, 10000);
  return (
    <div className="card">
      <h3>收卷健康</h3>
      <div style={{ fontSize: 22 }}>{data?.runs ? Math.round((data.ok / data.runs) * 100) : 0}%</div>
      <div className="mini">
        协议完整率 {data?.ok ?? 0}/{data?.runs ?? 0}
      </div>
    </div>
  );
}
