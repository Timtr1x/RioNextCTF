/**
 * Pure contest-planning functions: mock filtering, category mapping, easy-first
 * ranking, launch-plan selection, flag extraction, campaign id derivation.
 * No IO, no models — everything here is unit-tested deterministically.
 *
 * Selection is deliberately NOT an LLM task: the board changes under you, mock
 * questions appear first, and a deterministic sort fills four slots from one GET.
 */
import type { TcpEndpoint } from "../domain/challenge-kind.ts";
import { looksLikeHttpUrl } from "../domain/quick-spec.ts";
import type { ContestConnection, ContestQuestion } from "./api.ts";

export type ContestMode = "test" | "official";

const MOCK_RE = /测试|test|mock|sample|样例|练习/i;
/** A whole description that is nothing but a mock marker, e.g. "test" or "样例". */
const MOCK_DESCRIPTION_RE = /^\s*(?:测试|test|mock|sample|样例|练习)[\s_\-—:：]*$/i;

/**
 * Mock questions are labelled in the title or attributes. Descriptions are
 * prose and routinely use 测试/test as an ordinary verb — a real question here
 * read "请测试这个文件管理系统是否存在安全问题" — so a description only counts
 * when the whole string is a mock marker. Treating a real question as mock
 * silently forfeits its points, which is the expensive mistake.
 */
export function isMockQuestion(q: ContestQuestion): boolean {
  if (MOCK_RE.test(q.title)) return true;
  if (q.attributes.some((a) => MOCK_RE.test(a))) return true;
  return MOCK_DESCRIPTION_RE.test(q.description);
}

export type ContestKind = "web" | "reverse" | "pwn" | "misc" | "crypto" | "generic";

export function kindForCategory(category: string): ContestKind {
  const c = category.toLowerCase().trim();
  if (c.includes("web")) return "web";
  if (c.includes("pwn") || c.includes("bin")) return "pwn";
  if (c === "re" || c.includes("reverse") || c.includes("逆向")) return "reverse";
  if (c.includes("crypto") || c.includes("密码")) return "crypto";
  if (c.includes("misc") || c.includes("杂")) return "misc";
  return "generic";
}

