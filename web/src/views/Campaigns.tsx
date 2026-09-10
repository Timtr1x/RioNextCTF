import { api } from "../api/client";
import { usePoll } from "../hooks/usePoll";
import { useStore } from "../store";
import { ActionButton, Badge, ErrorLine } from "../components/ui";
import { fmtM, kindLabel, targetLabel } from "../format";

export function Campaigns(): JSX.Element {
  const { go } = useStore();
  const { data, error, refresh } = usePoll(() => api.campaigns(), 3000);
  const camps = data?.campaigns ?? [];

  return (
    <>
      <h2 style={{ fontSize: 14, marginBottom: 10 }}>全部战役</h2>
      <ErrorLine error={error} />
      <table style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 6 }}>
        <thead>
          <tr>
            <th>id</th>
            <th>状态</th>
            <th>题型 / 模式</th>
            <th>目标</th>
            <th>calls</th>
            <th>tokens</th>
            <th>待人审</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {camps.map((c) => (
            <tr key={c.id} className="click" onClick={() => go("detail", c.id)}>
              <td>
                {c.id}
                {c.running ? <span className="mini"> · 运行中</span> : null}
              </td>
              <td>
                <Badge state={c.state} />
              </td>
              <td>{kindLabel(c.spec)}</td>
              <td className="mini">{targetLabel(c.spec)}</td>
              <td>
                {c.budget?.spent_calls ?? 0}/{c.spec.budget?.max_calls ?? c.budget?.total_calls ?? 0}
              </td>
              <td>{fmtM(c.budget?.spent_tokens ?? 0)}</td>
              <td>{c.pending_goal_claim ? "✔" : ""}</td>
              <td className="flex" onClick={(e) => e.stopPropagation()}>
                {!c.running && !["cancelled", "completed"].includes(c.state) ? (
                  <ActionButton label="start" cli={`rionext start ${c.id}`} onRun={() => api.start(c.id)} onDone={() => refresh()} />
                ) : null}
                {c.running ? (
                  <ActionButton label="pause" cli={`rionext pause ${c.id}`} onRun={() => api.pause(c.id)} onDone={() => refresh()} />
                ) : null}
              </td>
            </tr>
          ))}
          {!camps.length ? (
            <tr>
              <td colSpan={8} className="mini">
                （没有战役）
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="mini mt">rionext list · 同 URL 再跑续接同 id；点行进详情。</div>
    </>
  );
}
