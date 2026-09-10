import { useState } from "react";
import { api } from "../api/client";
import { usePoll } from "../hooks/usePoll";
import { useStore } from "../store";
import { ActionButton, ErrorLine, KV, LogBox, Tag } from "../components/ui";
import { fmtTime } from "../format";
import type { UiTask } from "../api/types";

export function Infra(): JSX.Element {
  const { toast, toastError } = useStore();
  const { data: kali, error, refresh } = usePoll(() => api.kaliStatus(), 10000);
  const { data: tasks, refresh: refreshTasks } = usePoll(() => api.tasks(), 3000);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const running = (tasks?.tasks ?? []).find((t) => t.status === "running");
  const shown = (tasks?.tasks ?? []).find((t) => t.id === activeTask) ?? running ?? (tasks?.tasks ?? [])[0];

  const runOp = async (op: "pull" | "build" | "protect" | "smoke"): Promise<void> => {
    try {
      const res = await api.kaliOp(op);
      setActiveTask(res.task.id);
      toast(`rionext kali ${op}`, res.already_running ? "该操作已在跑" : "后台任务已起跑，日志见下");
      refreshTasks();
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <ErrorLine error={error} />
      <div className="grid g2">
        <div className="card">
          <h3>Kali 镜像（master 只建一次，克隆随战役生灭）</h3>
          <KV k="docker">{kali?.docker ? <Tag tone="ok">available</Tag> : <Tag tone="bad">missing</Tag>}</KV>
          <KV k="rolling / master">
            {kali?.image ?? "rionext-kali:rolling"} · {kali?.master_present ? <Tag tone="ok">present</Tag> : <Tag tone="bad">missing</Tag>}
          </KV>
          <KV k="keeper">
            {kali?.keeper ?? "rionext-master-keep"} · {kali?.keeper_status ?? "-"}
          </KV>
          <KV k="context">{kali?.context ?? "-"}</KV>
          <div className="flex mt">
            <button className="ghost sm" onClick={() => refresh()}>
              status
            </button>
            <button className="ghost sm" disabled={!!running} onClick={() => void runOp("pull")}>
              pull
            </button>
            <button className="ghost sm" disabled={!!running} onClick={() => void runOp("build")}>
              build
            </button>
            <button className="ghost sm" disabled={!!running} onClick={() => void runOp("protect")}>
              protect
            </button>
            <button className="ghost sm" disabled={!!running} onClick={() => void runOp("smoke")}>
              smoke
            </button>
          </div>
          <div className="mini mt">{kali?.note ?? "Campaigns clone the master. cancel docker rm's the clone. Never docker rmi the master."}</div>
          <div className="mt">
            <TaskLog task={shown ?? null} />
          </div>
        </div>
        <div>
          <div className="card">
            <h3>后台任务</h3>
            <table>
              <thead>
                <tr>
                  <th>task</th>
                  <th>状态</th>
                  <th>开始</th>
                  <th>结束</th>
                </tr>
              </thead>
              <tbody>
                {(tasks?.tasks ?? []).map((t) => (
                  <tr key={t.id} className="click" onClick={() => setActiveTask(t.id)}>
                    <td>
                      {t.label}
                      <div className="mini">{t.id}</div>
                    </td>
                    <td>
                      <Tag tone={t.status === "done" ? "ok" : t.status === "error" ? "bad" : "warn"}>{t.status}</Tag>
                    </td>
                    <td className="mini">{fmtTime(t.started_at)}</td>
                    <td className="mini">{t.finished_at ? fmtTime(t.finished_at) : "-"}</td>
                  </tr>
                ))}
                {!tasks?.tasks.length ? (
                  <tr>
                    <td colSpan={4} className="mini">
                      （还没有后台任务；pull/build/protect/smoke 会在这里出现）
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <BackupCard />
        </div>
      </div>
    </>
  );
}

function TaskLog({ task }: { task: UiTask | null }): JSX.Element {
  if (!task) return <LogBox text="> 等待操作…" />;
  const tail = task.log ? task.log.split("\n").slice(-200).join("\n") : "(暂无输出)";
  return (
    <>
      <div className="mini">
        {task.label} · {task.status}
        {task.exit_code != null ? ` · exit ${task.exit_code}` : ""}
      </div>
      <LogBox text={tail} />
    </>
  );
}

function BackupCard(): JSX.Element {
  const { toast, toastError } = useStore();
  const [restoreFrom, setRestoreFrom] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="card mt">
      <h3>备份与恢复</h3>
      <div className="mini">backup 打包 SQLite + artifacts 到数据目录 backups/ 下；restore 回数据目录（会覆盖现有数据）。</div>
      <div className="flex mt">
        <ActionButton
          label="backup"
          cli="rionext backup"
          onRun={async () => {
            const res = await api.backup();
            return res.dest_dir;
          }}
          onDone={(dest) => toast(`备份完成：${String(dest)}`, "backup 完成")}
        />
      </div>
      <div className="frow mt">
        <label>restore --from</label>
        <input value={restoreFrom} onChange={(e) => setRestoreFrom(e.target.value)} placeholder="D:\backups\rionext-20260910 或 .rionext/backups/backup-…" />
      </div>
      <button
        className="ghost sm"
        disabled={busy || !restoreFrom.trim()}
        onClick={async () => {
          if (!window.confirm(`用 ${restoreFrom} 覆盖当前数据目录？`)) return;
          setBusy(true);
          try {
            await api.restore(restoreFrom.trim());
            toast(`rionext restore --from ${restoreFrom.trim()}`, "restore 完成");
          } catch (err) {
            toastError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "restore"}
      </button>
    </div>
  );
}