function toPort(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** tcp endpoint for pwn-style questions: explicit ip/port fields or `nc h p`. */
export function endpointFor(conn: ContestConnection | null): TcpEndpoint | null {
  if (!conn) return null;
  const ip = conn.docker_ip?.trim();
  const port = toPort(conn.docker_port);
  if (ip && port) return { host: ip, port };
  const m = conn.docker_url?.trim().match(/^nc\s+([A-Za-z0-9.-]+)\s+(\d{1,5})\s*$/i);
  if (m) {
    const p = toPort(m[2]);
    if (p) return { host: m[1]!, port: p };
  }
  return null;
}

/** http entrypoint for web containers: `host:80`, `host:8080`, or a full URL. */
export function webUrlFor(conn: ContestConnection | null): string | null {
  const raw = conn?.docker_url?.trim();
  if (!raw || /^nc\s/i.test(raw)) return null;
  if (looksLikeHttpUrl(raw)) return raw;
  const m = raw.match(/^([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/);
  if (!m) return null;
  const port = m[2] && m[2] !== "80" ? `:${m[2]}` : "";
  return `http://${m[1]}${port}/`;
}

export type LaunchPlan =
  | { type: "url"; url: string }
  | {
      type: "input";
      /** Platform-category override for high-precision kinds only; misc/generic
       *  stays with the deterministic classifier so overlays (pcap/stego/...)
       *  survive. */
      kind?: "reverse" | "pwn" | "crypto";
      endpoint: TcpEndpoint | null;
      fileUrl: string | null;
      /** Live web app paired with the attachment (web questions that hand out
       *  source). Null for attachment-only and pure-tcp plans. */
      webUrl: string | null;
    }
  | { type: "blocked"; reason: string };

export function planFor(q: ContestQuestion): LaunchPlan {
  const cat = kindForCategory(q.category);
  const fileUrl = q.file_url && q.file_url.trim() ? q.file_url.trim() : null;
  if (cat === "web") {
    const url = webUrlFor(q.connection);
    // Web with only a container stays a pure web campaign; web that also hands
    // out source becomes an input campaign whose spec carries the live URL.
    if (url && !fileUrl) return { type: "url", url };
    if (url && fileUrl) return { type: "input", kind: undefined, endpoint: null, fileUrl, webUrl: url };
  }
  const endpoint = endpointFor(q.connection);
  const webUrl = cat === "web" ? null : webUrlFor(q.connection);
  const kind = cat === "pwn" || cat === "reverse" || cat === "crypto" ? cat : undefined;
  if (endpoint || fileUrl) return { type: "input", kind, endpoint, fileUrl, webUrl };
  if (q.description.trim()) return { type: "input", kind, endpoint: null, fileUrl: null, webUrl };
  return { type: "blocked", reason: "no url, attachment, endpoint or description" };
}

/**
 * Easy-first layers: static web/misc/crypto, then container web, then misc/crypto
 * with attachments, then everything else (pwn/reverse/binary). Inside a layer:
 * real_score ascending (easy = cheap), solved_number descending (easy = popular).
 */
export function rankLayer(q: ContestQuestion): number {
  const cat = kindForCategory(q.category);
  const hasConn = Boolean(q.connection && (q.connection.docker_url || q.connection.docker_ip));
  const hasFile = Boolean(q.file_url);
  if (!q.interactive && !hasConn && !hasFile && (cat === "web" || cat === "misc" || cat === "crypto")) return 1;
  if (cat === "web" && hasConn) return 2;
  if ((cat === "misc" || cat === "crypto") && hasFile) return 3;
  return 4;
}

export function rankQuestions(qs: ContestQuestion[]): ContestQuestion[] {
  return [...qs].sort((a, b) => {
    const layer = rankLayer(a) - rankLayer(b);
    if (layer !== 0) return layer;
    const sa = a.real_score ?? a.score ?? 9999;
    const sb = b.real_score ?? b.score ?? 9999;
    if (sa !== sb) return sa - sb;
    return (b.solved_number ?? 0) - (a.solved_number ?? 0);
  });
}

const FLAG_RE = /[A-Za-z0-9_]*(?:flag|ctf)[A-Za-z0-9_]*\{[^{}\r\n]{1,256}\}/i;

/**
 * Pull the submittable value out of a flag_recovered proposition. Prefers a
 * `something{...}` flag pattern; falls back to the whole proposition when it is
 * a single token; returns null when the claim is prose (submitting it would
 * waste a rate-limited platform call).
 */
export function extractFlag(proposition: string): string | null {
  const m = proposition.match(FLAG_RE);
  if (m) return m[0];
  const t = proposition.trim();
  if (t.length > 0 && t.length <= 512 && !/\s/.test(t)) return t;
  return null;
}

export function campaignIdFor(q: ContestQuestion): string {
  const clean = q.question_id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `camp_q_${clean || "x"}`.slice(0, 48);
}

/** Fingerprint of the connection triple, for change detection across polls. */
export function connectionKey(q: ContestQuestion): string {
  const c = q.connection;
  return c ? `${c.docker_url ?? ""}|${c.docker_ip ?? ""}|${c.docker_port ?? ""}` : "";
}

/** Scope assets/entries matching the question's current connection. Mixed
 *  questions (live app + attachment, or tcp service + web panel) report every
 *  entrypoint so a mid-contest endpoint move never drops one. */
export function scopeFor(q: ContestQuestion): { assets: string[]; entries: string[] } {
  const assets: string[] = [];
  const entries: string[] = [];
  const url = webUrlFor(q.connection);
  if (url) {
    assets.push(new URL(url).hostname, url);
    entries.push(url);
  }
  const ep = endpointFor(q.connection);
  if (ep) {
    assets.push(`${ep.host}:${ep.port}`);
    entries.push(`tcp://${ep.host}:${ep.port}`);
  }
  return { assets, entries };
}
