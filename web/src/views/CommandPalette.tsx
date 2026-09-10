import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { useStore, type RouteName } from "../store";
import { BudgetForm, HintForm, RejectForm } from "../components/verify";

interface Cmd {
  label: string;
  group: string;
  cli: string;
  needsCamp?: boolean;
  run: (camp: string) => void | Promise<void>;
}

export function CommandPalette(): JSX.Element | null {
  const { paletteOpen, setPaletteOpen, camp, go, toast, toastError, openModal, setWizardOpen } = useStore();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [paletteOpen]);

  const commands = useMemo<Cmd[]>(() => {
    const nav = (label: string, cli: string, route: RouteName, group = "巡检"): Cmd => ({
      label,
      group,
      cli,
      run: () => go(route),
    });
    const withCamp = (label: string, cli: (id: string) => string, fn: (id: string) => Promise<unknown>, cap?: string): Cmd => ({
      label,
      group: "战役",
      cli: cli(camp ?? "<id>"),
      needsCamp: true,
      run: async (id) => {
        await fn(id);
        toast(cli(id), cap);
      },
    });
    return [
      { label: "新战役 · 三步向导", group: "创建", cli: "rionext run --url/--input/--spec", run: () => setWizardOpen(true, null) },
      { label: "新战役 --url 活靶", group: "创建", cli: "rionext run --url http://…/", run: () => setWizardOpen(true, "url") },
      { label: "新战役 --input 本地附件", group: "创建", cli: "rionext run --input ./challenge.zip", run: () => setWizardOpen(true, "input") },
      { label: "新战役 --spec 文件/JSON", group: "创建", cli: "rionext run --spec profiles/kali-lab.json", run: () => setWizardOpen(true, "spec") },
      withCamp("start 起/续跑", (id) => `rionext start ${id}`, (id) => api.start(id)),
      withCamp("pause 暂停", (id) => `rionext pause ${id}`, (id) => api.pause(id)),
      withCamp("resume 续跑", (id) => `rionext resume ${id}`, async (id) => {
        await api.resume(id);
      }),
      {
        label: "cancel 取消（清克隆容器）",
        group: "战役",
        cli: `rionext cancel ${camp ?? "<id>"}`,
        needsCamp: true,
        run: async (id) => {
          if (!window.confirm(`cancel ${id}？会 docker rm 克隆容器（master 不动）。`)) return;
          await api.cancel(id);
          toast(`rionext cancel ${id}`);
        },
      },
      {
        label: "accept 接受待审 flag",
        group: "战役",
        cli: `rionext accept ${camp ?? "<id>"}`,
        needsCamp: true,
        run: async (id) => {
          await api.verify(id, { accept: true });
          toast(`rionext accept ${id}`, "接受并收卷");
        },
      },
      {
        label: "reject 驳回 flag…",
        group: "战役",
        cli: `rionext reject ${camp ?? "<id>"} --text "…"`,
        needsCamp: true,
        run: (id) => openModal(<RejectForm id={id} />),
      },
      {
        label: "hint 注入提示…",
        group: "战役",
        cli: `rionext hint ${camp ?? "<id>"} --text "…"`,
        needsCamp: true,
        run: (id) => openModal(<HintForm id={id} />),
      },
      {
        label: "revise-budget 追加预算…",
        group: "战役",
        cli: `rionext revise-budget ${camp ?? "<id>"} --max-calls …`,
        needsCamp: true,
        run: (id) => openModal(<BudgetForm id={id} />),
      },
      withCamp("reconcile 全量核对", (id) => `rionext reconcile ${id}`, (id) => api.reconcile(id)),
      {
        label: "打开战役详情",
        group: "战役",
        cli: `rionext status ${camp ?? "<id>"}`,
        needsCamp: true,
        run: (id) => go("detail", id),
      },
      nav("总览仪表盘", "rionext status", "dash"),
      nav("战役列表", "rionext list", "camps"),
      nav("审查中心（待审 flag）", "rionext accept/reject", "review"),
      nav("模型目录与槽位配线", "rionext provider slots", "models", "模型"),
      nav("基础设施 · Kali 与任务", "rionext kali status", "infra", "基础设施"),
      {
        label: "kali pull 拉镜像",
        group: "基础设施",
        cli: "rionext kali pull",
        run: async () => {
          await api.kaliOp("pull");
          toast("rionext kali pull", "后台任务已起，跳到基础设施看日志");
          go("infra");
        },
      },
      {
        label: "kali build 构建",
        group: "基础设施",
        cli: "rionext kali build",
        run: async () => {
          await api.kaliOp("build");
          toast("rionext kali build", "后台任务已起，跳到基础设施看日志");
          go("infra");
        },
      },
      {
        label: "kali protect 保护 master",
        group: "基础设施",
        cli: "rionext kali protect",
        run: async () => {
          await api.kaliOp("protect");
          toast("rionext kali protect");
        },
      },
      {
        label: "kali smoke 自检",
        group: "基础设施",
        cli: "rionext kali smoke",
        run: async () => {
          await api.kaliOp("smoke");
          toast("rionext kali smoke", "后台任务已起，跳到基础设施看日志");
          go("infra");
        },
      },
      nav("设置 · 运行参数与锁", "rionext health", "settings", "运维"),
      {
        label: "backup 备份数据目录",
        group: "运维",
        cli: "rionext backup",
        run: async () => {
          const res = (await api.backup()) as { dest_dir: string };
          toast("rionext backup", `备份到 ${res.dest_dir}`);
        },
      },
    ];
  }, [camp, go, toast, openModal, setWizardOpen]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => fuzzy(needle, `${c.label} ${c.cli} ${c.group}`.toLowerCase()));
  }, [q, commands]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!paletteOpen) return null;

  const exec = (cmd: Cmd): void => {
    if (cmd.needsCamp && !camp) {
      toastError("这条命令要先打开一个战役详情（或先在详情页按 ⌘K）");
      return;
    }
    setPaletteOpen(false);
    void Promise.resolve(cmd.run(camp!)).catch((err) => toastError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div
      className="palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) setPaletteOpen(false);
      }}
    >
      <div className="box">
        <input
          ref={inputRef}
          placeholder="输入命令或战役操作…（↑↓ 选择，回车执行，Esc 关闭）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPaletteOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              const cmd = filtered[sel];
              if (cmd) exec(cmd);
            }
          }}
        />
        <div className="list">
          {filtered.map((cmd, i) => (
            <div key={cmd.label} className={`item ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => exec(cmd)}>
              {cmd.label}
              <span className="g">
                {cmd.group} · {cmd.cli}
                {cmd.needsCamp && !camp ? " · 需先选战役" : ""}
              </span>
            </div>
          ))}
          {!filtered.length ? <div className="item">没有匹配的命令</div> : null}
        </div>
      </div>
    </div>
  );
}

function fuzzy(needle: string, hay: string): boolean {
  if (hay.includes(needle)) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i >= needle.length) return true;
  }
  return false;
}
