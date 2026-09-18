import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
  createScriptedAbortStream,
  createScriptedErrorStream,
  createTextStream,
} from "../runtime/pi/scripted-stream.ts";
import type { ProviderCatalog } from "./catalog.ts";
import { postJson, type FetchFn } from "./client.ts";
import { buildProtocolBody, extractText, extractToolCalls, extractUsage, type CommonTool, type ProtocolMessage } from "./transform.ts";
import { OUTPUT_DEFAULT, STREAM_TIMEOUT_DEFAULT_MS } from "./types.ts";
import { createToolStream } from "../runtime/pi/scripted-stream.ts";

export interface CataloguedStreamStats {
  attempts: number;
  /** Why the last attempt failed, e.g. "http_500" or a network error message.
   *  Null while the stream has not failed. Persisted by the engine so a dead
   *  run can be diagnosed without re-running it. */
  lastError: string | null;
}

export interface CataloguedStreamOpts {
  catalog: ProviderCatalog;
  providerId: string;
  modelName: string;
  fetchFn: FetchFn;
  maxRetries?: number;
  timeoutMs?: number;
  apiKey?: string;
  sessionId?: string | (() => string);
  /** Backoff before retry attempt n (1-based). Defaults to 1s, 2s, 4s capped. */
  retryDelayMs?: (attempt: number) => number;
}

/**
 * Transient upstream failures are worth another try; a 400/401/403/404/422 is
 * a settled answer about the request, so retrying only wastes time.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 4000);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamThinkingLevel(reasoning: unknown): "low" | "high" | "max" {
  if (reasoning === "low" || reasoning === "high" || reasoning === "max") return reasoning;
  return "high";
}

function campaignMaxTokens(opts: CataloguedStreamOpts, requested?: number): number {
  if (typeof requested === "number" && requested > 0) return requested;
  const rec = opts.catalog.listModels(opts.providerId).find((m) => m.name === opts.modelName);
  return rec?.max_output_tokens ?? OUTPUT_DEFAULT;
}

function userText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
        .join("");
      if (text) return text;
    }
  }
  return "";
}

function contextTools(context: Context): CommonTool[] {
  return (context.tools ?? []).map((t) => ({
    name: t.name,
    description: ("description" in t && typeof t.description === "string" ? t.description : t.name) as string,
    parameters: (t.parameters && typeof t.parameters === "object" ? (t.parameters as Record<string, unknown>) : { type: "object", properties: {} }),
  }));
}

function contextMessages(context: Context): ProtocolMessage[] {
  const out: ProtocolMessage[] = [];
  for (const m of context.messages) {
    if (m.role === "user") {
      const content =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("")
            : "";
      out.push({ role: "user", content });
      continue;
    }
    if (m.role === "assistant") {
      const calls = (Array.isArray(m.content) ? m.content : [])
        .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "toolCall")
        .map((c) => {
          const call = c as { id?: string; name?: string; arguments?: unknown };
          return { id: String(call.id ?? ""), name: String(call.name ?? ""), arguments: call.arguments ?? {} };
        })
        .filter((c) => c.name);
      const text = (Array.isArray(m.content) ? m.content : [])
        .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
        .join("");
      out.push({ role: "assistant", content: text || null, tool_calls: calls.length ? calls : undefined });
      continue;
    }
    if (m.role === "toolResult") {
      const text = (m.content ?? []).map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("");
      out.push({ role: "tool", content: text, tool_call_id: m.toolCallId, name: m.toolName });
    }
  }
  return out;
}

function resolveSessionId(opts: CataloguedStreamOpts): string {
  const raw = typeof opts.sessionId === "function" ? opts.sessionId() : opts.sessionId;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `rionext-stream-${opts.providerId}`;
}

export function createCataloguedProviderStream(opts: CataloguedStreamOpts): {
  stream: StreamFn;
  stats: CataloguedStreamStats;
} {
  const stats: CataloguedStreamStats = { attempts: 0, lastError: null };
  const maxRetries = Math.max(0, opts.maxRetries ?? 0);
  const retryDelayMs = opts.retryDelayMs ?? defaultRetryDelayMs;
  const stream: StreamFn = (model: Model<string>, context: Context, options) => {
    return (async () => {
      if (options?.signal?.aborted) {
        return createScriptedAbortStream(model, "cancelled");
      }
      const provider = opts.catalog.getProvider(opts.providerId);
      const key = opts.apiKey ?? opts.catalog.apiKey(opts.providerId) ?? "catalogued-no-live-key";
      const tools = contextTools(context);
      const finalize = tools.length === 1 && tools[0]?.name === "finish_step";
      const thinking_level = finalize ? "low" : streamThinkingLevel(options?.reasoning);
      const body = buildProtocolBody(provider.protocol, {
        model: opts.modelName,
        system: context.systemPrompt,
        user: userText(context),
        messages: contextMessages(context),
        tools,
        max_tokens: finalize ? Math.max(1, options?.maxTokens ?? 12800) : campaignMaxTokens(opts, options?.maxTokens),
        thinking: finalize ? "off" : "on",
        thinking_level,
        force_tool: finalize ? "finish_step" : undefined,
      });
      const cap = Math.min(maxRetries, options?.maxRetries ?? maxRetries);
      let lastErr = "provider_error";
      for (let i = 0; i <= cap; i++) {
        if (options?.signal?.aborted) {
          return createScriptedAbortStream(model, "cancelled");
        }
        if (i > 0) await sleep(retryDelayMs(i));
        stats.attempts += 1;
        try {
          const res = await postJson({
            url: provider.base_url,
            protocol: provider.protocol,
            apiKey: key,
            body,
            fetchFn: opts.fetchFn,
            timeoutMs: opts.timeoutMs ?? options?.timeoutMs ?? STREAM_TIMEOUT_DEFAULT_MS,
            signal: options?.signal,
            sessionId: resolveSessionId(opts),
          });
          if (res.ok) {
            const usage = extractUsage(res.json);
            const calls = extractToolCalls(provider.protocol, res.json);
            if (calls.length) {
              return createToolStream(model, calls, "toolUse", usage);
            }
            const text = extractText(provider.protocol, res.json);
            return createTextStream(model, text || "ok", usage);
          }
          lastErr = `http_${res.status}`;
          if (!isRetryableStatus(res.status)) break;
        } catch (err) {
          const name = err instanceof Error ? err.name : "";
          const msg = err instanceof Error ? err.message : String(err);
          if (name === "AbortError" || /abort/i.test(msg)) {
            stats.lastError = msg;
            return createScriptedAbortStream(model, options?.signal?.aborted ? "cancelled" : "timeout");
          }
          lastErr = msg;
        }
      }
      stats.lastError = lastErr;
      return createScriptedErrorStream(model, lastErr);
    })();
  };
  return { stream, stats };
}
