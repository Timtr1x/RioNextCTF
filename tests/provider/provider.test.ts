import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeVisual, NonVisualModelError } from "../../src/provider/analyze-visual.ts";
import { inferVision, resolveVision } from "../../src/provider/capabilities.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";
import { completeBaseUrl } from "../../src/provider/paths.ts";
import { testConnection } from "../../src/provider/probe.ts";
import { resolveSlot, resolveVisionRoute } from "../../src/provider/router.ts";
import { createCataloguedProviderStream } from "../../src/provider/stream.ts";
import { postJson } from "../../src/provider/client.ts";
import {
  buildProtocolBody,
  extractToolCall,
  isOpencodeEndpoint,
  OPENCODE_SESSION_HEADER,
  requestHeaders,
  RIONEXT_USER_AGENT,
} from "../../src/provider/transform.ts";
import { OUTPUT_DEFAULT, STREAM_TIMEOUT_DEFAULT_MS } from "../../src/provider/types.ts";
import { SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";
import { generateVisionProbePng, VISION_PHRASE, visionPassed } from "../../src/provider/visual-runtime.ts";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "rn-prv-"));
}

test("baseUrl auto-completes protocol paths and does not double-append", () => {
  assert.equal(completeBaseUrl("https://api.openai.com", "OPENAI_CHAT_COMPLETIONS"), "https://api.openai.com/v1/chat/completions");
  assert.equal(completeBaseUrl("https://api.openai.com/v1", "OPENAI_CHAT_COMPLETIONS"), "https://api.openai.com/v1/chat/completions");
  assert.equal(
    completeBaseUrl("https://api.openai.com/v1/chat/completions", "OPENAI_CHAT_COMPLETIONS"),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(completeBaseUrl("https://api.anthropic.com", "ANTHROPIC_MESSAGES"), "https://api.anthropic.com/v1/messages");
  assert.equal(completeBaseUrl("https://api.openai.com/v1", "OPENAI_RESPONSES"), "https://api.openai.com/v1/responses");
  assert.equal(
    completeBaseUrl("https://qianfan.baidubce.com/v2", "OPENAI_CHAT_COMPLETIONS"),
    "https://qianfan.baidubce.com/v2/chat/completions",
  );
  assert.equal(
    completeBaseUrl("https://qianfan.baidubce.com/v2/chat/completions", "OPENAI_CHAT_COMPLETIONS"),
    "https://qianfan.baidubce.com/v2/chat/completions",
  );
  assert.equal(
    completeBaseUrl("https://qianfan.baidubce.com/v2/tokenplan/personal", "OPENAI_CHAT_COMPLETIONS"),
    "https://qianfan.baidubce.com/v2/tokenplan/personal/chat/completions",
  );
  assert.equal(
    completeBaseUrl("https://qianfan.baidubce.com/v2/tokenplan/team", "OPENAI_CHAT_COMPLETIONS"),
    "https://qianfan.baidubce.com/v2/tokenplan/team/chat/completions",
  );
  assert.equal(
    completeBaseUrl("https://qianfan.baidubce.com/v2/tokenplan/personal/chat/completions", "OPENAI_CHAT_COMPLETIONS"),
    "https://qianfan.baidubce.com/v2/tokenplan/personal/chat/completions",
  );
  assert.equal(
    completeBaseUrl("https://opencode.ai/zen/go/v1", "OPENAI_CHAT_COMPLETIONS"),
    "https://opencode.ai/zen/go/v1/chat/completions",
  );
  assert.equal(
    completeBaseUrl("https://opencode.ai/zen/go/v1/chat/completions", "OPENAI_CHAT_COMPLETIONS"),
    "https://opencode.ai/zen/go/v1/chat/completions",
  );
});

test("vision inferred from name and override wins", () => {
  assert.equal(inferVision("gpt-4o"), true);
  assert.equal(inferVision("claude-sonnet-4-6"), true);
  assert.equal(inferVision("qwen2.5-vl-72b"), true);
  assert.equal(inferVision("deepseek-v3"), false);
  assert.equal(resolveVision("deepseek-v3", true).vision, true);
  assert.equal(resolveVision("gpt-4o", false).vision, false);
});

test("visual-runtime PNG is a real PNG and phrase matcher works", () => {
  const png = generateVisionProbePng();
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(png.length > 100);
  assert.equal(visionPassed(`The code is ${VISION_PHRASE}.`), true);
  assert.equal(visionPassed("hello"), false);
});

test("Anthropic body uses system top-level, input_schema, tool_choice object, not OpenAI function tools", () => {
  const body = buildProtocolBody("ANTHROPIC_MESSAGES", {
    model: "claude-sonnet-4-6",
    system: "sys",
    user: "hi",
    max_tokens: 32,
    tools: [{ name: "echo_probe", description: "d", parameters: { type: "object", properties: {} } }],
    thinking: "adaptive",
  });
  assert.equal(body.system, "sys");
  assert.ok(!JSON.stringify(body.messages).includes('"role":"system"'));
  const tools = body.tools as { input_schema: unknown; name: string }[];
  assert.equal(tools[0]!.name, "echo_probe");
  assert.ok(tools[0]!.input_schema);
  assert.deepEqual(body.tool_choice, { type: "auto" });
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(JSON.stringify(body).includes('"type":"function"'), false);
});

test("Finalizer force_tool is required finish_step on OpenAI and Anthropic", () => {
  const tools = [{ name: "finish_step", description: "end fragment", parameters: { type: "object", properties: {} } }];
  const openai = buildProtocolBody("OPENAI_CHAT_COMPLETIONS", {
    model: "gpt-4o",
    user: "finish",
    max_tokens: 512,
    tools,
    thinking: "off",
    thinking_level: "low",
    force_tool: "finish_step",
  });
  assert.equal(openai.max_tokens, 512);
  assert.deepEqual(openai.tool_choice, { type: "function", function: { name: "finish_step" } });
  const anthropic = buildProtocolBody("ANTHROPIC_MESSAGES", {
    model: "claude-sonnet-4-6",
    user: "finish",
    max_tokens: 512,
    tools,
    thinking: "off",
    thinking_level: "low",
    force_tool: "finish_step",
  });
  assert.equal(anthropic.max_tokens, 512);
  assert.deepEqual(anthropic.tool_choice, { type: "tool", name: "finish_step" });
  const responses = buildProtocolBody("OPENAI_RESPONSES", {
    model: "gpt-5",
    user: "finish",
    max_tokens: 512,
    tools,
    thinking: "off",
    force_tool: "finish_step",
  });
  assert.equal(responses.max_output_tokens, 512);
  assert.deepEqual(responses.tool_choice, { type: "function", name: "finish_step" });
});

test("OpenAI chat uses function tools and reasoning_effort when thinking on", () => {
  const body = buildProtocolBody("OPENAI_CHAT_COMPLETIONS", {
    model: "gpt-4o",
    user: "hi",
    max_tokens: 16,
    tools: [{ name: "echo_probe", description: "d", parameters: { type: "object" } }],
    thinking: "on",
    thinking_level: "high",
  });
  assert.equal((body.tools as { type: string }[])[0]!.type, "function");
  assert.equal(body.reasoning_effort, "high");
});

test("OpenAI thinking_level high sends reasoning_effort high", () => {
  const body = buildProtocolBody("OPENAI_CHAT_COMPLETIONS", {
    model: "deepseek-v4-flash",
    user: "hi",
    max_tokens: 32,
    thinking_level: "high",
  });
  assert.equal(body.reasoning_effort, "high");
});

test("OpenAI thinking_level low/max map to low/high effort", () => {
  const lowBody = buildProtocolBody("OPENAI_CHAT_COMPLETIONS", {
    model: "deepseek-v4-flash",
    user: "hi",
    max_tokens: 32,
    thinking_level: "low",
  });
  assert.equal(lowBody.reasoning_effort, "low");
  // OpenAI 只有 low/medium/high 三档，没有 max；我们的 max 就是最高档 high。
  const maxBody = buildProtocolBody("OPENAI_CHAT_COMPLETIONS", {
    model: "deepseek-v4-flash",
    user: "hi",
    max_tokens: 32,
    thinking_level: "max",
  });
  assert.equal(maxBody.reasoning_effort, "high");
});

test("Anthropic thinking budget follows low/high/max caps", () => {
  const lowBody = buildProtocolBody("ANTHROPIC_MESSAGES", {
    model: "m",
    user: "hi",
    max_tokens: 51200,
    thinking: "on",
    thinking_level: "low",
  });
  assert.deepEqual(lowBody.thinking, { type: "enabled", budget_tokens: 8192 });
  const highBody = buildProtocolBody("ANTHROPIC_MESSAGES", {
    model: "m",
    user: "hi",
    max_tokens: 51200,
    thinking: "on",
    thinking_level: "high",
  });
  assert.deepEqual(highBody.thinking, { type: "enabled", budget_tokens: 16384 });
  const maxBody = buildProtocolBody("ANTHROPIC_MESSAGES", {
    model: "m",
    user: "hi",
    max_tokens: 51200,
    thinking: "on",
    thinking_level: "max",
  });
  assert.deepEqual(maxBody.thinking, { type: "enabled", budget_tokens: 25600 });
});

test("slot empty or unavailable falls back to solver then first available", () => {
  const cat = new ProviderCatalog(dir());
  const p = cat.addProvider({
    display_name: "lab",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://example.test",
    api_key: "sk-test",
  });
  const main = cat.addModel({ provider_id: p.id, name: "gpt-4o" });
  const side = cat.addModel({ provider_id: p.id, name: "deepseek-v3" });
  cat.assignSlot("solver", main.id);
  const r1 = resolveSlot(cat, "reflect");
  assert.equal(r1.model.id, main.id);
  assert.equal(r1.fallback_from, "slot_empty");
  cat.assignSlot("visual", side.id);
  cat.setModelAvailable(side.id, false);
  const r2 = resolveSlot(cat, "visual");
  assert.equal(r2.model.id, main.id);
  assert.equal(r2.fallback_from, "slot_unavailable");
});

test("analyze_visual rejects non-visual models", async () => {
  const cat = new ProviderCatalog(dir());
  const p = cat.addProvider({
    display_name: "lab",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://example.test/v1/chat/completions",
    api_key: "sk-test",
  });
  const textOnly = cat.addModel({ provider_id: p.id, name: "deepseek-v3", vision: false });
  cat.assignSlot("solver", textOnly.id);
  cat.assignSlot("visual", textOnly.id);
  await assert.rejects(
    () => analyzeVisual({ catalog: cat, prompt: "read", image_png_base64: "aaaa", fetchFn: async () => new Response("{}") }),
    (e: unknown) => e instanceof NonVisualModelError,
  );
});

test("connection test records auth text tools vision via mock fetch", async () => {
  const cat = new ProviderCatalog(dir());
  const p = cat.addProvider({
    display_name: "mock",
    protocol: "ANTHROPIC_MESSAGES",
    base_url: "https://api.anthropic.com",
    api_key: "sk-ant",
  });
  const m = cat.addModel({ provider_id: p.id, name: "claude-sonnet-4-6" });
  let sawFunctionTools = false;
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (JSON.stringify(body.tools ?? "").includes('"type":"function"')) sawFunctionTools = true;
    if (body.tools) {
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "echo_probe", input: { token: "ok" } }] }), { status: 200 });
    }
    if (JSON.stringify(body).includes("image")) {
      return new Response(JSON.stringify({ content: [{ type: "text", text: VISION_PHRASE }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: "pong" }] }), { status: 200 });
  };
  const report = await testConnection({ provider: p, model: m, apiKey: "sk-ant", fetchFn });
  assert.equal(report.auth.ok, true);
  assert.equal(report.text.ok, true);
  assert.equal(report.tools.ok, true);
  assert.equal(report.vision.ok, true);
  assert.equal(sawFunctionTools, false);
  assert.ok(report.variants.some((v) => v.name.includes("adaptive") || v.name.includes("enabled") || v.name === "auth"));
  const anthropicThinking = report.variants.filter((v) => v.name.includes("adaptive") || v.name.includes("enabled") || v.name.endsWith("off"));
  assert.ok(anthropicThinking.length >= 3);
});

