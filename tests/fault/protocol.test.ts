import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { applyFinalizationFlags, makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { MAX_STEP_ATTEMPTS } from "../../src/storage/service.ts";
import { buildContextPack } from "../../src/context/builder.ts";
import { evaluateCompletion } from "../../src/domain/completion.ts";
import type { RunLease } from "../../src/domain/types.ts";
import { loadAssessmentSpec, loadDemoSpec } from "../../src/eval/helpers.ts";
import { createQueuedStreamFn, SCRIPTED_MODEL } from "../../src/runtime/pi/scripted-stream.ts";
import type { TurnChooser } from "../../src/runtime/pi/scripted-stream.ts";
import type { LabWorld } from "../../src/tools/synthetic.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "rn-p-"));
}

function engine(data: string, extra?: ConstructorParameters<typeof Engine>[1]): Engine {
  return new Engine(makeRuntimeConfig(data), { silent: true, maxCycles: 24, ...extra });
}

function toolResultNames(messages: unknown[]): string[] {
  return (messages as { role?: string; toolName?: string }[])
    .filter((m) => m.role === "toolResult")
    .map((m) => String(m.toolName));
}

function userText(message: { role?: string; content?: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return (c as { text?: string }[]).map((x) => x.text ?? "").join("");
  return JSON.stringify(c ?? "");
}

function toolCallIds(messages: unknown[]): string[] {
  const ids: string[] = [];
  for (const m of messages as { role?: string; content?: unknown }[]) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as { type?: string; id?: string }[]) {
      if (block.type === "toolCall" && block.id) ids.push(block.id);
    }
  }
  return ids;
}

function oneStepDecide(question: string): TurnChooser {
  return (ctx) => {
    const names = toolResultNames(ctx.messages);
    if (!names.includes("propose_plan")) {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "propose_plan",
            arguments: {
              operations: [
                {
                  op: "propose_step",
                  step: {
                    kind: "explore",
                    question,
                    methodFamily: "t-protocol",
                    expectedObservations: ["marker"],
                    completionCriteria: "observe",
                    preconditions: { op: "all", of: [] },
                    goalRefs: [],
                    inputRefs: [],
                    resourceClaims: [],
                    budgetHint: {},
                    reopenRule: { kind: "always" },
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return { type: "tool_calls", calls: [{ name: "finish_decision", arguments: { summary: "one step" } }] };
  };
}

test("T01 first execute without finding does not complete campaign", async () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t01");
  e.createCampaign(spec);
  await e.runDecide(spec.campaign_id);
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.notEqual(e.storage.getCampaign(spec.campaign_id).state, "completed");
  const steps = e.storage.list("steps", spec.campaign_id);
  assert.ok(steps.some((s) => s.status === "ready" || s.status === "blocked" || s.status === "deferred"));
  e.close();
});

test("T02 same fingerprint rewrite does not reset attempt_count", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t02");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  const a = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "s1",
    run_id: run.run_id,
    question: "use badge reader to unlock drawer",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "badge",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "badge-fp",
    reopen_rule: { kind: "never" },
  });
  e.storage.store.db.prepare("UPDATE steps SET attempt_count = 3 WHERE id = ?").run(a.canonical_ids.step_id!);
  const b = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "s2",
    run_id: run.run_id,
    question: "please use the badge reader again, pretty please",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "badge",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "badge-fp",
    reopen_rule: { kind: "never" },
  });
  assert.equal(a.canonical_ids.step_id, b.canonical_ids.step_id);
  const step = e.storage.list("steps", spec.campaign_id).find((s) => s.id === a.canonical_ids.step_id)!;
  assert.equal(step.attempt_count, 3);
  e.close();
});

test("T03 blocked then ready after missing precondition fact", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t03");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  const blocked = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "cab",
    run_id: run.run_id,
    question: "open cabinet with key",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "atom", key: "has_key" },
    method_family: "open-cabinet",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "cab",
    reopen_rule: { kind: "fact_key", key: "has_key" },
  });
  assert.equal(blocked.extra?.step_status, "blocked");
  const obs = e.storage.recordObservation({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "o",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "key",
    body: { has_key: true },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  e.storage.submitFact({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "f",
    run_id: run.run_id,
    proposition: "operator holds cabinet key",
    fact_key: "has_key",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
  });
  const step = e.storage.list("steps", spec.campaign_id).find((s) => s.id === blocked.canonical_ids.step_id)!;
  assert.equal(step.status, "ready");
  e.close();
});

test("T04 deferred reopen after env revision change", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t04");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  const st = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "side",
    run_id: run.run_id,
    question: "open side panel",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "atom", key: "clock_seen" },
    method_family: "side",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "side",
    reopen_rule: { kind: "env_revision", env_revision: "env-2" },
  });
  e.storage.store.db.prepare("UPDATE steps SET status = 'deferred' WHERE id = ?").run(st.canonical_ids.step_id!);
  const obs = e.storage.recordObservation({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "clock",
    run_id: run.run_id,
    attempt_id: run.run_id,
    subject: "clock",
    body: { env: "env-2" },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-2",
  });
  e.storage.submitFact({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "fc",
    run_id: run.run_id,
    proposition: "clock observed",
    fact_key: "clock_seen",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
    env_rev: "env-2",
  });
  const step = e.storage.list("steps", spec.campaign_id).find((s) => s.id === st.canonical_ids.step_id)!;
  assert.equal(step.status, "ready");
  e.close();
});

test("T05 limited retries count cost and do not refute the direction", async () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t05");
  spec.budget.max_calls = 80;
  e.createCampaign(spec);
  await e.start(spec.campaign_id);
  const facts = e.storage.list("facts", spec.campaign_id);
  assert.equal(facts.some((f) => String(f.proposition).includes("NOT") && String(f.fact_key) === "drawer_open"), false);
  const spent = Number(e.budget.snapshot(spec.campaign_id).spent_calls);
  assert.ok(spent >= 1);
  e.close();
});

test("T06 submit_fact without evidence never verified", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t06");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const r = e.storage.submitFact({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "bare",
    run_id: run.run_id,
    proposition: "cabinet is open",
    fact_key: "open",
    support_refs: [],
    conditions: {},
  });
  assert.equal(r.extra?.submit_status, "rejected");
  const facts = e.storage.list("facts", spec.campaign_id);
  assert.equal(facts.length, 0);
  e.close();
});

test("T07 tool success does not mark coverage tested", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t07");
  e.createCampaign(spec);
  const cov = e.storage.list("coverage_items", spec.campaign_id);
  assert.ok(cov.length >= 1);
  assert.equal(cov[0]!.execution_state, "untested");
  e.storage.updateCoverage(spec.campaign_id, String(cov[0]!.obligation), { outcome: "inconclusive" });
  const after = e.storage.list("coverage_items", spec.campaign_id)[0]!;
  assert.equal(after.execution_state, "untested");
  assert.equal(after.outcome, "inconclusive");
  e.close();
});

