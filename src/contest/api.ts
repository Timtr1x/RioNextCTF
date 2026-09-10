/**
 * Contest platform client (i春秋 AI 解题赛). Three HTTPS GET endpoints, params in
 * the query string, HTTP status is almost always 200 — business verdicts live in
 * the JSON envelope (code/message/status). Parsing is deliberately loose: extra
 * keys are kept in `raw`, missing keys get defaults, one malformed row never
 * kills a poll. The token and submitted flags are never written to logs.
 *
 * Measured facts (2026-09-10, against the live platform):
 * - curl's default UA is blocked by the Knownsec WAF (403 HTML, __jsluid_s);
 *   a browser UA passes. WAF pages are infra failures, never wrong-flag verdicts.
 * - Only query params count; extra params are ignored; `answer` is the submit key.
 * - Rate limiting answers code 101 「对不起，您的操作太过频繁！」 after bursts and
 *   recovers in ~40s. All observed business errors are code 101.
 */

export interface ContestConnection {
  docker_url?: string;
  docker_ip?: string;
  docker_port?: string;
}

export interface ContestQuestion {
  question_id: string;
  title: string;
  category: string;
  description: string;
  score: number | null;
  real_score: number | null;
  solved_number: number | null;
  is_solved: boolean;
  interactive: boolean;
  file_url: string | null;
  attributes: string[];
  capabilities: string[];
  connection: ContestConnection | null;
  raw: Record<string, unknown>;
}

export type SubmitVerdict =
  | { kind: "correct"; message: string }
  | { kind: "wrong"; message: string; raw: string }
  /** Platform asked us to slow down. Not a wrong answer; retry after backoff. */
  | { kind: "rate_limited"; message: string }
  /** Platform/config problem (missing param, unknown team, miss route...). Not a
   *  wrong answer either — the claim must not be rejected on this. */
  | { kind: "blocked"; message: string };

export type ContestErrorKind = "auth" | "rate" | "infra" | "unknown";

export class ContestApiError extends Error {
  constructor(
    readonly kind: ContestErrorKind,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ContestApiError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Chrome UA: the platform sits behind Knownsec WAF, which 403s curl's default UA. */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const DEFAULT_BASE = "https://apiterminator.ichunqiu.com";
const DEFAULT_PATHS = {
  list: "/04cb510e425bd8f64fa97ba66f3935e1",
  reset: "/deed3dba39e57b7cf95ea63ddd84e0c8",
  submit: "/ff874ef3172cbf4fd6ec2c5653a568e2",
} as const;

type PathKey = keyof typeof DEFAULT_PATHS;

const KNOWN_QUESTION_KEYS = new Set([
  "question_id",
  "title",
  "score",
  "real_score",
  "file_url",
  "is_solved",
  "solved_number",
  "category",
  "attributes",
  "description",
  "interactive",
  "capabilities",
  "connection",
  "extensions",
]);

/** Messages the platform uses for things that are NOT a wrong answer. */
function errorKind(message: string): ContestErrorKind {
  if (/频繁|too frequent|rate.?limit/i.test(message)) return "rate";
  if (/缺少参数|暂无队伍信息|比赛ID错误|miss route|内容不能为空|未登录|授权|鉴权|unauthorized|forbidden/i.test(message)) {
    return "auth";
  }
  return "unknown";
}

function toStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function toBool(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
  return false;
}

function toStrList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => toStr(x) ?? "").filter((x) => x !== "");
}

function toConnection(v: unknown): ContestConnection | null {
  let obj: unknown = v;
  if (Array.isArray(obj)) obj = obj.find((x) => x && typeof x === "object");
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;
  const out: ContestConnection = {};
  const url = toStr(r.docker_url);
  const ip = toStr(r.docker_ip);
  const port = toStr(r.docker_port);
  if (url !== undefined) out.docker_url = url;
  if (ip !== undefined) out.docker_ip = ip;
  if (port !== undefined) out.docker_port = port;
  return url === undefined && ip === undefined && port === undefined ? null : out;
}

function toQuestion(row: unknown, noteUnknown: (key: string) => void): ContestQuestion | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const qid = toStr(r.question_id);
  if (!qid) return null;
  for (const k of Object.keys(r)) if (!KNOWN_QUESTION_KEYS.has(k)) noteUnknown(k);
  return {
    question_id: qid,
    title: toStr(r.title) ?? "",
    category: (toStr(r.category) ?? "generic").toLowerCase(),
    description: toStr(r.description) ?? "",
    score: toNum(r.score),
    real_score: toNum(r.real_score),
    solved_number: toNum(r.solved_number),
    is_solved: toBool(r.is_solved),
    interactive: toBool(r.interactive),
    file_url: (toStr(r.file_url) ?? "").trim() || null,
    attributes: toStrList(r.attributes),
    capabilities: toStrList(r.capabilities),
    connection: toConnection(r.connection),
    raw: r,
  };
}

function safeJson(json: Record<string, unknown>): string {
  try {
    return JSON.stringify(json).slice(0, 300);
  } catch {
    return "[unserializable]";
  }
}