test("OpenAI text probes are four thinking on/off groups", async () => {
  const cat = new ProviderCatalog(dir());
  const p = cat.addProvider({
    display_name: "oa",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://api.openai.com",
    api_key: "sk",
  });
  const m = cat.addModel({ provider_id: p.id, name: "gpt-4o-mini", vision: false });
  const names: string[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    names.push(`${body.reasoning_effort ? "on" : "off"}:${body.tools ? "tools" : "text"}`);
    if (body.tools) {
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "echo_probe" } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
  };
  const report = await testConnection({ provider: p, model: m, apiKey: "sk", fetchFn });
  assert.equal(report.text.ok, true);
  assert.equal(report.vision.ok, false);
  assert.ok(names.includes("on:text"));
  assert.ok(names.includes("off:text"));
  assert.ok(names.includes("on:tools"));
  assert.ok(names.includes("off:tools"));
});

test("reasoning probe records which levels a model accepts", async () => {
  const cat = new ProviderCatalog(dir());
  const p = cat.addProvider({
    display_name: "oa",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://api.openai.com",
    api_key: "sk",
  });
  const m = cat.addModel({ provider_id: p.id, name: "gpt-4o-mini", vision: false });
  const seen: string[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const effort = String(body.reasoning_effort ?? "");
    seen.push(effort);
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
  };
  const report = await testConnection({ provider: p, model: m, apiKey: "sk", fetchFn });
  // OpenAI 只有 low/high 两档 effort，我们的 max 映射到 high，所以只会看到 low 和 high。
  assert.ok(seen.includes("low"));
  assert.ok(seen.includes("high"));
  assert.ok(!seen.includes("max"));
  assert.equal(report.reasoning.ok, true);
  assert.ok(report.reasoning.detail.includes("low"));
  assert.ok(report.reasoning.detail.includes("high"));
});