test("T11 opposite observations leave disputed facts", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t11");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const o1 = e.storage.recordObservation({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "o1", run_id: run.run_id, attempt_id: run.run_id,
    subject: "x", body: { v: 1 }, artifact_refs: [], conditions: {}, env_rev: "e",
  });
  const o2 = e.storage.recordObservation({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "o2", run_id: run.run_id, attempt_id: run.run_id,
    subject: "x", body: { v: 2 }, artifact_refs: [], conditions: {}, env_rev: "e",
  });
  e.storage.submitFact({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "f1", run_id: run.run_id,
    proposition: "door is open", fact_key: "door", support_refs: [o1.canonical_ids.observation_id!], conditions: {},
  });
  e.storage.submitFact({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "f2", run_id: run.run_id,
    proposition: "door is closed", fact_key: "door", support_refs: [o2.canonical_ids.observation_id!], conditions: {},
  });
  const facts = e.storage.list("facts", spec.campaign_id);
  assert.equal(facts.length, 2);
  assert.ok(facts.every((f) => f.epistemic_status === "disputed"));
  e.close();
});

test("T12 unknown AND/OR does not admit ready", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t12");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  const r = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "p",
    submission_id: "and",
    run_id: run.run_id,
    question: "needs unknown",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [{ op: "atom", key: "ghost" }] },
    method_family: "x",
    expected_observations: [],
    completion_criteria: "x",
    fingerprint: "unk",
    reopen_rule: { kind: "never" },
  });
  assert.equal(r.extra?.step_status, "blocked");
  e.close();
});

test("T13 mutual blocked steps do not spawn isomorphic extras", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t13");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "a", run_id: run.run_id,
    question: "A needs B", kind: "explore", goal_refs: [root],
    preconditions: { op: "atom", key: "b" }, method_family: "cycle", expected_observations: [],
    completion_criteria: "x", fingerprint: "A", reopen_rule: { kind: "never" },
  });
  e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "b", run_id: run.run_id,
    question: "B needs A", kind: "explore", goal_refs: [root],
    preconditions: { op: "atom", key: "a" }, method_family: "cycle", expected_observations: [],
    completion_criteria: "x", fingerprint: "B", reopen_rule: { kind: "never" },
  });
  const again = e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "a2", run_id: run.run_id,
    question: "A needs B rewritten", kind: "explore", goal_refs: [root],
    preconditions: { op: "atom", key: "b" }, method_family: "cycle", expected_observations: [],
    completion_criteria: "x", fingerprint: "A", reopen_rule: { kind: "never" },
  });
  assert.equal(again.extra?.merged, true);
  const steps = e.storage.list("steps", spec.campaign_id);
  assert.equal(steps.length, 2);
  assert.ok(steps.every((s) => s.status === "blocked"));
  e.close();
});

test("T14 empty decide reviews plateau without infinite LLM calls", async () => {
  const chooseDecide: TurnChooser = (ctx) => {
    const names = (ctx.messages as { role?: string; toolName?: string }[])
      .filter((m) => m.role === "toolResult")
      .map((m) => m.toolName);
    if (!names.includes("propose_plan")) {
      return { type: "tool_calls", calls: [{ name: "propose_plan", arguments: { operations: [], no_change_reason: "nothing" } }] };
    }
    return { type: "tool_calls", calls: [{ name: "finish_decision", arguments: { summary: "no change" } }] };
  };
  const e = engine(dir(), { chooseDecide, maxCycles: 8 });
  const spec = loadDemoSpec("t14");
  spec.stop_policy.max_empty_reviews_per_progress_epoch = 2;
  spec.budget.max_calls = 80;
  e.createCampaign(spec);
  await e.start(spec.campaign_id);
  assert.equal(e.storage.getCampaign(spec.campaign_id).state, "plateau");
  assert.ok(e.modelSends <= 12);
  e.close();
});

test("T15 retire subgoal keeps history", () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t15");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  e.storage.applyProposalBatch({
    campaign_id: spec.campaign_id,
    producer_id: run.run_id,
    submission_id: "g1",
    run_id: run.run_id,
    operations: [{ op: "propose_subgoal", statement: "get key", parent_id: root }],
  });
  const sub = e.storage.list("goals", spec.campaign_id).find((g) => !g.is_root)!;
  e.storage.applyProposalBatch({
    campaign_id: spec.campaign_id,
    producer_id: run.run_id,
    submission_id: "g2",
    run_id: run.run_id,
    operations: [{ op: "retire_subgoal", goal_id: sub.id, expected_revision: 1, reason: "absorbed" }],
  });
  const after = e.storage.list("goals", spec.campaign_id).find((g) => g.id === sub.id)!;
  assert.equal(after.status, "retired");
  assert.equal(after.retired_reason, "absorbed");
  const ev = e.storage.list("events", spec.campaign_id).filter((x) => x.type === "goal.retired");
  assert.equal(ev.length, 1);
  e.close();
});

test("T16 new run rebuilds from structured state not Pi history", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const names = toolResultNames(ctx.messages);
    if (!names.includes("submit_observation")) {
      return {
        type: "tool_calls",
        calls: [{ name: "submit_observation", arguments: { subject: "t16-memory", body: { marker: "keep-me" } } }],
      };
    }
    return {
      type: "tool_calls",
      calls: [{ name: "finish_step", arguments: { reason: "deferred", summary: "t16-last-failure", next_action: "rebuild from sqlite", reopen_rule: { kind: "always" } } }],
    };
  };
  const e = engine(dir(), { chooseDecide: oneStepDecide("t16 memory step"), chooseExecute, maxCycles: 4 });
  const spec = loadDemoSpec("t16");
  e.createCampaign(spec);
  await e.runDecide(spec.campaign_id);
  const firstOutcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(firstOutcome);
  assert.ok(firstOutcome.observation_ids.length >= 1, "first run must record observation ids on TaskOutcome");
  const obsId = firstOutcome.observation_ids[0]!;
  const firstWorker = e.lastWorker;
  assert.ok(firstWorker?.agent);
  const firstIds = toolCallIds(firstWorker.agent.state.messages);
  assert.ok(firstIds.length >= 1);
  const step = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.equal(step.last_failure, "t16-last-failure");
  const previewLease: RunLease = {
    run_id: "preview-t16",
    campaign_id: spec.campaign_id,
    step_id: String(step.id),
    mode: "execute",
    kind: "explore",
    attempt_no: 2,
    fence: 2,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "t16",
    continuation_of: firstOutcome.run_id,
  };
  const pack = buildContextPack(e.storage, previewLease);
  const payload = pack.user_payload as {
    graph: { observations: { id: string; subject?: string }[]; steps: { id: string; last_failure?: string }[] };
    current_step: { last_failure?: string };
  };
  assert.ok(payload.graph.observations.some((o) => o.id === obsId && o.subject === "t16-memory"));
  assert.equal(payload.current_step.last_failure, "t16-last-failure");
  assert.ok(payload.graph.steps.some((s) => s.id === step.id && s.last_failure === "t16-last-failure"));

  const secondOutcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(secondOutcome);
  const secondWorker = e.lastWorker;
  assert.ok(secondWorker?.agent);
  assert.notEqual(secondWorker, firstWorker);
  assert.notEqual(secondWorker.agent, firstWorker.agent);
  const msgs = secondWorker.agent.state.messages;
  assert.equal(msgs[0]?.role, "user");
  const prompt = userText(msgs[0] as { role?: string; content?: unknown });
  assert.ok(prompt.includes(obsId), "new prompt must carry the persisted observation id");
  assert.ok(prompt.includes("t16-last-failure"), "new prompt must carry last_failure from SQLite");
  for (const id of firstIds) {
    assert.equal(
      JSON.stringify(msgs).includes(id),
      false,
      `second Agent reused Pi history toolCall ${id}`,
    );
  }
  e.close();
});

