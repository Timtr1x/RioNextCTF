import { useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { usePoll } from "../hooks/usePoll";
import { useStore, type WizardSource } from "../store";
import { Tag } from "../components/ui";
import { fmtBytes } from "../format";
import type { TriagePreview } from "../api/types";

type Source = WizardSource;

interface WzState {
  source: Source;
  url: string;
  id: string;
  files: File[];
  uploadId: string | null;
  label: string;
  kind: string;
  endpoint: string;
  webUrl: string;
  hint: string;
  specText: string;
}

const INIT: WzState = {
  source: "url",
  url: "",
  id: "",
  files: [],
  uploadId: null,
  label: "",
  kind: "auto",
  endpoint: "",
  webUrl: "",
  hint: "",
  specText: "",
};

export function Wizard({ onClose, initialSource }: { onClose: () => void; initialSource?: Source | null }): JSX.Element {
  const { toast, toastError, go } = useStore();
  const [step, setStep] = useState(1);
  const [wz, setWz] = useState<WzState>(() => (initialSource ? { ...INIT, source: initialSource } : INIT));
  const [busy, setBusy] = useState(false);
  const [triage, setTriage] = useState<TriagePreview | null>(null);
  const { data: catalog } = usePoll(() => api.catalog(), 0);
  const solver = useMemo(() => {
    const slot = catalog?.slots.find((s) => s.slot === "solver");
    const model = catalog?.models.find((m) => m.id === slot?.model_id);
    const provider = catalog?.providers.find((p) => p.id === slot?.provider_id);
    return model ? `${model.name} · ${provider?.display_name ?? ""}` : "（未配置 solver 槽，先去模型目录）";
  }, [catalog]);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { start: true };
      let cli = "";
      if (wz.source === "url") {
        body.url = wz.url.trim();
        if (wz.id.trim()) body.id = wz.id.trim();
        cli = `rionext run --url ${wz.url.trim()}`;
      } else if (wz.source === "input") {
        body.upload_id = wz.uploadId;
        if (wz.id.trim()) body.id = wz.id.trim();
        else if (triage?.campaign_id) body.id = triage.campaign_id;
        if (wz.kind !== "auto") body.kind = wz.kind;
        if (wz.endpoint.trim()) body.endpoint = wz.endpoint.trim();
        if (wz.webUrl.trim()) body.web_url = wz.webUrl.trim();
        if (wz.hint.trim()) body.hint = wz.hint.trim();
        body.label = wz.label;
        cli = `rionext run --input ${wz.label || "附件"}${wz.kind !== "auto" ? ` --kind ${wz.kind}` : ""}${wz.endpoint ? ` --endpoint ${wz.endpoint}` : ""}${wz.webUrl ? ` --web-url ${wz.webUrl}` : ""}${wz.hint ? ` --hint "${wz.hint}"` : ""}`;
      } else {
        body.spec = JSON.parse(wz.specText);
        cli = "rionext run --spec <json>";
      }
      const res = await api.createCampaign(body);
      toast(cli, res.created ? "创建并 start；同 id 已存在则续跑" : "战役已存在，续跑同一 id");
      onClose();
      go("detail", String(res.id));
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const step1Valid =
    (wz.source === "url" && /^https?:\/\//i.test(wz.url.trim())) ||
    (wz.source === "input" && wz.uploadId !== null) ||
    (wz.source === "spec" && wz.specText.trim() !== "");
  const step2Valid = true;

  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <span className="close" onClick={onClose}>
          ✕
        </span>
        <div className="steps-ind">
          <span className={step === 1 ? "on" : ""}>① 入口与题型</span>
          <span className={step === 2 ? "on" : ""}>② 模型与预算</span>
          <span className={step === 3 ? "on" : ""}>③ 确认生成</span>
        </div>
        {step === 1 && <Step1 wz={wz} setWz={setWz} triage={triage} setTriage={setTriage} />}
        {step === 2 && <Step2 wz={wz} solver={solver} />}
        {step === 3 && <Step3 wz={wz} solver={solver} triage={triage} />}
        <div className="flex mt">
          {step > 1 ? (
            <button className="ghost" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          ) : null}
          <span className="spacer" />
          {step < 3 ? (
            <button disabled={step === 1 ? !step1Valid : !step2Valid} onClick={() => setStep(step + 1)}>
              下一步
            </button>
          ) : (
            <button className="acc" disabled={busy} onClick={() => void create()}>
              {busy ? "创建中…" : "创建并 start"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Step1({
  wz,
  setWz,
  triage,
  setTriage,
}: {
  wz: WzState;
  setWz: (w: WzState) => void;
  triage: TriagePreview | null;
  setTriage: (t: TriagePreview | null) => void;
}): JSX.Element {
  return (
    <>
      <h2>选择入口</h2>
      <div className="flex mt">
        {(
          [
            ["url", "--url 活靶 web"],
            ["input", "--input 本地附件"],
            ["spec", "--spec 文件/JSON"],
          ] as [Source, string][]
        ).map(([v, label]) => (
          <label key={v} style={{ flex: 1 }}>
            <input
              type="radio"
              name="wz-src"
              checked={wz.source === v}
              onChange={() => setWz({ ...wz, source: v })}
              style={{ width: "auto" }}
            />{" "}
            <b>{label.split(" ")[0]}</b> {label.split(" ").slice(1).join(" ")}
          </label>
        ))}
      </div>
      {wz.source === "url" && <UrlForm wz={wz} setWz={setWz} />}
      {wz.source === "input" && <InputForm wz={wz} setWz={setWz} triage={triage} setTriage={setTriage} />}
      {wz.source === "spec" && <SpecForm wz={wz} setWz={setWz} />}
    </>
  );
}

function UrlForm({ wz, setWz }: { wz: WzState; setWz: (w: WzState) => void }): JSX.Element {
  return (
    <>
      <div className="frow">
        <label>目标 URL</label>
        <input value={wz.url} onChange={(e) => setWz({ ...wz, url: e.target.value })} placeholder="http://authorized-target.example/" />
      </div>
      <div className="frow">
        <label>战役 id</label>
        <input value={wz.id} onChange={(e) => setWz({ ...wz, id: e.target.value })} placeholder="留空按 host 生成 camp_<host>" />
      </div>
      <div className="mini">solver 槽模型跑；成功条件固定 flag_recovered；scope 自动带 host 与入口 URL；出口按解析 IP 放行。同 URL 再跑续接同 id。</div>
    </>
  );
}

function InputForm({
  wz,
  setWz,
  triage,
  setTriage,
}: {
  wz: WzState;
  setWz: (w: WzState) => void;
  triage: TriagePreview | null;
  setTriage: (t: TriagePreview | null) => void;
}): JSX.Element {
  const { toastError } = useStore();
  const [uploading, setUploading] = useState(false);
  const [triaging, setTriaging] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  const doTriage = async (uploadId: string, label: string, kind: string, endpoint: string, webUrl: string, hint: string): Promise<void> => {
    const seq = ++seqRef.current;
    setTriaging(true);
    try {
      const res = await api.triage({
        upload_id: uploadId,
        label,
        ...(kind !== "auto" ? { kind } : {}),
        ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
        ...(webUrl.trim() ? { web_url: webUrl.trim() } : {}),
        ...(hint.trim() ? { hint: hint.trim() } : {}),
      });
      if (seq === seqRef.current) setTriage(res);
    } catch (err) {
      if (seq === seqRef.current) toastError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === seqRef.current) setTriaging(false);
    }
  };

  const pick = async (files: File[]): Promise<void> => {
    if (!files.length) return;
    setUploading(true);
    setTriage(null);
    try {
      const label = (files[0]!.webkitRelativePath ? files[0]!.webkitRelativePath.split("/")[0]! : files[0]!.name.replace(/\.[a-z0-9]{1,8}$/i, "")) || "input";
      // 每次选择开新批次：同一 upload_id 在服务端是追加，重选不该混入上一批文件
      let uploadId: string | null = null;
      for (const f of files) {
        const rel = f.webkitRelativePath || f.name;
        const res = await api.upload(
          { name: f.name, path: rel !== f.name ? rel : undefined, data: await f.arrayBuffer() },
          { ...(uploadId ? { uploadId } : {}), label },
        );
        uploadId = res.upload_id;
      }
      const next = { ...wz, files, uploadId, label };
      setWz(next);
      await doTriage(uploadId!, label, next.kind, next.endpoint, next.webUrl, next.hint);
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  // 粘贴附件链接：服务端下载成一个 upload 批次，之后和选文件走同一条 triage 流程
  const fetchLink = async (): Promise<void> => {
    const url = linkUrl.trim();
    if (!url) return;
    setFetching(true);
    setTriage(null);
    try {
      const label = (url.split("/").filter(Boolean).pop() ?? "attachment").replace(/\.[a-z0-9]{1,8}$/i, "").slice(0, 60) || "attachment";
      const res = await api.fetchUpload({ url, label });
      const next = { ...wz, files: [], uploadId: res.upload_id, label };
      setWz(next);
      await doTriage(res.upload_id, label, next.kind, next.endpoint, next.webUrl, next.hint);
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  };

  return (
    <>
      <div className="frow">
        <label>附件</label>
        <div className="flex">
          <input
            ref={fileRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => void pick(Array.from(e.target.files ?? []))}
          />
          <button className="ghost sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? "上传中…" : "选文件（可多选）"}
          </button>
          <DirButton disabled={uploading} onPick={(files) => void pick(files)} />
          <span className="mini">
            {wz.files.length ? `${wz.files.length} 个文件 · ${fmtBytes(wz.files.reduce((a, f) => a + f.size, 0))}` : "elf / apk / pcap / zip / 文本…"}
          </span>
        </div>
      </div>
      <div className="frow">
        <label>附件链接</label>
        <div className="flex">
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void fetchLink();
            }}
            placeholder="https://ctf.example/files/task.zip（服务端下载）"
          />
          <button className="ghost sm" disabled={fetching || uploading || !linkUrl.trim()} onClick={() => void fetchLink()}>
            {fetching ? "下载中…" : "下载并判定"}
          </button>
        </div>
      </div>
      <div className="frow">
        <label>--kind</label>
        <select
          value={wz.kind}
          onChange={(e) => {
            const next = { ...wz, kind: e.target.value };
            setWz(next);
            if (next.uploadId) void doTriage(next.uploadId, next.label, next.kind, next.endpoint, next.webUrl, next.hint);
          }}
        >
          {["auto", "reverse", "pwn", "misc", "crypto", "generic"].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </div>
      <div className="frow">
        <label>--endpoint</label>
        <input
          value={wz.endpoint}
          onChange={(e) => setWz({ ...wz, endpoint: e.target.value })}
          onBlur={() => wz.uploadId && void doTriage(wz.uploadId, wz.label, wz.kind, wz.endpoint, wz.webUrl, wz.hint)}
          placeholder="tcp://10.20.30.40:9999（可空）"
        />
      </div>
      <div className="frow">
        <label>--web-url</label>
        <input
          value={wz.webUrl}
          onChange={(e) => setWz({ ...wz, webUrl: e.target.value })}
          onBlur={() => wz.uploadId && void doTriage(wz.uploadId, wz.label, wz.kind, wz.endpoint, wz.webUrl, wz.hint)}
          placeholder="http://靶机:8080/（web 题给源码时用，可空）"
        />
      </div>
      <div className="frow">
        <label>--hint</label>
        <input
          value={wz.hint}
          onChange={(e) => setWz({ ...wz, hint: e.target.value })}
          onBlur={() => wz.uploadId && void doTriage(wz.uploadId, wz.label, wz.kind, wz.endpoint, wz.webUrl, wz.hint)}
          placeholder="登录逻辑在 native lib（可空）"
        />
      </div>
      <div className="mt">
        {triaging ? <div className="mini">triage 判定中…</div> : null}
        {triage ? <TriageCard t={triage} /> : null}
      </div>
    </>
  );
}

function DirButton({ disabled, onPick }: { disabled: boolean; onPick: (files: File[]) => void }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        style={{ display: "none" }}
        // @ts-expect-error non-standard but supported in chromium/firefox
        webkitdirectory=""
        onChange={(e) => onPick(Array.from(e.target.files ?? []))}
      />
      <button className="ghost sm" disabled={disabled} onClick={() => ref.current?.click()}>
        选目录
      </button>
    </>
  );
}

function TriageCard({ t }: { t: TriagePreview }): JSX.Element {
  return (
    <div className="card" style={{ margin: 0 }}>
      <h3>triage 预览（本地确定性，不跑附件）</h3>
      <div className="flex">
        <Tag tone="ok">
          题型 {t.triage.kind}
          {t.triage.overlay ? `/${t.triage.overlay}` : ""}
        </Tag>
        <Tag>置信度 {t.triage.confidence}</Tag>
        <Tag>seed {t.triage.seed_method_family}</Tag>
        {t.triage.skill_pack ? <Tag>skill {t.triage.skill_pack}</Tag> : null}
        {t.detected !== t.triage.kind ? <Tag tone="warn">detected {t.detected} → 覆盖 {t.triage.kind}</Tag> : null}
        {t.capabilities?.length ? <Tag tone="ok">工具能力 {t.capabilities.join("+")}（分类只是建议，两类都可用）</Tag> : null}
      </div>
      {(t.triage.evidence ?? []).slice(0, 6).map((e, i) => (
        <div className="evi" key={i}>
          [{e.source} w{e.weight}] {e.value}
        </div>
      ))}
      <div className="mini mt">
        {t.files} 个文件 · {fmtBytes(t.total_bytes)} · sha256 {t.sha256.slice(0, 12)}… · 战役 id {t.campaign_id}
      </div>
      <div className="mini">workspace：input/original 只读 · input/manifest.json · work/ · artifacts/。同输入重跑续同 id。</div>
    </div>
  );
}

function SpecForm({ wz, setWz }: { wz: WzState; setWz: (w: WzState) => void }): JSX.Element {
  const { toastError } = useStore();
  const valid = useMemo(() => {
    try {
      JSON.parse(wz.specText);
      return true;
    } catch {
      return false;
    }
  }, [wz.specText]);
  return (
    <>
      <div className="frow">
        <label>spec JSON</label>
        <textarea rows={10} value={wz.specText} onChange={(e) => setWz({ ...wz, specText: e.target.value })} placeholder='{"campaign_id":"camp_…","mode":"goal_seeking",…}' />
      </div>
      <div className="flex">
        <button
          className="ghost sm"
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".json";
            input.onchange = async () => {
              const f = input.files?.[0];
              if (!f) return;
              try {
                setWz({ ...wz, specText: await f.text() });
              } catch (err) {
                toastError(err instanceof Error ? err.message : String(err));
              }
            };
            input.click();
          }}
        >
          从文件读入
        </button>
        {wz.specText && !valid ? <span className="mini" style={{ color: "var(--red)" }}>JSON 还不合法</span> : null}
        {valid ? <Tag tone="ok">JSON 合法</Tag> : null}
      </div>
      <div className="mini mt">至少要有 campaign_id、mode、root_goal、budget、model_policy、scope.assets、tool_allowlist。profiles/ 下有 demo-lab 与 kali-lab 样例。</div>
    </>
  );
}

function Step2({ wz, solver }: { wz: WzState; solver: string }): JSX.Element {
  return (
    <>
      <h2>模型与预算</h2>
      <div className="card" style={{ margin: "10px 0" }}>
        <div className="kv">
          <span className="k">solver 槽模型</span>
          <span>{solver}</span>
        </div>
        <div className="kv">
          <span className="k">片段上限</span>
          <span>72 轮模型 / 144 次工具</span>
        </div>
        <div className="kv">
          <span className="k">预算</span>
          <span>3000 calls · 30M tokens</span>
        </div>
        <div className="kv">
          <span className="k">Finalize 收卷</span>
          <span>开（默认）</span>
        </div>
      </div>
      <div className="mini">
        {wz.source === "spec"
          ? "spec 入口的模型与预算以 spec JSON 里的 model_policy / budget 为准。"
          : "--url/--input 和 CLI 一样走 solver 槽 + 默认预算；想换模型去「模型目录」改 solver 槽，想改预算创建后用 revise-budget。"}
      </div>
    </>
  );
}

function Step3({ wz, solver, triage }: { wz: WzState; solver: string; triage: TriagePreview | null }): JSX.Element {
  const summary = useMemo(() => {
    if (wz.source === "url") return { entry: `--url ${wz.url}`, id: wz.id || "按 host 生成" };
    if (wz.source === "input")
      return {
        entry: `--input ${wz.label}（${wz.files.length} 个文件）${wz.kind !== "auto" ? ` --kind ${wz.kind}` : ""}${wz.endpoint ? ` --endpoint ${wz.endpoint}` : ""}${wz.webUrl ? ` --web-url ${wz.webUrl}` : ""}${wz.hint ? ` --hint "${wz.hint}"` : ""}`,
        id: triage?.campaign_id ?? wz.id,
      };
    let id = "?";
    try {
      id = String((JSON.parse(wz.specText) as { campaign_id?: string }).campaign_id ?? "?");
    } catch {
      // invalid json shown in step 1
    }
    return { entry: "--spec <json>", id };
  }, [wz, triage]);

  return (
    <>
      <h2>确认</h2>
      <div className="kv">
        <span className="k">入口</span>
        <span>{summary.entry}</span>
      </div>
      <div className="kv">
        <span className="k">战役 id</span>
        <span>{summary.id}</span>
      </div>
      <div className="kv">
        <span className="k">solver</span>
        <span>{solver}</span>
      </div>
      {triage ? (
        <div className="flex mt">
          <Tag tone="ok">
            triage：{triage.triage.kind}
            {triage.triage.overlay ? `/${triage.triage.overlay}` : ""} · {triage.triage.confidence} · seed {triage.triage.seed_method_family}
          </Tag>
        </div>
      ) : null}
      {wz.source === "spec" ? <pre>{wz.specText.slice(0, 4000)}</pre> : null}
      <div className="mini mt">创建并 start：战役在本 ui 进程内起跑；同 id 已存在则续跑。点下去就真打，确认目标在授权范围内。</div>
    </>
  );
}
