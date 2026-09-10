/**
 * Manager reaction: one LLM call after the platform rejects a flag. It is an
 * advisor, not a fifth solver — no tools, one JSON reply. Thinking is on at
 * max level with a 32768-token call cap (the protocol layer splits that into
 * up to 16384 thinking + 16384 reply). When no manager slot is explicitly
 * assigned we skip the call entirely (the deterministic reject hint from
 * rejectGoalClaim still drives the resume); we never fall back to the solver
 * slot for this.
 */
import { ProviderCatalog } from "../provider/catalog.ts";
import { postJson, type FetchFn } from "../provider/client.ts";
import { resolveSlot } from "../provider/router.ts";
import { buildProtocolBody, extractText } from "../provider/transform.ts";

export interface ManagerInput {
  question: { id: string; title: string; category: string; interactive: boolean };
  rejectedFlag: string;
  platformMessage: string;
  attempt: number;
  maxAttempts: number;
  state: string;
  connectionSummary: string;
  recentHints: string[];
}

export interface ManagerAdvice {
  hint: string;
  nextAction: "continue" | "reset_container" | "give_up";
  doNotResubmit: string[];
  diagnosis?: string;
  raw: string;
}

/** Only an explicit manager assignment counts — resolveSlot would silently
 *  fall back to solver, which we do not want for this call. */
export function hasManagerSlot(catalog: ProviderCatalog): boolean {
  return Boolean(catalog.slots().find((s) => s.slot === "manager")?.model_id);
}

/** Tolerant parse of the manager reply: first {...} block wins, else raw text. */
export function parseManagerAdvice(text: string): ManagerAdvice {
  const raw = text.trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as Record<string, unknown>;
      const hint = typeof j.hint === "string" && j.hint.trim() ? j.hint.trim() : raw.slice(0, 800);
      const na = String(j.next_action ?? j.nextAction ?? "").toLowerCase();
      const nextAction = na.includes("reset") ? "reset_container" : na.includes("give") ? "give_up" : "continue";
      const dnr = Array.isArray(j.do_not_resubmit)
        ? j.do_not_resubmit.filter((x): x is string => typeof x === "string")
        : [];
      const diagnosis = typeof j.diagnosis === "string" ? j.diagnosis : undefined;
      return { hint, nextAction, doNotResubmit: dnr, diagnosis, raw };
    } catch {
      // fall through to raw-text advice
    }
  }
  return {
    hint: raw.slice(0, 800) || "platform rejected the flag; change approach",
    nextAction: "continue",
    doNotResubmit: [],
    raw,
  };
}

function buildPrompt(input: ManagerInput): string {
  const parts = [
    "你是 CTF 竞赛督导的反应顾问。平台刚判定一次 flag 提交错误。只做诊断，不解题。",
    "严格输出一个 JSON 对象，不要输出其他内容：",
    `{"diagnosis":"wrong_value|format|partial|env_stale|wrong_direction",` +
      `"do_not_resubmit":["不要再提交的值"],` +
      `"next_action":"continue_explore|reset_container|try_format_wrap|give_up_slot",` +
      `"hint":"给解题模型的一小段中文指引（≤120字）：为什么错、下一步别做什么"}`,
    "",
    `题目: ${input.question.title}（${input.question.category}${input.question.interactive ? "，容器题" : ""}）`,
    `被拒的 flag: ${input.rejectedFlag}`,
    `平台返回: ${input.platformMessage || "（空）"}`,
    `这是第 ${input.attempt}/${input.maxAttempts} 次错答`,
    `战役状态: ${input.state}`,
    `连接信息: ${input.connectionSummary || "无"}`,
  ];
  if (input.recentHints.length) {
    parts.push(`最近的提示:\n${input.recentHints.map((h) => `- ${h.slice(0, 200)}`).join("\n")}`);
  }
  return parts.join("\n");
}

export async function managerReaction(
  catalog: ProviderCatalog,
  input: ManagerInput,
  opts?: { fetchFn?: FetchFn; timeoutMs?: number },
): Promise<ManagerAdvice | null> {
  try {
    if (!hasManagerSlot(catalog)) return null;
    const route = resolveSlot(catalog, "manager");
    const apiKey = catalog.apiKey(route.provider.id);
    if (!apiKey) return null;
    const res = await postJson({
      url: route.provider.base_url,
      protocol: route.provider.protocol,
      apiKey,
      body: buildProtocolBody(route.provider.protocol, {
        model: route.model.name,
        max_tokens: 32768,
        user: buildPrompt(input),
        thinking: "on",
        thinking_level: "max",
      }),
      fetchFn: opts?.fetchFn,
      timeoutMs: opts?.timeoutMs ?? 60_000,
    });
    if (!res.ok) return null;
    const text = extractText(route.provider.protocol, res.json);
    if (!text.trim()) return null;
    return parseManagerAdvice(text);
  } catch {
    return null;
  }
}
