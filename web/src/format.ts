export const pct = (a: number, b: number): number => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);

export const fmtM = (n: number): string => `${(n / 1e6).toFixed(1)}M`;

export const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(0)}K` : String(n));

export const fmtNum = (n: number): string => n.toLocaleString("en-US");

export function trunc(s: unknown, n: number): string {
  const text = String(s ?? "");
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)}G`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)}M`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)}K`;
  return `${n}B`;
}

/** "web" | "reverse/apk" | "assessment" | "synthetic" label for a campaign. */
export function kindLabel(spec: { mode: string; challenge: { kind?: string; overlay?: string | null } | null; assets: string[] }): string {
  if (spec.challenge?.kind) return spec.challenge.kind + (spec.challenge.overlay ? `/${spec.challenge.overlay}` : "");
  if (spec.mode === "assessment") return "assessment";
  if (spec.assets.some((a) => /^https?:\/\//i.test(a))) return "web";
  return "synthetic";
}

export function targetLabel(spec: { statement: string; assets: string[]; challenge: { kind?: string } | null }): string {
  return spec.assets[0] ?? spec.statement ?? "";
}