test("T17 run stop on turn cap keeps observations", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const names = toolResultNames(ctx.messages);
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "finish_step",
            arguments: { disposition: "deferred", summary: "capped", next_action: "continue after cap" },
          },
        ],
      };
    }
    if (!names.includes("submit_observation")) {
      return {
        type: "tool_calls",
        calls: [{ name: "submit_observation", arguments: { subject: "t17-kept", body: { kept: true } } }],
      };
    }
    return {
      type: "tool_calls",
      calls: [{ name: "finish_step", arguments: { reason: "resolved", summary: "should not run after cap" } }],
    };
  };
  const e = engine(dir(), { chooseDecide: oneStepDecide("t17 cap step"), chooseExecute });
  e.config.max_execute_turns_per_run = 1;
  const spec = loadDemoSpec("t17");
  e.createCampaign(spec);
  await e.runDecide(spec.campaign_id);
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "deferred");
  assert.equal(outcome.finish_requested, true);
  assert.equal(e.lastWorker?.finalizerModelSends, 1);
  assert.ok(outcome.observation_ids.length >= 1, "turn cap must not drop submitted observation ids");
  const obsId = outcome.observation_ids[0]!;
  const rows = e.storage.list("observations", spec.campaign_id);
  assert.ok(rows.some((r) => r.id === obsId && r.subject === "t17-kept"));
  const run = e.storage.getRun(outcome.run_id);
  const stored = JSON.parse(String(run.outcome_json)) as { observation_ids: string[] };
  assert.ok(stored.observation_ids.includes(obsId));
  e.close();
});

test("T18 truncated tool calls are not executed", async () => {
  let executed = 0;
  const boom: AgentTool = {
    name: "world_act",
    label: "act",
    description: "act",
    parameters: Type.Object({ action: Type.String() }),
    execute: async () => {
      executed += 1;
      return { content: [{ type: "text", text: "nope" }], details: {} };
    },
  };
  const agent = new Agent({
    initialState: { systemPrompt: "t", model: SCRIPTED_MODEL, tools: [boom] },
    streamFn: createQueuedStreamFn([{ type: "truncated_tools", calls: [{ name: "world_act", arguments: { action: "open_cabinet" } }] }]),
    toolExecution: "sequential",
  });
  await agent.prompt("go");
  assert.equal(executed, 0);
});

test("T19 finish then env tool is not dispatched", async () => {
  const chooseExecute: TurnChooser = () => ({
    type: "tool_calls",
    calls: [
      { name: "finish_step", arguments: { reason: "deferred", summary: "done", next_action: "stop env" } },
      { name: "world_act", arguments: { action: "open_cabinet" } },
    ],
  });
  const e = engine(dir(), { chooseExecute, maxCycles: 4 });
  const spec = loadDemoSpec("t19");
  e.createCampaign(spec);
  await e.runDecide(spec.campaign_id);
  await e.runExecuteSlot(spec.campaign_id);
  assert.ok((e.lastWorker?.finishThenBlocked ?? 0) >= 1 || (e.lastWorker?.toolGateway?.blockedAfterFinish ?? 0) >= 1);
  const world = e.storage.getWorld<LabWorld>(spec.campaign_id, { cabinet_open: false } as LabWorld);
  assert.equal(world.cabinet_open, false);
  e.close();
});

test("T21 new TaskRun cannot mint free quota after cap", async () => {
  const e = engine(dir(), { maxCycles: 12 });
  const spec = loadDemoSpec("t21");
  spec.budget.max_calls = 4;
  spec.budget.max_tokens = null;
  spec.budget.max_cost_micro = null;
  e.createCampaign(spec);
  await e.start(spec.campaign_id);
  const snap = e.budget.snapshot(spec.campaign_id);
  assert.ok(Number(snap.spent_calls) + Number(snap.reserved_calls) >= 4 || e.storage.getCampaign(spec.campaign_id).state === "budget_paused");
  assert.equal(e.budget.canAdmit(spec.campaign_id, 1, 0, 0), false);
  e.close();
});

test("T23 cancel stays cancelled despite follow-up", async () => {
  const e = engine(dir());
  const spec = loadDemoSpec("t23");
  e.createCampaign(spec);
  e.cancel(spec.campaign_id);
  await e.start(spec.campaign_id);
  assert.equal(e.storage.getCampaign(spec.campaign_id).state, "cancelled");
  const runs = e.storage.list("task_runs", spec.campaign_id);
  assert.equal(runs.length, 0);
  e.close();
});