test("Anthropic reasoning probe distinguishes low/high/max budgets", async () => {
  const cat = new ProviderCatalog(dir());
  const p = cat.addProvider({
    display_name: "ant",
    protocol: "ANTHROPIC_MESSAGES",
    base_url: "https://api.anthropic.com",
    api_key: "sk-ant",
  });
  const m = cat.addModel({ provider_id: p.id, name: "claude-x", vision: false });
  const budgets: number[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const thinking = body.thinking as { budget_tokens?: number } | undefined;
    budgets.push(Number(thinking?.budget_tokens ?? 0));
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "pong" }] }),
      { status: 200 },
    );
  };
  const report = await testConnection({ provider: p, model: m, apiKey: "sk-ant", fetchFn });
  // reasoning 探针是最后三个 thinking 请求（前面还有 auth/text/tools 的请求）。
  assert.deepEqual(budgets.slice(-3), [8192, 16384, 32768]);
  assert.equal(report.reasoning.ok, true);
  assert.ok(report.reasoning.detail.includes("supported low,high,max"));
});

test("P1 pause resume hint revise-budget explain-step", () => {
  const e = new Engine(makeRuntimeConfig(dir()), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec("p1-ctrl");
  e.createCampaign(spec);
  e.storage.setCampaignState(spec.campaign_id, "active", { kind: "user", id: "t" });
  e.pause(spec.campaign_id);
  assert.equal(e.storage.getCampaign(spec.campaign_id).state, "paused");
  e.resume(spec.campaign_id);
  assert.equal(e.storage.getCampaign(spec.campaign_id).state, "active");
  const epoch = e.hint(spec.campaign_id, "try the drawer");
  assert.ok(epoch >= 1);
  const b = e.reviseBudget(spec.campaign_id, { max_calls: 12 });
  assert.ok(b >= 1);
  const run = e.storage.claimDecideAsOwner(spec.campaign_id, "t")!;
  const step = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "s",
    run_id: run.run_id,
    question: "inspect",
    kind: "explore",
    goal_refs: [String(e.storage.list("goals", spec.campaign_id)[0]!.id)],
    preconditions: { op: "all", of: [] },
    method_family: "x",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "ex",
    reopen_rule: { kind: "never" },
  });
  const explained = e.explainStep(spec.campaign_id, step.canonical_ids.step_id!);
  assert.equal(explained.status, "ready");
  e.close();
});

