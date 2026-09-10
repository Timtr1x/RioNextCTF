import { useEffect } from "react";
import { api } from "./api/client";
import { usePoll } from "./hooks/usePoll";
import { useStore, type RouteName } from "./store";
import { ModalHost, ToastHost } from "./components/ui";
import { Dashboard } from "./views/Dashboard";
import { Campaigns } from "./views/Campaigns";
import { CampaignDetail } from "./views/detail/CampaignDetail";
import { Review } from "./views/Review";
import { Models } from "./views/Models";
import { Infra } from "./views/Infra";
import { Settings } from "./views/Settings";
import { Wizard } from "./views/Wizard";
import { CommandPalette } from "./views/CommandPalette";

const NAV: [RouteName, string][] = [
  ["dash", "总览"],
  ["camps", "战役"],
  ["review", "审查中心"],
  ["models", "模型目录"],
  ["infra", "基础设施"],
  ["settings", "设置"],
];

const CRUMB: Record<RouteName, string> = {
  dash: "总览",
  camps: "战役",
  detail: "战役详情",
  review: "审查中心",
  models: "模型目录",
  infra: "基础设施",
  settings: "设置",
};

export function App(): JSX.Element {
  const { route, camp, go, setPaletteOpen, wizardOpen, wizardSource, setWizardOpen } = useStore();
  const { data: health } = usePoll(() => api.health(), 5000);
  const { data: camps } = usePoll(() => api.campaigns(), 5000);
  const pending = (camps?.campaigns ?? []).filter((c) => c.pending_goal_claim).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setPaletteOpen]);

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <em>RioNext</em> 工作台
        </div>
        <nav>
          {NAV.map(([r, label]) => (
            <a key={r} className={route === r || (r === "camps" && route === "detail") ? "on" : ""} onClick={() => go(r)}>
              <span>{label}</span>
              {r === "review" && pending > 0 ? <span className="cnt">{pending}</span> : null}
            </a>
          ))}
        </nav>
        <div className="foot">
          v{health?.version ?? "…"} · ui 进程内执行
          <br />
          {health?.running?.length ? `${health.running.length} 个战役在本进程跑` : "API 在线时此处显示运行数"}
        </div>
      </aside>
      <main>
        <div className="top">
          <span className="crumb">
            {CRUMB[route]}
            {route === "detail" && camp ? (
              <>
                {" / "}
                <b style={{ color: "var(--ink)" }}>{camp}</b>
              </>
            ) : null}
          </span>
          <span className="spacer" />
          <span className={`chip ${health && !health.docker ? "bad" : ""}`}>
            {health
              ? `docker ${health.docker ? "ok" : "missing"} · kali ${health.kali_master ? "ok" : "missing"} · keeper ${health.keeper ?? "-"}`
              : "连接中…"}
          </span>
          <span className="chip">{health ? `数据目录 ${health.data_dir}` : ""}</span>
          <button className="ghost sm" onClick={() => setPaletteOpen(true)}>
            命令面板 ⌘K
          </button>
          <button className="sm acc" onClick={() => setWizardOpen(true)}>
            ＋ 新战役
          </button>
        </div>
        <div className="page">
          {route === "dash" && <Dashboard />}
          {route === "camps" && <Campaigns />}
          {route === "detail" && camp && <CampaignDetail id={camp} />}
          {route === "detail" && !camp && <Campaigns />}
          {route === "review" && <Review />}
          {route === "models" && <Models />}
          {route === "infra" && <Infra />}
          {route === "settings" && <Settings />}
        </div>
      </main>
      <ModalHost />
      {wizardOpen && <Wizard onClose={() => setWizardOpen(false)} initialSource={wizardSource} />}
      <CommandPalette />
      <ToastHost />
    </div>
  );
}
