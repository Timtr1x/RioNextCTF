import { useState } from "react";
import { api } from "../api/client";
import { useStore } from "../store";
import { ActionButton } from "./ui";

/** reject --text [--continue] form, shared by the detail banner and the review queue. */
export function RejectForm({ id, proposition, onDone }: { id: string; proposition?: string; onDone?: () => void }): JSX.Element {
  const { toast, toastError, closeModal } = useStore();
  const [text, setText] = useState("");
  const [cont, setCont] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h2>驳回 flag</h2>
      <div className="mini">原因写进上下文；驳回后战役回 active，可勾选立即续跑。同一值不许再提。</div>
      {proposition ? <pre>{proposition}</pre> : null}
      <textarea rows={3} placeholder="这个 flag 不对，因为……" value={text} onChange={(e) => setText(e.target.value)} />
      <label className="mini mt" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={cont} onChange={(e) => setCont(e.target.checked)} style={{ width: "auto" }} />
        --continue（立刻再 start）
      </label>
      <button
        className="danger mt"
        disabled={busy || !text.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            await api.verify(id, { accept: false, text: text.trim(), continue: cont });
            toast(`rionext reject ${id} --text "${text.trim()}"${cont ? " --continue" : ""}`, "驳回并写回 hint");
            onDone?.();
            closeModal();
          } catch (err) {
            toastError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "提交驳回"}
      </button>
    </>
  );
}

/** hint --text form. */
export function HintForm({ id, onDone }: { id: string; onDone?: () => void }): JSX.Element {
  const { toast, toastError, closeModal } = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h2>注入 hint</h2>
      <div className="mini">写进战役上下文，下一次 Decide 能看到。</div>
      <textarea
        rows={3}
        placeholder="不要用容器 php 当 unserialize 预言机"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className="mt"
        disabled={busy || !text.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            await api.hint(id, text.trim());
            toast(`rionext hint ${id} --text "${text.trim()}"`, "记录 hint（epoch +1）");
            onDone?.();
            closeModal();
          } catch (err) {
            toastError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "记录 hint（epoch +1）"}
      </button>
    </>
  );
}

/** revise-budget form. */
export function BudgetForm({ id, onDone }: { id: string; onDone?: () => void }): JSX.Element {
  const { toast, toastError, closeModal } = useStore();
  const [calls, setCalls] = useState("");
  const [tokens, setTokens] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h2>revise-budget</h2>
      <div className="mini">追加预算上限；留空的维度不动。budget_paused 的战役追加后 resume 续跑。</div>
      <div className="frow">
        <label>--max-calls</label>
        <input type="number" placeholder="6000" value={calls} onChange={(e) => setCalls(e.target.value)} />
      </div>
      <div className="frow">
        <label>--max-tokens</label>
        <input type="number" placeholder="60000000" value={tokens} onChange={(e) => setTokens(e.target.value)} />
      </div>
      <button
        className="mt"
        disabled={busy || (!calls && !tokens)}
        onClick={async () => {
          setBusy(true);
          try {
            await api.reviseBudget(id, {
              ...(calls ? { max_calls: Number(calls) } : {}),
              ...(tokens ? { max_tokens: Number(tokens) } : {}),
            });
            const parts = [calls && `--max-calls ${calls}`, tokens && `--max-tokens ${tokens}`].filter(Boolean).join(" ");
            toast(`rionext revise-budget ${id} ${parts}`, "epoch +1");
            onDone?.();
            closeModal();
          } catch (err) {
            toastError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "提交"}
      </button>
    </>
  );
}

/** reconcile 不确定调用面板。 */
export function ReconcilePanel({ id, uncertain, onDone }: { id: string; uncertain: { id: string; purpose: string | null }[]; onDone?: () => void }): JSX.Element {
  return (
    <>
      <h2>reconcile 不确定调用</h2>
      {uncertain.length ? (
        uncertain.map((x) => (
          <div className="card" key={x.id}>
            <div className="kv">
              <span className="k">
                {x.id} · {x.purpose ?? "调用"}
              </span>
              <span style={{ color: "var(--red)" }}>uncertain</span>
            </div>
            <ActionSync id={id} invocation={x.id} onDone={onDone} />
          </div>
        ))
      ) : (
        <div className="mini">当前没有 uncertain invocation。</div>
      )}
      <div className="mini mt">不带 --invocation 则全量核对：rionext reconcile {id}</div>
      <AllReconcile id={id} onDone={onDone} />
    </>
  );
}

function ActionSync({ id, invocation, onDone }: { id: string; invocation: string; onDone?: () => void }): JSX.Element {
  return (
    <ActionButton
      label="reconcile 该条"
      cli={`rionext reconcile ${id} --invocation ${invocation}`}
      onRun={() => api.reconcile(id, invocation)}
      onDone={onDone}
    />
  );
}

function AllReconcile({ id, onDone }: { id: string; onDone?: () => void }): JSX.Element {
  return (
    <div className="mt">
      <ActionButton label="全量 reconcile" cli={`rionext reconcile ${id}`} onRun={() => api.reconcile(id)} onDone={onDone} />
    </div>
  );
}