test("catalog snapshot never includes api key", () => {
  const cat = new ProviderCatalog(dir());
  cat.addProvider({
    display_name: "x",
    protocol: "OPENAI_RESPONSES",
    base_url: "https://api.openai.com",
    api_key: "sk-secret-should-not-leak",
  });
  const snap = JSON.stringify(cat.publicSnapshot());
  assert.equal(snap.includes("sk-secret"), false);
  assert.equal(snap.includes("api_key_set"), true);
});

test("extractToolCall sees anthropic tool_use", () => {
  assert.equal(extractToolCall("ANTHROPIC_MESSAGES", { content: [{ type: "tool_use", name: "echo_probe" }] }), true);
  assert.equal(extractToolCall("ANTHROPIC_MESSAGES", { content: [{ type: "text", text: "hi" }] }), false);
});

test("campaign catalogued stream uses model max_output default 51200", async () => {
  assert.equal(OUTPUT_DEFAULT, 51_200);
  assert.equal(STREAM_TIMEOUT_DEFAULT_MS, 600_000);
  const cat = new ProviderCatalog(dir());
  const p = cat.addProvider({
    display_name: "qianfan",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://qianfan.baidubce.com/v2/tokenplan/personal",
    api_key: "not-a-live-key",
  });
  const m = cat.addModel({ provider_id: p.id, name: "glm-5.2" });
  assert.equal(m.max_output_tokens, 51_200);
  let saw = 0;
  const { stream } = createCataloguedProviderStream({
    catalog: cat,
    providerId: p.id,
    modelName: "glm-5.2",
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { max_tokens?: number };
      saw = Number(body.max_tokens);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    },
  });
  const s = await Promise.resolve(
    stream(SCRIPTED_MODEL, {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    }),
  );
  await s.result();
  assert.equal(saw, 51_200);
});

