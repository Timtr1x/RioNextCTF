import type { Protocol } from "./types.ts";

export const PROTOCOL_PATH: Record<Protocol, string> = {
  OPENAI_CHAT_COMPLETIONS: "/v1/chat/completions",
  OPENAI_RESPONSES: "/v1/responses",
  ANTHROPIC_MESSAGES: "/v1/messages",
};

export function completeBaseUrl(raw: string, protocol: Protocol): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("接口地址不能为空");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`无效接口地址: ${raw}`);
  }
  const want = PROTOCOL_PATH[protocol];
  const path = url.pathname.replace(/\/+$/, "") || "";
  if (path.endsWith(want) || path.endsWith(want.replace(/\/+$/, ""))) {
    return `${url.origin}${path}`;
  }
  const leaf = want.split("/").filter(Boolean).slice(-2).join("/");
  if (leaf && path.endsWith(`/${leaf}`)) {
    return `${url.origin}${path}`;
  }
  if (path === "" || path === "/" || path === "/v1") {
    return `${url.origin}${want}`;
  }
  // Qianfan v2 (generic and Token Plan personal/team) is OpenAI-compat under /v2, not /v1.
  if (protocol === "OPENAI_CHAT_COMPLETIONS" && (path === "/v2" || path.startsWith("/v2/"))) {
    return `${url.origin}${path}/chat/completions`;
  }
  if (path.endsWith("/v1")) {
    return `${url.origin}${path}${want.slice("/v1".length)}`;
  }
  return `${url.origin}${path}${want}`;
}