test("T24 confirmed finding does not complete assessment with untested coverage", () => {
  const e = engine(dir());
  const spec = loadAssessmentSpec("t24");
  e.createCampaign(spec);
  const run = e.storage.claimDecide(spec.campaign_id, "t")!;
  const o = e.storage.recordObservation({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "o", run_id: run.run_id, attempt_id: run.run_id,
    subject: "note", body: { clue: "0000" }, artifact_refs: [], conditions: {}, env_rev: "e",
  });
  const f = e.storage.submitFinding({
    campaign_id: spec.campaign_id, producer_id: "p", submission_id: "f", run_id: run.run_id,
    claim: "misleading code", evidence_refs: [o.canonical_ids.observation_id!], dedup_key: "code-0000",
    model_confidence: 0.99,
  });
  e.storage.setFindingStatus(spec.campaign_id, f.canonical_ids.finding_id!, "validating", { kind: "controller", id: "oracle" });
  e.storage.setFindingStatus(spec.campaign_id, f.canonical_ids.finding_id!, "confirmed", { kind: "controller", id: "oracle" });
  e.storage.finishRun(spec.campaign_id, run.run_id, {
    run_id: run.run_id,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "seeded",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [f.canonical_ids.finding_id!],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  // the seeded input has been reviewed, otherwise pending_decision blocks first
  e.storage.applyProposalBatch({
    campaign_id: spec.campaign_id,
    producer_id: "t",
    submission_id: "t24-review",
    run_id: run.run_id,
    operations: [],
    reviewed_through_seq: e.storage.getCampaign(spec.campaign_id).event_head,
  });
  e.storage.consumeEvents(spec.campaign_id);
  const finding = e.storage.list("findings", spec.campaign_id)[0]!;
  assert.equal(finding.status, "confirmed");
  const snap = e.snapshot(spec.campaign_id);
  const r = evaluateCompletion(snap);
  assert.equal(r.canClose, false);
  assert.ok(r.blockers.includes("mandatory_coverage_untested"));
  e.close();
});

test("T22 child process boundary reload", () => {
  const data = dir();
  const specPath = join(data, "spec.json");
  writeFileSync(specPath, JSON.stringify(loadDemoSpec("t22c")));
  const childJs = join(process.cwd(), "dist/tests/fault/child-commit.js");
  const childTs = join(process.cwd(), "tests/fault/child-commit.ts");
  const r = spawnSync(
    process.execPath,
    existsSync(childJs) ? [childJs, data, specPath] : ["--experimental-strip-types", childTs, data, specPath],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const e = engine(data);
  const camp = e.storage.getCampaign("t22c");
  assert.ok(e.storage.list("observations", camp.id).length >= 1);
  e.close();
});

function obsIdFrom(ctx: { messages: unknown[] }): string | undefined {
  for (const raw of ctx.messages) {
    const m = raw as { role?: string; toolName?: string; content?: { text?: string }[] };
    if (m.role !== "toolResult" || m.toolName !== "submit_observation") continue;
    try {
      const parsed = JSON.parse((m.content ?? []).map((c) => c.text ?? "").join("")) as {
        canonical_ids?: { observation_id?: string };
      };
      if (parsed.canonical_ids?.observation_id) return parsed.canonical_ids.observation_id;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function seedReadyStep(e: Engine, campaignId: string, question: string, fingerprint: string): void {
  const decide = e.storage.claimDecide(campaignId, "seed")!;
  const root = String(e.storage.list("goals", campaignId)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: campaignId,
    producer_id: "seed",
    submission_id: `seed-${fingerprint}`,
    run_id: decide.run_id,
    question,
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "f-protocol",
    expected_observations: ["marker"],
    completion_criteria: "observe",
    fingerprint,
    reopen_rule: { kind: "always" },
  });
  e.storage.finishRun(campaignId, decide.run_id, {
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
}

function legalResolvedChooser(): TurnChooser {
  return (ctx) => {
    const names = toolResultNames(ctx.messages);
    if (!names.includes("submit_observation")) {
      return {
        type: "tool_calls",
        calls: [{ name: "submit_observation", arguments: { subject: "f-ev", body: { ok: true } } }],
      };
    }
    const obs = obsIdFrom(ctx);
    return {
      type: "tool_calls",
      calls: [
        {
          name: "finish_step",
          arguments: { disposition: "resolved", summary: "legal primary finish", evidence_refs: obs ? [obs] : [] },
        },
      ],
    };
  };
}

test("F01 primary legal finish does not start Finalize", async () => {
  const e = engine(dir(), { chooseExecute: legalResolvedChooser() });
  const spec = loadDemoSpec("f01");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f01 step", "f01-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "resolved");
  assert.equal(e.lastWorker?.finalizerModelSends ?? 0, 0);
  const step = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.equal(step.status, "resolved");
  const started = e.storage.list("events", spec.campaign_id).filter((x) => x.type === "run.finalization_started");
  assert.equal(started.length, 0);
  e.close();
});

test("F02 natural stop Finalize resolved", async () => {
  let e: Engine;
  const spec = loadDemoSpec("f02");
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      const ids = e.storage.list("observations", spec.campaign_id).map((o) => String(o.id));
      return {
        type: "tool_calls",
        calls: [{ name: "finish_step", arguments: { disposition: "resolved", summary: "repaired", evidence_refs: ids } }],
      };
    }
    if (!toolResultNames(ctx.messages).includes("submit_observation")) {
      return {
        type: "tool_calls",
        calls: [{ name: "submit_observation", arguments: { subject: "f02", body: { n: 1 } } }],
      };
    }
    return { type: "text", text: "stopping without finish" };
  };
  e = engine(dir(), { chooseExecute });
  assert.equal(e.config.finalization.enabled, true);
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f02 step", "f02-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "resolved");
  assert.equal(e.lastWorker?.finalizerModelSends, 1);
  assert.equal(e.storage.list("steps", spec.campaign_id)[0]!.status, "resolved");
  e.close();
});

test("F03 Finalize deferred with next_action", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "finish_step",
            arguments: { disposition: "deferred", summary: "cap deferred", next_action: "try another path" },
          },
        ],
      };
    }
    return { type: "text", text: "hit cap soon" };
  };
  const e = engine(dir(), { chooseExecute });
  e.config.max_execute_turns_per_run = 1;
  const spec = loadDemoSpec("f03");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f03 step", "f03-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "deferred");
  const step = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.equal(step.status, "deferred");
  assert.deepEqual(JSON.parse(String(step.reopen_rule_json)), { kind: "always" });
  e.close();
});

test("F04 Finalize blocked with blocked_on", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "finish_step",
            arguments: { disposition: "blocked", summary: "need key", blocked_on: "missing_key" },
          },
        ],
      };
    }
    return { type: "text", text: "cannot proceed" };
  };
  const e = engine(dir(), { chooseExecute });
  const spec = loadDemoSpec("f04");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f04 step", "f04-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "blocked");
  assert.equal(outcome.blocked_on, "missing_key");
  assert.equal(e.storage.list("steps", spec.campaign_id)[0]!.status, "blocked");
  e.close();
});

test("F05 tool cap still admits Finalize finish_step", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "finish_step",
            arguments: { disposition: "deferred", summary: "after cap", next_action: "resume" },
          },
        ],
      };
    }
    return { type: "tool_calls", calls: [{ name: "world_inspect", arguments: { target: "desk" } }] };
  };
  const e = engine(dir(), { chooseExecute });
  e.config.max_tool_calls_per_run = 1;
  const spec = loadDemoSpec("f05");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f05 step", "f05-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "deferred");
  assert.equal(outcome.finish_requested, true);
  e.close();
});

test("F06 turn cap leaves a separate Finalize model call", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "finish_step",
            arguments: { disposition: "deferred", summary: "turn capped", next_action: "next fragment" },
          },
        ],
      };
    }
    return { type: "text", text: "turn 1" };
  };
  const e = engine(dir(), { chooseExecute });
  e.config.max_execute_turns_per_run = 1;
  const spec = loadDemoSpec("f06");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f06 step", "f06-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(e.lastWorker?.finalizerModelSends, 1);
  assert.ok((e.lastWorker?.modelGateway?.modelSends ?? 0) >= 2);
  assert.equal(outcome.reason, "deferred");
  e.close();
});

test("F07 Finalize rejects env tools", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return {
        type: "tool_calls",
        calls: [{ name: "kali_run", arguments: { kind: "kali", bin: "nmap", args: ["-h"] } }],
      };
    }
    return { type: "text", text: "natural" };
  };
  const e = engine(dir(), { chooseExecute });
  const spec = loadDemoSpec("f07");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f07 step", "f07-fp");
  const envBefore = 0;
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "incomplete_protocol");
  assert.equal(e.lastWorker?.toolGateway?.envSends ?? 0, envBefore);
  e.close();
});