test("OpenCode Go URLs get x-opencode-session; other hosts do not", async () => {
  assert.equal(isOpencodeEndpoint("https://opencode.ai/zen/go/v1/chat/completions"), true);
  assert.equal(isOpencodeEndpoint("https://go.opencode.ai/v1/chat/completions"), true);
  assert.equal(isOpencodeEndpoint("https://api.openai.com/v1/chat/completions"), false);
  assert.equal(isOpencodeEndpoint("https://api.anthropic.com/v1/messages"), false);
  const oc = requestHeaders({
    protocol: "OPENAI_CHAT_COMPLETIONS",
    apiKey: "sk",
    url: "https://opencode.ai/zen/go/v1/chat/completions",
    sessionId: "camp_demo",
  });
  assert.equal(oc[OPENCODE_SESSION_HEADER], "camp_demo");
  assert.equal(oc["user-agent"], RIONEXT_USER_AGENT);
  assert.match(oc.authorization ?? "", /Bearer/);
  const oa = requestHeaders({
    protocol: "OPENAI_CHAT_COMPLETIONS",
    apiKey: "sk",
    url: "https://api.openai.com/v1/chat/completions",
    sessionId: "camp_demo",
  });
  assert.equal(oa[OPENCODE_SESSION_HEADER], undefined);
  assert.equal(oa["user-agent"], undefined);

  const seen: Record<string, string>[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    seen.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  await postJson({
    url: "https://opencode.ai/zen/go/v1/chat/completions",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    apiKey: "sk",
    body: { model: "x" },
    fetchFn,
    sessionId: "camp_x",
  });
  await postJson({
    url: "https://api.openai.com/v1/chat/completions",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    apiKey: "sk",
    body: { model: "x" },
    fetchFn,
    sessionId: "camp_x",
  });
  assert.equal(seen[0]![OPENCODE_SESSION_HEADER], "camp_x");
  assert.equal(seen[1]![OPENCODE_SESSION_HEADER], undefined);
});

test("catalogued OpenCode stream reuses one session id across turns", async () => {
  const cat = new ProviderCatalog(dir());
  const p = cat.addProvider({
    display_name: "OpenCode Go",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://opencode.ai/zen/go/v1/chat/completions",
    api_key: "sk-oc",
  });
  cat.addModel({ provider_id: p.id, name: "deepseek-v4-flash" });
  const sessions: string[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    const h = init?.headers as Record<string, string>;
    sessions.push(h[OPENCODE_SESSION_HEADER] ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 });
  };
  const { stream } = createCataloguedProviderStream({
    catalog: cat,
    providerId: p.id,
    modelName: "deepseek-v4-flash",
    fetchFn,
    sessionId: "camp_sticky",
  });
  const ctx = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
  await (await stream(SCRIPTED_MODEL, ctx)).result();
  await (await stream(SCRIPTED_MODEL, ctx)).result();
  assert.deepEqual(sessions, ["camp_sticky", "camp_sticky"]);
});
