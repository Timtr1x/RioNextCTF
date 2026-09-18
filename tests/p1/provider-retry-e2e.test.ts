import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";

/**
 * End-to-end fault injection through the real live path (no scripted chooser):
 * a local HTTP server stands in for the provider and fails twice with 500
 * before answering with a legal finish_step tool call. Before the retry work,
 * the first 500 killed the run with `primary_stop:model_error`; now the run
 * must survive and finish resolved.
 */
function startFlakyProvider(): Promise<{ port: number; hits: () => number; urls: () => string[]; close: () => Promise<void> }> {
  let hits = 0;
  const urls: string[] = [];
  const server: Server = createServer((req, res) => {
    hits += 1;
    urls.push(req.url ?? "");
    // Drain the request body so keep-alive connections behave.
    req.on("data", () => {});
    req.on("end", () => {
      if (hits <= 2) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("upstream hiccup");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_finish",
                    type: "function",
                    function: {
                      name: "finish_step",
                      arguments: JSON.stringify({ disposition: "resolved", summary: "recovered after provider retries" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        hits: () => hits,
        urls: () => urls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("a provider that fails twice is retried and the run still resolves", async () => {
  const fake = await startFlakyProvider();
  const dir = mkdtempSync(join(tmpdir(), "rn-retry-e2e-"));
  const catalog = new ProviderCatalog(dir);
  const provider = catalog.addProvider({
    display_name: "flaky",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: `http://127.0.0.1:${fake.port}/v1/chat/completions`,
    api_key: "sk-test-not-a-secret",
  });
  const model = catalog.addModel({ provider_id: provider.id, name: "fake-model" });
  catalog.assignSlot("solver", model.id);

  // No choosers: the engine takes the live catalog path under test.
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 3 });
  try {
    const spec = loadDemoSpec("retry-e2e");
    e.createCampaign(spec);
    const decide = e.storage.claimDecide(spec.campaign_id, "seed")!;
    const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
    e.storage.proposeStepDirect({
      campaign_id: spec.campaign_id,
      producer_id: "seed",
      submission_id: "seed-retry-e2e",
      run_id: decide.run_id,
      question: "finish without needing evidence",
      kind: "explore",
      goal_refs: [root],
      preconditions: { op: "all", of: [] },
      method_family: "f-retry",
      expected_observations: [],
      completion_criteria: "none",
      fingerprint: "retry-e2e-fp",
      reopen_rule: { kind: "always" },
    });
    e.storage.finishRun(spec.campaign_id, decide.run_id, {
      run_id: decide.run_id,
      step_id: null,
      mode: "decide",
      reason: "resolved",
      summary: "seeded",
      observation_ids: [],
      fact_ids: [],
      finding_ids: [],
      blocked_on: null,
      reopen_rule: null,
      finish_requested: true,
      protocol_error: null,
    });
    e.storage.setCampaignState(spec.campaign_id, "active", { kind: "user", id: "t" });

    const outcome = await e.runExecuteSlot(spec.campaign_id);
    assert.ok(outcome, "an execute run happened");
    assert.equal(outcome.reason, "resolved", "two 500s must not kill the run");
    assert.equal(fake.hits(), 3, "two failures then one success reached the provider");
    assert.equal(outcome.run_id.length > 0, true);
    const run = e.storage.getRun(outcome.run_id);
    assert.equal(run.last_error ?? null, null, "a recovered stream records no failure");
    const step = e.storage.list("steps", spec.campaign_id)[0]!;
    assert.equal(step.status, "resolved");
  } finally {
    e.close();
    await fake.close();
  }
});
