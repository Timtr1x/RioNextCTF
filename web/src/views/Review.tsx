import { api } from "../api/client";
import { usePoll } from "../hooks/usePoll";
import { useStore } from "../store";
import { ActionButton, Badge, ErrorLine } from "../components/ui";
import { RejectForm } from "../components/verify";
import { kindLabel } from "../format";

export function Review(): JSX.Element {
  const { go, openModal } = useStore();
  const { data, error, refresh } = usePoll(() => api.campaigns(), 3000);
  const queue = (data?.campaigns ?? []).filter((c) => c.pending_goal_claim);

  return (
    <>
      <h2 style={{ fontSize: 14, marginBottom: 10 }}>awaiting_verify 队列（{queue.length}）</h2>
      <ErrorLine error={error} />
      {queue.map((c) => (
        <div className="card" key={c.id}>
          <div className="flex" style={{ justifyContent: "space-between" }}>
            <div style={{ minWidth: 0 }}>
              <b style={{ fontSize: 12 }}>{c.id}</b> <Badge state={c.state} /> <span className="mini">{kindLabel(c.spec)}</span>
              <div className="mt" style={{ fontSize: 13, color: "#744210", wordBreak: "break-all" }}>
                {c.pending_goal_claim!.proposition}
              </div>
              <div className="mini mt">
                {c.pending_goal_claim!.id} · fact_key={c.pending_goal_claim!.fact_key}
              </div>
            </div>
            <div className="flex">
              <ActionButton
                label="accept · 关战役"
                className="sm"
                cli={`rionext accept ${c.id}`}
                onRun={() => api.verify(c.id, { accept: true })}
                onDone={() => refresh()}
              />
              <button className="danger sm" onClick={() => openModal(<RejectForm id={c.id} proposition={c.pending_goal_claim!.proposition} onDone={() => refresh()} />)}>
                reject --text …
              </button>
              <button className="ghost sm" onClick={() => go("detail", c.id)}>
                看战役
              </button>
            </div>
          </div>
        </div>
      ))}
      {!queue.length && !error ? <div className="card mini">没有待人审的 flag。</div> : null}
      <div className="card mt">
        <h3>人审规则</h3>
        <div className="mini">
          goal_seeking 且 success_predicate 不是合成 sample_recovered 时，模型交 flag_recovered 只算候选，战役停在
          awaiting_verify。accept 才关战役；reject 的原因作为 hint 写回上下文，被驳回的 flag 置 disputed/stale，同一值不许再提；--continue
          立刻续跑。
        </div>
      </div>
    </>
  );
}
