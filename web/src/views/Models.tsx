import { useState } from "react";
import { api, ApiError } from "../api/client";
import { usePoll } from "../hooks/usePoll";
import { useStore } from "../store";
import { ActionButton, ErrorLine, KV, Tag } from "../components/ui";
import type { Catalog, ModelRecord, ProbeReport, ProviderRecord } from "../api/types";

const SLOT_LABELS: Record<string, string> = {
  solver: "主求解",
  reflect: "反思",
  visual: "视觉",
  triage: "Triage",
  manager: "Manager",
};
const SLOT_ORDER = ["solver", "reflect", "visual", "triage", "manager"];

export function Models(): JSX.Element {
  const { openModal } = useStore();
  const { data, error, refresh } = usePoll(() => api.catalog(), 5000);
  const cat = data;

  return (
    <>
      <ErrorLine error={error} />
      <div className="grid g2">
        <div className="card">
          <h3>Provider 目录（key 只存 provider-secrets.json，永不回显）</h3>
          <table>
            <thead>
              <tr>
                <th>供应商</th>
                <th>协议</th>
                <th>key</th>
                <th>模型</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(cat?.providers ?? []).map((p) => (
                <tr key={p.id}>
                  <td>
                    <b>{p.display_name}</b>
                    <div className="mini">{p.id}</div>
                  </td>
                  <td className="mini">{p.protocol}</td>
                  <td>{p.api_key_set ? <Tag tone="ok">已设置</Tag> : <Tag tone="bad">未设置</Tag>}</td>
                  <td className="mini">{(cat?.models ?? []).filter((m) => m.provider_id === p.id).map((m) => m.name).join("，") || "-"}</td>
                  <td className="flex">
                    <button className="ghost sm" onClick={() => openModal(<KeyForm provider={p} onDone={() => refresh()} />)}>
                      换 key
                    </button>
                    <ActionButton
                      label="删除"
                      className="danger sm"
                      cli={`rionext provider rm --provider ${p.id}`}
                      cap="删除供应商、模型和 key"
                      confirm={`删除 ${p.display_name}、它的全部模型和 key？`}
                      onRun={() => api.removeProvider(p.id)}
                      onDone={() => refresh()}
                    />
                  </td>
                </tr>
              ))}
              {!cat?.providers.length ? (
                <tr>
                  <td colSpan={5} className="mini">
                    （还没有 provider，先添加一个再跑战役）
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="flex mt">
            <button onClick={() => openModal(<ProviderForm onDone={() => refresh()} />)}>添加 provider</button>
            <button className="ghost" onClick={() => openModal(<ModelForm cat={cat} onDone={() => refresh()} />)} disabled={!cat?.providers.length}>
              添加 model
            </button>
          </div>
        </div>
        <div className="card">
          <h3>连接探测（auth / text / tools / vision / reasoning + variants）</h3>
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th>可用</th>
                <th>上下文/输出</th>
                <th>vision</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(cat?.models ?? []).map((m) => (
                <ModelRow key={m.id} cat={cat!} model={m} onDone={() => refresh()} />
              ))}
              {!cat?.models.length ? (
                <tr>
                  <td colSpan={5} className="mini">
                    （无模型）
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card mt">
        <h3>槽位配线（空槽回落 solver）</h3>
        <SlotsCard cat={cat} onDone={() => refresh()} />
      </div>
    </>
  );
}

function ModelRow({ cat, model, onDone }: { cat: Catalog; model: ModelRecord; onDone: () => void }): JSX.Element {
  const { openModal, toastError } = useStore();
  const [busy, setBusy] = useState(false);
  const provider = cat.providers.find((p) => p.id === model.provider_id);
  return (
    <tr>
      <td>
        <b>{model.name}</b>
        <div className="mini">{provider?.display_name ?? model.provider_id}</div>
      </td>
      <td>{model.available ? <Tag tone="ok">available</Tag> : <Tag tone="bad">未探测/失败</Tag>}</td>
      <td className="mini">
        {model.context_window ? `${model.context_window / 1000}K` : "-"} / {model.max_output_tokens ? `${model.max_output_tokens / 1000}K` : "-"}
      </td>
      <td className="mini">{model.vision ? "有" : "无"}</td>
      <td className="flex">
        <button
          className="ghost sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api.testModel(model.provider_id, model.id);
              openModal(<ProbeModal model={model.name} report={res.report} available={res.available} />);
              onDone();
            } catch (err) {
              toastError(err instanceof ApiError ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "…" : "test"}
        </button>
        <ActionButton
          label="rm"
          className="danger sm"
          cli={`rionext provider model rm --model ${model.id}`}
          confirm={`删除模型 ${model.name}？`}
          onRun={() => api.removeModel(model.id)}
          onDone={onDone}
        />
      </td>
    </tr>
  );
}

function SlotsCard({ cat, onDone }: { cat: Catalog | undefined; onDone: () => void }): JSX.Element {
  const { toast, toastError } = useStore();
  const allModels = cat?.models ?? [];
  const modelName = (id: string | null): string => allModels.find((m) => m.id === id)?.name ?? "";
  return (
    <>
      {SLOT_ORDER.map((slot) => {
        const cur = cat?.slots.find((s) => s.slot === slot);
        return (
          <div className="slot" key={slot}>
            <span>
              <b>{slot}</b> <span className="mini">{SLOT_LABELS[slot]}</span>
            </span>
            <span className="mini">{cur?.model_id ? modelName(cur.model_id) : "（回落 solver）"}</span>
            <select
              value={cur?.model_id ?? ""}
              onChange={async (e) => {
                try {
                  await api.assignSlot(slot, e.target.value || "none");
                  toast(`rionext provider slots --${slot} ${e.target.value || "none"}`);
                  onDone();
                } catch (err) {
                  toastError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              <option value="">（回落 solver）</option>
              {allModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </>
  );
}

function ProviderForm({ onDone }: { onDone: () => void }): JSX.Element {
  const { toast, toastError, closeModal } = useStore();
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("OPENAI_CHAT_COMPLETIONS");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h2>添加 provider</h2>
      <div className="frow">
        <label>名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="DeepSeek Direct" />
      </div>
      <div className="frow">
        <label>协议</label>
        <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
          <option>OPENAI_CHAT_COMPLETIONS</option>
          <option>OPENAI_RESPONSES</option>
          <option>ANTHROPIC_MESSAGES</option>
        </select>
      </div>
      <div className="frow">
        <label>base url</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1/chat/completions" />
      </div>
      <div className="frow">
        <label>api key</label>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." />
      </div>
      <button
        className="mt"
        disabled={busy || !name || !baseUrl || !key}
        onClick={async () => {
          setBusy(true);
          try {
            await api.addProvider({ display_name: name, protocol, base_url: baseUrl, api_key: key });
            toast(`rionext provider add --name "${name}" --protocol ${protocol} --base-url ${baseUrl} --api-key ******`);
            onDone();
            closeModal();
          } catch (err) {
            toastError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "添加"}
      </button>
    </>
  );
}

function ModelForm({ cat, onDone }: { cat: Catalog | undefined; onDone: () => void }): JSX.Element {
  const { toast, toastError, closeModal } = useStore();
  const [providerId, setProviderId] = useState(cat?.providers[0]?.id ?? "");
  const [name, setName] = useState("");
  const [ctx, setCtx] = useState("");
  const [out, setOut] = useState("");
  const [vision, setVision] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h2>添加 model</h2>
      <div className="frow">
        <label>provider</label>
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          {(cat?.providers ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name}
            </option>
          ))}
        </select>
      </div>
      <div className="frow">
        <label>模型名</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="deepseek-chat" />
      </div>
      <div className="frow">
        <label>context</label>
        <input type="number" value={ctx} onChange={(e) => setCtx(e.target.value)} placeholder="1000000" />
      </div>
      <div className="frow">
        <label>max output</label>
        <input type="number" value={out} onChange={(e) => setOut(e.target.value)} placeholder="51200" />
      </div>
      <div className="frow">
        <label>vision</label>
        <label className="mini" style={{ display: "flex", gap: 8 }}>
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} style={{ width: "auto" }} /> 支持图片输入
        </label>
      </div>
      <button
        className="mt"
        disabled={busy || !name || !providerId}
        onClick={async () => {
          setBusy(true);
          try {
            await api.addModel({
              provider_id: providerId,
              name,
              ...(ctx ? { context_window: Number(ctx) } : {}),
              ...(out ? { max_output_tokens: Number(out) } : {}),
              ...(vision ? { vision: true } : {}),
            });
            toast(`rionext provider model add --provider ${providerId} --name ${name}${ctx ? ` --context ${ctx}` : ""}${out ? ` --max-output ${out}` : ""}`);
            onDone();
            closeModal();
          } catch (err) {
            toastError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "添加"}
      </button>
    </>
  );
}

function KeyForm({ provider, onDone }: { provider: ProviderRecord; onDone: () => void }): JSX.Element {
  const { toast, toastError, closeModal } = useStore();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h2>换 key · {provider.display_name}</h2>
      <div className="mini">key 写入 .rionext/provider-secrets.json（0600），任何接口都不回显。</div>
      <div className="frow">
        <label>新 api key</label>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." />
      </div>
      <div className="flex mt">
        <button
          disabled={busy || !key}
          onClick={async () => {
            setBusy(true);
            try {
              await api.setProviderKey(provider.id, key);
              toast(`rionext provider key --provider ${provider.id} --api-key ******`);
              onDone();
              closeModal();
            } catch (err) {
              toastError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "…" : "替换 key"}
        </button>
        <ActionButton
          label="清除 key"
          className="danger sm"
          cli={`rionext provider key --provider ${provider.id} --clear`}
          confirm={`清除 ${provider.display_name} 的 key？`}
          onRun={() => api.clearProviderKey(provider.id)}
          onDone={() => {
            onDone();
            closeModal();
          }}
        />
      </div>
    </>
  );
}

function ProbeModal({ model, report, available }: { model: string; report: ProbeReport; available: boolean }): JSX.Element {
  const rows: [string, boolean, string][] = [
    ["auth", report.auth?.ok, report.auth?.detail ?? report.auth?.error ?? `${report.auth?.ms ?? "-"}ms`],
    ["text", report.text?.ok, report.text?.detail ?? report.text?.error ?? ""],
    ["tools", report.tools?.ok, report.tools?.detail ?? report.tools?.error ?? ""],
    ["vision", report.vision?.ok, report.vision?.detail ?? report.vision?.error ?? ""],
    ["reasoning", report.reasoning?.ok, report.reasoning?.detail ?? report.reasoning?.error ?? ""],
    ...(report.variants ?? []).map((v) => [`variant:${v.name}`, v.ok, v.detail ?? ""] as [string, boolean, string]),
  ];
  return (
    <>
      <h2>探测报告 · {model}</h2>
      <div className="mini">
        available={String(available)} · {report.at}
      </div>
      <table className="mt">
        <thead>
          <tr>
            <th>项</th>
            <th>结果</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, ok, detail]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{ok ? <Tag tone="ok">ok</Tag> : <Tag tone="bad">fail</Tag>}</td>
              <td className="mini">{detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mini mt">available=false 的模型不进 run；OpenCode Go 请求自动带 x-opencode-session 与 User-Agent: rionext/x。</div>
    </>
  );
}
