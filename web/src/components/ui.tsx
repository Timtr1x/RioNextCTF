import { useState, type ReactNode } from "react";
import { useStore } from "../store";
import { pct } from "../format";

export function Badge({ state }: { state: string }): JSX.Element {
  return <span className={`badge b-${state}`}>{state}</span>;
}

export function Tag({ tone, children }: { tone?: "ok" | "warn" | "bad"; children: ReactNode }): JSX.Element {
  return <span className={`tag ${tone ?? ""}`}>{children}</span>;
}

export function Gauge({ value, max, tone }: { value: number; max: number; tone?: "t" }): JSX.Element {
  return (
    <div className="gauge">
      <div className="bar2">
        <i className={tone ?? ""} style={{ width: `${pct(value, max)}%` }} />
      </div>
    </div>
  );
}

export function KV({ k, children }: { k: string; children: ReactNode }): JSX.Element {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

export function Donut({ done, total }: { done: number; total: number }): JSX.Element {
  const angle = total ? Math.round((done / total) * 360) : 360;
  return (
    <div className="donut" style={{ background: `conic-gradient(var(--accent) ${angle}deg,#efece3 0)` }}>
      <b>{total ? Math.round((done / total) * 100) : 100}%</b>
    </div>
  );
}

export function LogBox({ text, placeholder }: { text: string; placeholder?: string }): JSX.Element {
  const lines = (text || placeholder || "").split("\n");
  return (
    <div className="logbox">
      {lines.map((l, i) => (
        <div key={i} className={/error|failed|err/i.test(l) ? "err" : /ok|done|finished/i.test(l) ? "ok" : ""}>
          {l}
        </div>
      ))}
    </div>
  );
}

/** Button that runs an async action: disables while busy, toasts CLI-equivalent on success, error toast on failure. */
export function ActionButton({
  label,
  cli,
  cap,
  className,
  confirm,
  onRun,
  onDone,
}: {
  label: ReactNode;
  cli: string;
  cap?: string;
  className?: string;
  confirm?: string;
  onRun: () => Promise<unknown>;
  onDone?: (result: unknown) => void;
}): JSX.Element {
  const { toast, toastError } = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className ?? "ghost sm"}
      disabled={busy}
      onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        try {
          const result = await onRun();
          toast(cli, cap);
          onDone?.(result);
        } catch (err) {
          toastError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}

export function ToastHost(): JSX.Element | null {
  const { toastState, hideToast } = useStore();
  if (!toastState) return null;
  return (
    <div className={`toast ${toastState.isError ? "err" : ""}`}>
      <div className="cap">
        <span>{toastState.cap}</span>
        <span>
          <span style={{ cursor: "pointer", marginRight: 10 }} onClick={() => void navigator.clipboard?.writeText(toastState.cmd)}>
            复制
          </span>
          <span style={{ cursor: "pointer" }} onClick={hideToast}>
            ✕
          </span>
        </span>
      </div>
      <pre>{toastState.cmd}</pre>
    </div>
  );
}

export function ModalHost(): JSX.Element | null {
  const { modal, closeModal } = useStore();
  if (!modal) return null;
  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div className="modal">
        <span className="close" onClick={closeModal}>
          ✕
        </span>
        {modal}
      </div>
    </div>
  );
}

export function ErrorLine({ error }: { error: Error | undefined }): JSX.Element | null {
  if (!error) return null;
  return (
    <div className="mini" style={{ color: "var(--red)" }}>
      {error.message}
    </div>
  );
}