test("F08 Finalize text only is incomplete with no third model turn", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return { type: "text", text: "cannot submit" };
    }
    return { type: "text", text: "primary stop" };
  };
  const e = engine(dir(), { chooseExecute });
  const spec = loadDemoSpec("f08");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f08 step", "f08-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "incomplete_protocol");
  assert.equal(e.lastWorker?.finalizerModelSends, 1);
  assert.equal(e.lastWorker?.modelGateway?.modelSends, 2);
  e.close();
});

test("F09 duplicate finish is idempotent; different payload conflicts", async () => {
  const chooseExecute: TurnChooser = () => ({
    type: "tool_calls",
    calls: [
      {
        name: "finish_step",
        arguments: { disposition: "deferred", summary: "first", next_action: "hold" },
      },
      {
        name: "finish_step",
        arguments: { disposition: "deferred", summary: "first", next_action: "hold" },
      },
      {
        name: "finish_step",
        arguments: { disposition: "blocked", summary: "second", blocked_on: "other" },
      },
    ],
  });
  const e = engine(dir(), { chooseExecute });
  const spec = loadDemoSpec("f09");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f09 step", "f09-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "deferred");
  assert.equal(outcome.summary, "first");
  assert.equal(e.storage.list("steps", spec.campaign_id)[0]!.status, "deferred");
  const conflicts = e.storage.list("events", spec.campaign_id).filter((x) => x.type === "run.finish_conflict");
  assert.ok(conflicts.length >= 1);
  e.close();
});

test("F10 illegal disposition is not resolved", async () => {
  for (const bad of ["done", "success", "protocol_error"]) {
    const e = engine(dir(), {
      chooseExecute: () => ({
        type: "tool_calls",
        calls: [{ name: "finish_step", arguments: { reason: bad, summary: "nope" } }],
      }),
    });
    e.config.max_execute_turns_per_run = 1;
    const spec = loadDemoSpec(`f10-${bad}`);
    e.createCampaign(spec);
    seedReadyStep(e, spec.campaign_id, "f10 step", `f10-${bad}`);
    const outcome = await e.runExecuteSlot(spec.campaign_id);
    assert.ok(outcome);
    assert.notEqual(outcome.reason, "resolved");
    assert.equal(e.storage.list("steps", spec.campaign_id)[0]!.status, "deferred");
    e.close();
  }
});

test("F11 resolved without evidence is rejected", async () => {
  const e = engine(dir(), {
    chooseExecute: () => ({
      type: "tool_calls",
      calls: [{ name: "finish_step", arguments: { disposition: "resolved", summary: "no refs", evidence_refs: [] } }],
    }),
  });
  e.config.max_execute_turns_per_run = 1;
  const spec = loadDemoSpec("f11");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f11 step", "f11-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.notEqual(outcome.reason, "resolved");
  assert.notEqual(e.storage.list("steps", spec.campaign_id)[0]!.status, "resolved");
  e.close();
});

test("F12 forged and cross-campaign evidence are rejected", async () => {
  let evidence = "obs_does_not_exist";
  const e = engine(dir(), {
    chooseExecute: () => ({
      type: "tool_calls",
      calls: [
        {
          name: "finish_step",
          arguments: { disposition: "resolved", summary: "bad evidence", evidence_refs: [evidence] },
        },
      ],
    }),
  });
  e.config.max_execute_turns_per_run = 1;
  const spec = loadDemoSpec("f12a");
  const other = loadDemoSpec("f12b");
  e.createCampaign(spec);
  e.createCampaign(other);
  const otherDecide = e.storage.claimDecide(other.campaign_id, "t")!;
  const foreign = e.storage.recordObservation({
    campaign_id: other.campaign_id,
    producer_id: "t",
    submission_id: "foreign",
    run_id: otherDecide.run_id,
    attempt_id: otherDecide.run_id,
    subject: "x",
    body: {},
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  seedReadyStep(e, spec.campaign_id, "f12 step", "f12-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.notEqual(outcome.reason, "resolved");

  evidence = foreign.canonical_ids.observation_id!;
  seedReadyStep(e, spec.campaign_id, "f12 step2", "f12-fp2");
  const out2 = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(out2);
  assert.notEqual(out2.reason, "resolved");
  e.close();
});

test("F13 blocked without blocked_on is rejected", async () => {
  const e = engine(dir(), {
    chooseExecute: () => ({
      type: "tool_calls",
      calls: [{ name: "finish_step", arguments: { disposition: "blocked", summary: "no field" } }],
    }),
  });
  e.config.max_execute_turns_per_run = 1;
  const spec = loadDemoSpec("f13");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f13 step", "f13-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.notEqual(outcome.reason, "blocked");
  assert.notEqual(e.storage.list("steps", spec.campaign_id)[0]!.status, "resolved");
  e.close();
});

test("F14 deferred without reopen_rule parks and is not reclaimed", async () => {
  const e = engine(dir(), {
    chooseExecute: () => ({
      type: "tool_calls",
      calls: [{ name: "finish_step", arguments: { disposition: "deferred", summary: "stuck" } }],
    }),
  });
  e.config.max_execute_turns_per_run = 1;
  const spec = loadDemoSpec("f14");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f14 step", "f14-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "deferred");
  const step = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.equal(step.status, "deferred");
  e.storage.recomputeStepReadiness(spec.campaign_id);
  assert.equal(await e.runExecuteSlot(spec.campaign_id), null);
  e.close();
});

test("F15 provider error does not Finalize or resolve", async () => {
  const e = engine(dir(), { chooseExecute: () => ({ type: "error", message: "upstream 500" }) });
  const spec = loadDemoSpec("f15");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f15 step", "f15-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "protocol_error");
  assert.equal(e.lastWorker?.finalizerModelSends ?? 0, 0);
  assert.notEqual(e.storage.list("steps", spec.campaign_id)[0]!.status, "resolved");
  e.close();
});

test("F16 provider abort does not Finalize; run cancelled", async () => {
  const e = engine(dir(), { chooseExecute: () => ({ type: "aborted", message: "cancel" }) });
  const spec = loadDemoSpec("f16");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f16 step", "f16-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "cancelled");
  assert.equal(e.lastWorker?.finalizerModelSends ?? 0, 0);
  e.close();
});

test("F17 deadline already past skips Finalize model request", async () => {
  let e: Engine;
  const spec = loadDemoSpec("f17");
  const chooseExecute: TurnChooser = () => {
    const camp = e.storage.getCampaign(spec.campaign_id);
    camp.spec.budget.deadline_ms = Date.now() - 1;
    e.storage.store.db.prepare("UPDATE campaigns SET spec_json = ? WHERE id = ?").run(JSON.stringify(camp.spec), spec.campaign_id);
    return { type: "text", text: "primary done" };
  };
  e = engine(dir(), { chooseExecute });
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f17 step", "f17-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.notEqual(outcome.reason, "resolved");
  assert.equal(e.lastWorker?.finalizerModelSends ?? 0, 0);
  assert.equal(e.lastWorker?.modelGateway?.modelSends, 1);
  e.close();
});

