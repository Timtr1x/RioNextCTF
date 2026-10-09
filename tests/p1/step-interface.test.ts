import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { legacyStepFingerprint } from "../../src/domain/proposals.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import type { TurnChooser } from "../../src/runtime/pi/scripted-stream.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-stepif-"));
}

function toolNamesCalled(messages: unknown[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; toolName?: string };
    if (msg.role === "toolResult" && typeof msg.toolName === "string") out.push(msg.toolName);
  }
  return out;
}

function toolResults(messages: unknown[]): unknown[] {
  return messages
    .filter((m) => (m as { role?: string }).role === "toolResult")
    .map((m) => (m as { content?: unknown }).content);
}

function seedStep(e: Engine, campaignId: string, question: string, fingerprint: string): string {
  const root = e.storage.store.db
    .prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1")
    .get(campaignId) as { id: string };
  const result = e.storage.proposeStepDirect({
    campaign_id: campaignId,
    producer_id: "test",
    submission_id: `seed-${fingerprint}`,
    question,
    kind: "explore",
    goal_refs: [root.id],
    preconditions: { op: "all", of: [] },
    method_family: "generic",
    expected_observations: [],
    completion_criteria: "done",
    fingerprint,
    reopen_rule: { kind: "always" },
  });
  return String(result.canonical_ids.step_id);
}

test("P07: propose_step with only a question creates a valid step", async () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 2,
    chooseDecide: () => ({ type: "text", text: "no plan" }),
    chooseExecute: (ctx) => {
      const called = toolNamesCalled(ctx.messages);
      if (called.includes("finish_step")) return { type: "text", text: "done" };
      if (called.includes("propose_step")) {
        return {
          type: "tool_calls",
          calls: [
            { name: "finish_step", arguments: { disposition: "deferred", summary: "suggested", next_action: "run it", reopen_rule: { kind: "never" } } },
          ],
        };
      }
      return { type: "tool_calls", calls: [{ name: "propose_step", arguments: { question: "检查备份接口是否泄露配置" } }] };
    },
  });
  const spec = loadDemoSpec("p07");
  e.createCampaign(spec);
  seedStep(e, "p07", "seed work", "p07-seed");
  await e.start("p07");
  const steps = e.storage.list("steps", "p07");
  const suggested = steps.find((s) => s.question === "检查备份接口是否泄露配置");
  assert.ok(suggested, "step created");
  assert.equal(suggested.kind, "explore");
  assert.equal(typeof suggested.fingerprint, "string" );
  assert.ok(String(suggested.fingerprint).length === 32);
  assert.equal(suggested.completion_criteria, "获得可解释的新结果");
  e.close();
});

test("P08: propose_step with explicit legacy fields still works", async () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 2,
    chooseDecide: () => ({ type: "text", text: "no plan" }),
    chooseExecute: (ctx) => {
      const called = toolNamesCalled(ctx.messages);
      if (called.includes("finish_step")) return { type: "text", text: "done" };
      if (called.includes("propose_step")) {
        return {
          type: "tool_calls",
          calls: [
            { name: "finish_step", arguments: { disposition: "deferred", summary: "suggested", next_action: "x", reopen_rule: { kind: "never" } } },
          ],
        };
      }
      return {
        type: "tool_calls",
        calls: [
          {
            name: "propose_step",
            arguments: { question: "explicit fields", kind: "verify", method_family: "http-probe", fingerprint: "explicit-fp-1" },
          },
        ],
      };
    },
  });
  const spec = loadDemoSpec("p08");
  e.createCampaign(spec);
  seedStep(e, "p08", "seed work", "p08-seed");
  await e.start("p08");
  const step = e.storage.list("steps", "p08").find((s) => s.question === "explicit fields");
  assert.ok(step);
  assert.equal(step.kind, "verify");
  assert.equal(step.method_family, "http-probe");
  assert.equal(step.fingerprint, "explicit-fp-1");
  e.close();
});

