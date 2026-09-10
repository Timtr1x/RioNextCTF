import { api } from "../api/client";
import { usePoll } from "../hooks/usePoll";
import { ErrorLine, KV } from "../components/ui";
import { fmtNum, fmtTime } from "../format";

export function Settings(): JSX.Element {
  const { data: cfg, error } = usePoll(() => api.config(), 10000);
  const { data: health } = usePoll(() => api.health(), 5000);
  const locks = cfg?.controller_locks ?? [];

  return (
    <>
      <ErrorLine error={error} />
      <div className="grid g2">
        <div className="card">
          <h3>运行参数（ui 进程当前生效值）</h3>
          <KV k="数据目录">{cfg?.data_dir ?? "-"}</KV>
          <KV k="数据库">{cfg?.db_path ?? "-"}</KV>
          <KV k="实例 id">{cfg?.instance_id ?? "-"}</KV>
          <KV k="版本">v{cfg?.version ?? "…"}</KV>
          <div className="grid g2 mt">
            <div>
              <div className="mini">max-decide-turns</div>
              <div>{cfg?.limits.max_decide_turns ?? "-"}</div>
            </div>
            <div>
              <div className="mini">max-execute-turns</div>
              <div>{cfg?.limits.max_execute_turns_per_run ?? "-"}</div>
            </div>
            <div>
              <div className="mini">max-tool-calls</div>
              <div>{cfg?.limits.max_tool_calls_per_run ?? "-"}</div>
            </div>
            <div>
              <div className="mini">transient retries</div>
              <div>{cfg?.limits.max_transient_retries_per_invocation ?? "-"}</div>
            </div>
            <div>
              <div className="mini">控制器租约</div>
              <div>{cfg ? fmtNum(cfg.limits.lease_ttl_ms / 1000) : "-"}s</div>
            </div>
            <div>
              <div className="mini">心跳</div>
              <div>{cfg ? fmtNum(cfg.limits.heartbeat_ms / 1000) : "-"}s</div>
            </div>
            <div>
              <div className="mini">stdout 预览截断</div>
              <div>{cfg ? fmtNum(cfg.limits.tool_preview_limit) : "-"}B</div>
            </div>
            <div>
              <div className="mini">Finalize 收卷</div>
              <div>{cfg?.limits.finalization.enabled ? "开（默认）" : "关"}</div>
            </div>
          </div>
          <div className="mini mt">
            这些值来自启动 `rionext ui` 时的开关与环境变量（--max-execute-turns / --max-tool-calls / --no-finalization /
            RIONEXT_FINALIZATION）；改它们要重启 ui 进程。预算默认 3000 calls / 30M tokens。
          </div>
        </div>
        <div>
          <div className="card">
            <h3>控制器锁（同一战役只允许一个进程）</h3>
            <table>
              <thead>
                <tr>
                  <th>战役</th>
                  <th>owner</th>
                  <th>代</th>
                  <th>租约至</th>
                </tr>
              </thead>
              <tbody>
                {locks.map((l) => (
                  <tr key={l.campaign_id}>
                    <td>{l.campaign_id}</td>
                    <td className="mini">{l.owner}</td>
                    <td className="mini">{l.generation}</td>
                    <td className="mini">{l.lease_until ? fmtTime(new Date(Number(l.lease_until)).toISOString()) : "-"}</td>
                  </tr>
                ))}
                {!locks.length ? (
                  <tr>
                    <td colSpan={4} className="mini">
                      （没有锁；没有战役在跑）
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <div className="mini mt">进程死了等租约过期自动接管，或清 controller_locks 行。ui 进程内 start 前会做只读预检，409 会带上 owner。</div>
          </div>
          <div className="card mt">
            <h3>健康</h3>
            <KV k="docker">{health?.docker ? "ok" : "missing"}</KV>
            <KV k="kali master">{health?.kali_master ? "ok" : "missing"}</KV>
            <KV k="keeper">{health?.keeper ?? "-"}</KV>
            <KV k="本进程运行">{health?.running.length ? health.running.join("，") : "无"}</KV>
          </div>
          <div className="card mt">
            <h3>常见卡死（docs/ops.md）</h3>
            <div className="mini">
              · 另一个控制器占锁：不要对同一 id 再 start（409 controller_lock_held 带 owner）
              <br />· resource_locked：后台扫描仍占锁到扫完
              <br />· 源码改了战役没变：没重编译（npx tsc）或旧进程还在跑
              <br />· DNS：网关先系统 lookup，再 docker getent
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