test("F18 unaffordable Finalize is budget and non-negative buckets", async () => {
  const e = engine(dir(), { chooseExecute: () => ({ type: "text", text: "stop" }) });
  const spec = loadDemoSpec("f18");
  spec.budget.max_calls = 1;
  spec.budget.max_tokens = null;
  spec.budget.max_cost_micro = null;
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f18 step", "f18-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "budget");
  assert.equal(e.lastWorker?.finalizerModelSends ?? 0, 0);
  const snap = e.budget.snapshot(spec.campaign_id);
  assert.ok(Number(snap.free_calls) >= 0);
  assert.ok(Number(snap.reserved_calls) >= 0);
  assert.ok(Number(snap.liability_calls) >= 0);
  assert.ok(Number(snap.spent_calls) >= 0);
  e.close();
});

test("F19 stale fence finish is rejected", async () => {
  let e: Engine;
  const spec = loadDemoSpec("f19");
  const chooseExecute: TurnChooser = () => {
    e.storage.store.db.prepare("UPDATE task_runs SET fence = fence + 1 WHERE campaign_id = ? AND mode = 'execute'").run(spec.campaign_id);
    return {
      type: "tool_calls",
      calls: [{ name: "finish_step", arguments: { disposition: "deferred", summary: "stale", next_action: "no" } }],
    };
  };
  e = engine(dir(), { chooseExecute });
  e.config.max_execute_turns_per_run = 1;
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f19 step", "f19-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.notEqual(outcome.reason, "resolved");
  assert.notEqual(e.storage.list("steps", spec.campaign_id)[0]!.status, "resolved");
  e.close();
});

test("F20 uncertain external effect is not Finalize-resolved", async () => {
  let e: Engine;
  const spec = loadDemoSpec("f20");
  const chooseExecute: TurnChooser = (ctx) => {
    const text = userText(ctx.messages[0] as { role?: string; content?: unknown });
    let runId: string | undefined;
    try {
      runId = (JSON.parse(text) as { run_id?: string }).run_id;
    } catch {
      runId = undefined;
    }
    if (runId) {
      const inv = e.invocations.prepare({
        campaign_id: spec.campaign_id,
        run_id: runId,
        kind: "tool",
        purpose: "world_act",
        fence: 1,
        cancel_epoch: 0,
        effect_class: "unknown",
        reserved_calls: 1,
      });
      e.invocations.mark(inv.id, "uncertain");
    }
    return { type: "text", text: "stop with uncertain" };
  };
  e = engine(dir(), { chooseExecute });
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f20 step", "f20-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.notEqual(outcome.reason, "resolved");
  assert.equal(e.lastWorker?.finalizerModelSends ?? 0, 0);
  e.close();
});

test("F26 incomplete step is not reclaimed in the same cycle", async () => {
  const e = engine(dir(), { chooseExecute: () => ({ type: "text", text: "no finish" }) });
  const spec = loadDemoSpec("f26");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f26 step", "f26-fp");
  const first = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(first);
  assert.equal(first.reason, "incomplete_protocol");
  const stepId = first.step_id!;
  e.storage.recomputeStepReadiness(spec.campaign_id);
  const second = await e.runExecuteSlot(spec.campaign_id);
  assert.equal(second, null);
  const step = e.storage.store.db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
  assert.equal(step.status, "deferred");
  const runs = e.storage.store.db
    .prepare("SELECT COUNT(*) AS c FROM task_runs WHERE step_id = ? AND mode = 'execute'")
    .get(stepId) as { c: number };
  assert.equal(Number(runs.c), 1);
  e.close();
});

test("F27 incomplete keeps observations for a later Decide pack", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return { type: "text", text: "finalize miss" };
    }
    if (!toolResultNames(ctx.messages).includes("submit_observation")) {
      return {
        type: "tool_calls",
        calls: [{ name: "submit_observation", arguments: { subject: "f27-keep", body: { keep: true } } }],
      };
    }
    return { type: "text", text: "stop" };
  };
  const e = engine(dir(), { chooseExecute });
  e.config.max_execute_turns_per_run = 2;
  const spec = loadDemoSpec("f27");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f27 step", "f27-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "incomplete_protocol");
  assert.ok(outcome.observation_ids.length >= 1);
  const obsId = outcome.observation_ids[0]!;
  const rows = e.storage.list("observations", spec.campaign_id);
  assert.ok(rows.some((r) => r.id === obsId && r.subject === "f27-keep"));
  const pack = buildContextPack(e.storage, {
    run_id: "preview-f27",
    campaign_id: spec.campaign_id,
    step_id: outcome.step_id,
    mode: "decide",
    kind: "decide",
    attempt_no: 1,
    fence: 1,
    cancel_epoch: 0,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "f27",
    continuation_of: outcome.run_id,
  });
  assert.ok(JSON.stringify(pack.user_payload).includes(obsId));
  e.close();
});

test("finalization rates match underlying counters", async () => {
  const e = engine(dir(), { chooseExecute: legalResolvedChooser() });
  const spec = loadDemoSpec("rates-primary");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "rates step", "rates-fp");
  await e.runExecuteSlot(spec.campaign_id);
  const st = e.status(spec.campaign_id);
  const fin = st.finalization as {
    execute_runs_total: number;
    finish_primary_total: number;
    primary_finish_rate: number | null;
    protocol_complete_rate: number | null;
  };
  assert.equal(fin.execute_runs_total, 1);
  assert.equal(fin.finish_primary_total, 1);
  assert.equal(fin.primary_finish_rate, 1);
  assert.equal(fin.protocol_complete_rate, 1);
  e.close();
});

test("F28 incomplete does not complete coverage finding or step", async () => {
  const e = engine(dir(), { chooseExecute: () => ({ type: "text", text: "nope" }) });
  const spec = loadDemoSpec("f28");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f28 step", "f28-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "incomplete_protocol");
  const step = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.notEqual(step.status, "resolved");
  const coverage = e.storage.list("coverage_items", spec.campaign_id);
  assert.equal(
    coverage.every((c) => c.execution_state !== "tested"),
    true,
  );
  const findings = e.storage.list("findings", spec.campaign_id);
  assert.equal(
    findings.every((f) => f.status !== "confirmed"),
    true,
  );
  e.close();
});