export interface ContestApiOptions {
  token: string;
  baseUrl?: string;
  paths?: Partial<Record<PathKey, string>>;
  /** Submit answer query key. Measured correct as `answer`; overridable in case
   *  the production platform renames it. */
  answerParam?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  onLog?: (line: string) => void;
  headers?: Record<string, string>;
}

export class ContestApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly paths: Record<PathKey, string>;
  private readonly answerParam: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onLog: (line: string) => void;
  private readonly headers: Record<string, string>;
  private readonly unknownKeys = new Set<string>();

  constructor(opts: ContestApiOptions) {
    const env = process.env;
    this.token = opts.token.trim();
    if (!this.token) throw new Error("contest token is empty");
    this.baseUrl = opts.baseUrl ?? env.RIONEXT_CONTEST_BASE ?? DEFAULT_BASE;
    this.paths = {
      list: opts.paths?.list ?? env.RIONEXT_CONTEST_LIST_PATH ?? DEFAULT_PATHS.list,
      reset: opts.paths?.reset ?? env.RIONEXT_CONTEST_RESET_PATH ?? DEFAULT_PATHS.reset,
      submit: opts.paths?.submit ?? env.RIONEXT_CONTEST_SUBMIT_PATH ?? DEFAULT_PATHS.submit,
    };
    this.answerParam = opts.answerParam ?? env.RIONEXT_CONTEST_ANSWER_PARAM ?? "answer";
    this.fetchFn = opts.fetchFn ?? (fetch as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 4;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onLog = opts.onLog ?? (() => {});
    this.headers = { "user-agent": BROWSER_UA, accept: "application/json,*/*", ...opts.headers };
  }

  private noteUnknownKey(key: string): void {
    if (this.unknownKeys.has(key)) return;
    this.unknownKeys.add(key);
    this.onLog(`contest api: unknown question field "${key}" tolerated (kept in raw)`);
  }

  private async backoff(attempt: number, attempts: number): Promise<void> {
    if (attempt < attempts) await this.sleep(Math.min(1500 * attempt, 10_000));
  }

  /** GET one envelope. Retries infra failures (network, 429/5xx, WAF HTML). */
  private async getJson(pathKey: PathKey, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(this.paths[pathKey], this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const attempts = Math.max(1, this.retries);
    let last = "unknown";
    for (let i = 1; i <= attempts; i++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
          const res = await this.fetchFn(url.toString(), { headers: this.headers, signal: ctrl.signal });
          const text = await res.text();
          if (res.status === 429 || res.status >= 500) {
            last = `HTTP ${res.status}`;
            await this.backoff(i, attempts);
            continue;
          }
          if (!/^\s*\{/.test(text)) {
            // Knownsec CloudWAF 403 HTML and friends — infra, not a verdict.
            last = `non-JSON response (HTTP ${res.status}, ${text.length}b)`;
            await this.backoff(i, attempts);
            continue;
          }
          const json = JSON.parse(text) as unknown;
          if (!json || typeof json !== "object" || Array.isArray(json)) {
            throw new ContestApiError("infra", -1, "unexpected response envelope");
          }
          return json as Record<string, unknown>;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (err instanceof ContestApiError) throw err;
        last = err instanceof Error ? err.message : String(err);
        await this.backoff(i, attempts);
      }
    }
    throw new ContestApiError("infra", -1, `${pathKey} request failed after ${attempts} attempts: ${last}`);
  }

  async listQuestions(): Promise<ContestQuestion[]> {
    const json = await this.getJson("list", { token: this.token });
    const code = toNum(json.code) ?? -1;
    const message = toStr(json.message) ?? "";
    if (code !== 0) throw new ContestApiError(errorKind(message), code, message || `code ${code}`);
    const data = Array.isArray(json.data) ? json.data : [];
    const out: ContestQuestion[] = [];
    for (const row of data) {
      const q = toQuestion(row, (k) => this.noteUnknownKey(k));
      if (q) out.push(q);
    }
    return out;
  }

  async submitFlag(questionId: string, flag: string): Promise<SubmitVerdict> {
    const json = await this.getJson("submit", {
      token: this.token,
      question_id: questionId,
      [this.answerParam]: flag,
    });
    const code = toNum(json.code) ?? -1;
    const message = toStr(json.message) ?? "";
    const status = toNum(json.status);
    const raw = safeJson(json);
    if (code === 0 && (status === 1 || /正确|correct/i.test(message))) return { kind: "correct", message };
    if (code !== 0) {
      const kind = errorKind(message);
      if (kind === "rate") return { kind: "rate_limited", message };
      if (kind === "auth") return { kind: "blocked", message };
      return { kind: "wrong", message, raw };
    }
    // code 0 without an explicit success signal: ambiguous, treat as not accepted.
    return { kind: "wrong", message: message || `ambiguous success envelope: ${raw}`, raw };
  }

  async resetQuestion(questionId: string): Promise<{ ok: boolean; message: string; rateLimited: boolean }> {
    const json = await this.getJson("reset", { token: this.token, question_id: questionId });
    const code = toNum(json.code) ?? -1;
    const message = toStr(json.message) ?? "";
    if (code === 0) return { ok: true, message, rateLimited: false };
    return { ok: false, message: message || `code ${code}`, rateLimited: errorKind(message) === "rate" };
  }
}
