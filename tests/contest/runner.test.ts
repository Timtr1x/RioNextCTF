import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ContestQuestion, FetchLike } from "../../src/contest/api.ts";
import { EngineRunnerFactory } from "../../src/contest/runner.ts";
import { openEngine } from "../../src/controller/engine.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-runner-"));
}

function withSolver(dir: string): void {
  const cat = new ProviderCatalog(dir);
  const provider = cat.addProvider({
    display_name: "test",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://example.invalid/v1/chat/completions",
    api_key: "sk-test",
  });
  const model = cat.addModel({ provider_id: provider.id, name: "deepseek-chat" });
  cat.assignSlot("solver", model.id);
}

function question(over: Partial<ContestQuestion>): ContestQuestion {
  return {
    question_id: "q1",
    title: "Real question",
    category: "misc",
    description: "analyze the attachment",
    score: 100,
    real_score: 100,
    solved_number: 0,
    is_solved: false,
    interactive: false,
    file_url: null,
    attributes: [],
    capabilities: [],
    connection: null,
    raw: {},
    ...over,
  };
}

/** The platform CDN never sees the supervisor's fetch; serve bytes directly. */
const fakeFetch: FetchLike = async () =>
  new Response(new Uint8Array([0x41, 0x42, 0x43, 0x44]), {
    status: 200,
    headers: { "content-disposition": 'attachment; filename="a.bin"' },
  });

test("mixed contest question (attachment + live web) prepares with ctf+web capabilities", async () => {
  const dir = tmp();
  withSolver(dir);
  const factory = new EngineRunnerFactory(dir, { fetchFn: fakeFetch, onLog: () => {} });
  try {
    const q = question({
      question_id: "qmix",
      file_url: "https://cdn.example/files/a.bin",
      connection: { docker_url: "web.example:8080" },
    });
    const prep = await factory.prepare(q);
    assert.equal(prep.created, true);
    const engine = openEngine(dir, { silent: true, maxCycles: 1 });
    try {
      const camp = engine.storage.getCampaign(prep.campaignId);
      assert.equal(camp.spec.challenge?.web_url, "http://web.example:8080/");
      assert.deepEqual(engine.kaliOpts(prep.campaignId).capabilities, ["ctf", "web"]);
    } finally {
      engine.close();
    }
  } finally {
    factory.dispose();
  }
});

test("two campaigns sharing one container keep their own capabilities and scope", async () => {
  const dir = tmp();
  withSolver(dir);
  const shared = { name: "rionext-test-shared", mountHost: join(dir, "workspace") };
  const factory = new EngineRunnerFactory(dir, { fetchFn: fakeFetch, shared, onLog: () => {} });
  try {
    const webOnly = await factory.prepare(
      question({ question_id: "qweb", category: "web", connection: { docker_url: "site.example:80" } }),
    );
    const binOnly = await factory.prepare(
      question({ question_id: "qbin", category: "reverse", file_url: "https://cdn.example/files/a.bin" }),
    );
    const engine = openEngine(dir, { silent: true, maxCycles: 1, kaliShared: shared });
    try {
      const webOpts = engine.kaliOpts(webOnly.campaignId);
      const binOpts = engine.kaliOpts(binOnly.campaignId);
      assert.deepEqual(webOpts.capabilities, ["web"]);
      assert.deepEqual(binOpts.capabilities, ["ctf"]);
      // neither inherits the other's network scope
      assert.deepEqual(binOpts.allowAssets, []);
      assert.ok(webOpts.allowAssets.includes("site.example"));
    } finally {
      engine.close();
    }
  } finally {
    factory.dispose();
  }
});