test("F29 Finalizer deferred reopen_rule=never is not reclaimed", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "finish_step",
            arguments: {
              disposition: "deferred",
              summary: "try later",
              next_action: "try 34",
              reopen_rule: { kind: "never" },
            },
          },
        ],
      };
    }
    return { type: "text", text: "stop" };
  };
  const e = engine(dir(), { chooseExecute });
  const spec = loadDemoSpec("f29");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f29 step", "f29-fp");
  const first = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(first);
  assert.equal(first.reason, "deferred");
  const step = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.equal(step.status, "deferred");
  assert.equal(step.next_action, "try 34");
  const ckpt = e.storage.latestCheckpoint(spec.campaign_id, { runId: first.run_id, stepId: String(step.id) });
  assert.ok(ckpt);
  assert.equal(ckpt.next, "try 34");
  e.storage.recomputeStepReadiness(spec.campaign_id);
  assert.equal(await e.runExecuteSlot(spec.campaign_id), null);
  e.close();
});

test("F30 blocked reopen_rule=fact_key waits for the fact", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "finish_step",
            arguments: {
              disposition: "blocked",
              summary: "need key",
              blocked_on: "has_key",
              reopen_rule: { kind: "fact_key", key: "has_key" },
            },
          },
        ],
      };
    }
    return { type: "text", text: "stop" };
  };
  const e = engine(dir(), { chooseExecute });
  const spec = loadDemoSpec("f30");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f30 step", "f30-fp");
  const first = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(first);
  assert.equal(first.reason, "blocked");
  e.storage.recomputeStepReadiness(spec.campaign_id);
  assert.equal(await e.runExecuteSlot(spec.campaign_id), null);
  const decide = e.storage.claimDecide(spec.campaign_id, "fact")!;
  const obs = e.storage.recordObservation({
    campaign_id: spec.campaign_id,
    producer_id: "fact",
    submission_id: "key-obs",
    run_id: decide.run_id,
    attempt_id: decide.run_id,
    subject: "key",
    body: { has_key: true },
    artifact_refs: [],
    conditions: {},
    env_rev: "env-1",
  });
  e.storage.submitFact({
    campaign_id: spec.campaign_id,
    producer_id: "fact",
    submission_id: "has-key",
    run_id: decide.run_id,
    proposition: "has key",
    fact_key: "has_key",
    support_refs: [obs.canonical_ids.observation_id!],
    conditions: {},
    source_grade: "observed",
  });
  e.storage.finishRun(spec.campaign_id, decide.run_id, {
    run_id: decide.run_id,
    step_id: null,
    mode: "decide",
    reason: "resolved",
    summary: "fact",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  e.storage.recomputeStepReadiness(spec.campaign_id);
  const second = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(second);
  e.close();
});

test("F31 expired run A cannot finishRun over run B", async () => {
  const e = engine(dir(), { chooseExecute: () => ({ type: "text", text: "idle" }) });
  const spec = loadDemoSpec("f31");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f31 step", "f31-fp");
  const a = e.storage.claimNextStep(spec.campaign_id, "owner-a", 1)!;
  e.storage.store.db.prepare("UPDATE task_runs SET deadline_ms = 0 WHERE id = ?").run(a.run_id);
  e.storage.recoverStaleRuns(spec.campaign_id);
  const b = e.storage.claimNextStep(spec.campaign_id, "owner-b", 1)!;
  assert.ok(b);
  assert.notEqual(b.run_id, a.run_id);
  const late = e.storage.finishRun(spec.campaign_id, a.run_id, {
    run_id: a.run_id,
    step_id: a.step_id,
    mode: "execute",
    reason: "resolved",
    summary: "stale win",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: true,
    protocol_error: null,
  });
  assert.equal(late.applied, false);
  const step = e.storage.store.db.prepare("SELECT status, active_run_id FROM steps WHERE id = ?").get(b.step_id) as {
    status: string;
    active_run_id: string;
  };
  assert.equal(step.status, "running");
  assert.equal(step.active_run_id, b.run_id);
  const camp = e.storage.store.db
    .prepare("SELECT execute_lock_owner, execute_run_id FROM campaigns WHERE id = ?")
    .get(spec.campaign_id) as { execute_lock_owner: string; execute_run_id: string };
  assert.equal(camp.execute_lock_owner, "owner-b");
  assert.equal(camp.execute_run_id, b.run_id);
  assert.equal(e.storage.getRun(a.run_id).state, "lease_expired");
  e.close();
});

test("F32 F33 F34 Finalizer reserves 12800 tokens, thinking low, forced tool", async () => {
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      return {
        type: "tool_calls",
        calls: [
          {
            name: "finish_step",
            arguments: { disposition: "deferred", summary: "cap", reopen_rule: { kind: "never" } },
          },
        ],
      };
    }
    return { type: "text", text: "natural" };
  };
  const e = engine(dir(), { chooseExecute });
  const spec = loadDemoSpec("f32");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f32 step", "f32-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  const call = e.lastWorker?.modelGateway?.lastCall;
  assert.ok(call);
  assert.equal(call.purpose, "execute_finalize");
  assert.equal(call.reserved_tokens, 12800);
  assert.equal(call.max_tokens, 12800);
  assert.equal(call.thinking_level, "low");
  assert.equal(call.force_tool, "finish_step");
  e.close();
});

test("F35 CLI --finalization and env actually start Finalize", async () => {
  const chooseExecute: TurnChooser = () => ({ type: "text", text: "no finish" });
  const cfg = applyFinalizationFlags(makeRuntimeConfig(dir()), { finalization: true }, {});
  assert.equal(cfg.finalization.enabled, true);
  const e = new Engine(cfg, { silent: true, maxCycles: 2, chooseExecute });
  const spec = loadDemoSpec("f35");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f35 step", "f35-fp");
  await e.runExecuteSlot(spec.campaign_id);
  const started = e.storage.list("events", spec.campaign_id).filter((x) => x.type === "run.finalization_started");
  assert.equal(started.length, 1);
  e.close();
});

test("F36 --no-finalization natural stop stays incomplete_protocol", async () => {
  const chooseExecute: TurnChooser = () => ({ type: "text", text: "no finish" });
  const cfg = applyFinalizationFlags(makeRuntimeConfig(dir()), { "no-finalization": true }, {});
  assert.equal(cfg.finalization.enabled, false);
  const e = new Engine(cfg, { silent: true, maxCycles: 2, chooseExecute });
  const spec = loadDemoSpec("f36");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f36 step", "f36-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "incomplete_protocol");
  assert.equal(e.lastWorker?.finalizerModelSends ?? 0, 0);
  const started = e.storage.list("events", spec.campaign_id).filter((x) => x.type === "run.finalization_started");
  assert.equal(started.length, 0);
  e.close();
});

test("F37 RIONEXT_FINALIZATION=0 skips Finalize", async () => {
  const chooseExecute: TurnChooser = () => ({ type: "text", text: "no finish" });
  const cfg = applyFinalizationFlags(makeRuntimeConfig(dir()), {}, { RIONEXT_FINALIZATION: "0" } as NodeJS.ProcessEnv);
  assert.equal(cfg.finalization.enabled, false);
  const e = new Engine(cfg, { silent: true, maxCycles: 2, chooseExecute });
  const spec = loadDemoSpec("f37");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f37 step", "f37-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  assert.equal(outcome.reason, "incomplete_protocol");
  const started = e.storage.list("events", spec.campaign_id).filter((x) => x.type === "run.finalization_started");
  assert.equal(started.length, 0);
  e.close();
});