test("P09/P10: default fingerprint binds goal and legacy default merges", () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1 });
  const spec = loadDemoSpec("p09");
  e.createCampaign(spec);
  const root = (e.storage.store.db.prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1").get("p09") as { id: string }).id;

  // legacy merge: a live step with the legacy fingerprint absorbs the same ask
  const legacyFp = legacyStepFingerprint("explore", "generic", "same question");
  seedStep(e, "p09", "same question", legacyFp);
  const merged = e.storage.stepFingerprintResolve("p09", {
    kind: "explore",
    methodFamily: "generic",
    question: "same question",
    goalRefs: [root],
    inputRefs: [],
    preconditions: { op: "all", of: [] },
  });
  assert.equal(merged, legacyFp, "legacy-default step absorbs the repeat");

  // same question under a different goal must NOT merge
  const otherGoal = "goal_other";
  const a = e.storage.stepFingerprintResolve("p09", {
    kind: "explore",
    methodFamily: "generic",
    question: "fresh question",
    goalRefs: [root],
    inputRefs: [],
    preconditions: { op: "all", of: [] },
  });
  const b = e.storage.stepFingerprintResolve("p09", {
    kind: "explore",
    methodFamily: "generic",
    question: "fresh question",
    goalRefs: [otherGoal],
    inputRefs: [],
    preconditions: { op: "all", of: [] },
  });
  assert.notEqual(a, b, "different goal refs produce different fingerprints");

  // same canonical input twice → same fingerprint (idempotent)
  const again = e.storage.stepFingerprintResolve("p09", {
    kind: "explore",
    methodFamily: "generic",
    question: "fresh  question",
    goalRefs: [root],
    inputRefs: [],
    preconditions: { op: "all", of: [] },
  });
  assert.equal(a, again, "whitespace-normalized question yields the same fingerprint");
  e.close();
});

test("P14/P15: expected_revision comes from the read set; unread entities are rejected", async () => {
  const dir = tmp();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 3 });
  const spec = loadDemoSpec("p1415");
  e.createCampaign(spec);
  const stepId = seedStep(e, "p1415", "adjustable step", "p1415-seed");
  // retired steps exist in the table but are not in the active view, so a run
  // that never explicitly read them must not get a revision for free
  const retiredId = seedStep(e, "p1415", "old direction", "p1415-retired");
  e.storage.store.db.prepare("UPDATE steps SET status = 'retired' WHERE id = ?").run(retiredId);

  const chooseDecide: TurnChooser = (ctx) => {
    const called = toolNamesCalled(ctx.messages);
    if (called.includes("finish_decision")) return { type: "text", text: "done" };
    if (called.filter((n) => n === "propose_plan").length === 1) {
      // second batch: adjust the never-read retired step → must be rejected
      return {
        type: "tool_calls",
        calls: [{ name: "propose_plan", arguments: { operations: [{ op: "revise_step_priority", step_id: retiredId, priority: 1 }] } }],
      };
    }
    if (called.includes("propose_plan")) {
      return { type: "tool_calls", calls: [{ name: "finish_decision", arguments: { summary: "adjusted" } }] };
    }
    // first batch: adjust the in-view step without sending expected_revision
    return {
      type: "tool_calls",
      calls: [{ name: "propose_plan", arguments: { operations: [{ op: "revise_step_priority", step_id: stepId, priority: 5 }] } }],
    };
  };
  const e2 = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 3, chooseDecide, chooseExecute: () => ({ type: "text", text: "stop" }) });
  await e2.runDecide("p1415");
  const messages = (e2.lastWorker?.agent?.state.messages ?? []) as unknown[];
  assert.match(JSON.stringify(toolResults(messages)), /read_required/, "unread entity adjustment must be rejected");
  const adjusted = e.storage.list("steps", "p1415").find((s) => s.id === stepId);
  assert.equal(adjusted?.priority, 5, "read entity adjusts fine without an explicit revision");
  const retired = e.storage.list("steps", "p1415").find((s) => s.id === retiredId);
  assert.equal(retired?.priority, 100, "unread entity keeps its priority");
  e.close();
});