test("deferred with next_action and no reopen_rule redispatches next cycle", async () => {
  let seenNextAction: string | null = null;
  let seenCheckpointNext: string | null = null;
  const chooseExecute: TurnChooser = (ctx) => {
    const raw = userText(ctx.messages[0] as { role?: string; content?: unknown });
    try {
      const payload = JSON.parse(raw) as {
        checkpoint?: { next?: string | null };
        current_step?: { next_action?: string | null };
      };
      if (typeof payload.current_step?.next_action === "string" && payload.current_step.next_action.length > 0) {
        seenNextAction = payload.current_step.next_action;
      }
      if (typeof payload.checkpoint?.next === "string" && payload.checkpoint.next.length > 0) {
        seenCheckpointNext = payload.checkpoint.next;
      }
    } catch {
      // primary prompt is JSON; ignore parse failures
    }
    return {
      type: "tool_calls",
      calls: [
        {
          name: "finish_step",
          arguments: { disposition: "deferred", summary: "33 failed", next_action: "try 34" },
        },
      ],
    };
  };
  const e = engine(dir(), { chooseExecute });
  const spec = loadDemoSpec("deferred-always");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "pad step", "pad-fp");
  const first = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(first);
  assert.equal(first.reason, "deferred");
  const afterFirst = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.deepEqual(JSON.parse(String(afterFirst.reopen_rule_json)), { kind: "always" });
  assert.equal(afterFirst.next_action, "try 34");
  assert.equal(afterFirst.status, "deferred");
  e.storage.recomputeStepReadiness(spec.campaign_id);
  assert.equal(e.storage.list("steps", spec.campaign_id)[0]!.status, "ready");
  const second = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(second);
  const executeRuns = e.storage.list("task_runs", spec.campaign_id).filter((r) => r.mode === "execute");
  assert.equal(executeRuns.length, 2);
  const attempts = executeRuns.map((r) => Number(r.attempt_no)).sort((a, b) => a - b);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(seenNextAction, "try 34");
  assert.equal(seenCheckpointNext, "try 34");
  e.close();
});

test("repeating deferred + next_action stops at MAX_STEP_ATTEMPTS", async () => {
  const e = engine(dir(), {
    chooseExecute: () => ({
      type: "tool_calls",
      calls: [
        {
          name: "finish_step",
          arguments: {
            disposition: "deferred",
            summary: "try next value",
            next_action: "change parameter",
          },
        },
      ],
    }),
  });
  const spec = loadDemoSpec("attempt-cap");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "cap step", "cap-fp");
  const outcomes = [];
  for (let i = 0; i < MAX_STEP_ATTEMPTS + 3; i++) {
    const outcome = await e.runExecuteSlot(spec.campaign_id);
    if (!outcome) break;
    outcomes.push(outcome);
  }
  assert.equal(outcomes.length, MAX_STEP_ATTEMPTS);
  const executeRuns = e.storage.list("task_runs", spec.campaign_id).filter((r) => r.mode === "execute");
  assert.equal(executeRuns.length, MAX_STEP_ATTEMPTS);
  assert.equal(await e.runExecuteSlot(spec.campaign_id), null);
  e.close();
});



test("F38 a provider failure parks the step retryable instead of sealing it", async () => {
  const e = engine(dir(), { chooseExecute: () => ({ type: "error", message: "upstream 500" }) });
  const spec = loadDemoSpec("f38");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f38 step", "f38-fp");
  const first = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(first);
  assert.equal(first.reason, "protocol_error");
  const parked = e.storage.list("steps", spec.campaign_id)[0]!;
  assert.equal(parked.status, "deferred");
  assert.equal(parked.reopen_rule_json, JSON.stringify({ kind: "always" }), "a framework park must not seal the step");
  // The door stays open: recompute re-readies it and a second attempt happens.
  e.storage.recomputeStepReadiness(spec.campaign_id);
  const second = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(second, "the step is claimable again after a transient park");
  assert.equal(Number(e.storage.list("steps", spec.campaign_id)[0]!.attempt_count), 2);
  e.close();
});

test("F39 a frontier emptied by provider errors is requeued instead of idling", async () => {
  let e: Engine;
  const spec = loadDemoSpec("f39");
  const chooseExecute: TurnChooser = (ctx) => {
    const toolNames = (ctx.tools ?? []).map((t) => t.name);
    if (toolNames.length === 1 && toolNames[0] === "finish_step") {
      const ids = e.storage.list("observations", spec.campaign_id).map((o) => String(o.id));
      return {
        type: "tool_calls",
        calls: [{ name: "finish_step", arguments: { disposition: "resolved", summary: "requeued and finished", evidence_refs: ids } }],
      };
    }
    if (!toolResultNames(ctx.messages).includes("submit_observation")) {
      return {
        type: "tool_calls",
        calls: [{ name: "submit_observation", arguments: { subject: "f39", body: { n: 1 } } }],
      };
    }
    return { type: "text", text: "stopping without finish" };
  };
  e = engine(dir(), { chooseExecute });
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f39 step", "f39-fp");
  e.storage.setCampaignState(spec.campaign_id, "active", { kind: "user", id: "t" });
  const stepId = String(e.storage.list("steps", spec.campaign_id)[0]!.id);
  // Simulate a step parked by a pre-fix provider failure: deferred, sealed, dead.
  e.storage.store.db
    .prepare("UPDATE steps SET status = 'deferred', last_failure = 'primary_stop:model_error', reopen_rule_json = ? WHERE id = ?")
    .run(JSON.stringify({ kind: "never" }), stepId);
  await e.runLoop(spec.campaign_id);
  const runs = e.storage.store.db
    .prepare("SELECT COUNT(*) AS c FROM task_runs WHERE step_id = ? AND mode = 'execute'")
    .get(stepId) as { c: number };
  assert.ok(Number(runs.c) >= 1, "the campaign ran the requeued step instead of idling out");
  const step = e.storage.store.db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
  assert.equal(step.status, "resolved");
  e.close();
});

test("F40 the provider failure reason is persisted on the run and its event", async () => {
  const e = engine(dir(), { chooseExecute: () => ({ type: "error", message: "upstream 500" }) });
  const spec = loadDemoSpec("f40");
  e.createCampaign(spec);
  seedReadyStep(e, spec.campaign_id, "f40 step", "f40-fp");
  const outcome = await e.runExecuteSlot(spec.campaign_id);
  assert.ok(outcome);
  const run = e.storage.getRun(outcome.run_id);
  assert.equal(run.primary_stop_trigger, "model_error");
  assert.match(String(run.last_error), /upstream 500/);
  const ev = e.storage.store.db
    .prepare("SELECT payload_json FROM events WHERE campaign_id = ? AND type = 'run.primary_stopped' ORDER BY seq DESC LIMIT 1")
    .get(spec.campaign_id) as { payload_json: string };
  assert.match(ev.payload_json, /upstream 500/);
  e.close();
});
