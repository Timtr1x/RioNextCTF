import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import type { TurnChooser } from "../../src/runtime/pi/scripted-stream.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-sched-"));
}

function toolNamesCalled(messages: unknown[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; toolName?: string; content?: unknown };
    if (msg.role === "toolResult" && typeof msg.toolName === "string") out.push(msg.toolName);
  }
  return out;
}

/** Decide that commits an empty review (propose_plan []), then finishes. */
function makeNoChangeDecide(onFirstTurn: () => void): TurnChooser {
  return (ctx) => {
    const called = toolNamesCalled(ctx.messages);
    if (called.includes("propose_plan") && !called.includes("finish_decision")) {
      return { type: "tool_calls", calls: [{ name: "finish_decision", arguments: { summary: "plan still fits" } }] };
    }
    if (called.includes("finish_decision")) return { type: "text", text: "done" };
    onFirstTurn();
    return { type: "tool_calls", calls: [{ name: "propose_plan", arguments: { operations: [], no_change_reason: "no change" } }] };
  };
}

test("S01: a new observation triggers Decide even while a ready step exists", async () => {
  const dir = tmp();
  let decideCalls = 0;
  let observedOnce = false;
  const e = new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 8,
    chooseDecide: makeNoChangeDecide(() => {
      decideCalls += 1;
    }),
    chooseExecute: (ctx) => {
      const called = toolNamesCalled(ctx.messages);
      if (called.includes("finish_step")) return { type: "text", text: "done" };
      if (!observedOnce && !called.includes("submit_observation")) {
        return { type: "tool_calls", calls: [{ name: "submit_observation", arguments: { subject: "probe", body: { note: "fresh evidence" } } }] };
      }
      observedOnce = true;
      if (called.includes("submit_observation")) {
        return {
          type: "tool_calls",
          calls: [
            {
              name: "finish_step",
              arguments: { disposition: "deferred", summary: "partial", next_action: "continue", reopen_rule: { kind: "always" } },
            },
          ],
        };
      }
      return {
        type: "tool_calls",
        calls: [{ name: "finish_step", arguments: { disposition: "resolved", summary: "done", evidence_refs: [] } }],
      };
    },
  });
  const spec = loadDemoSpec("sched-s01");
  e.createCampaign(spec);
  await e.start("sched-s01");
  // cycle 0 decides because i===0; the observation marks requested; cycle 1 must
  // decide again even though the deferred step is ready again.
  assert.ok(decideCalls >= 2, `expected Decide to re-run on new input, got ${decideCalls}`);
  e.close();
});

test("S09: a hint arriving mid-Decide stays unreviewed after the commit", async () => {
  const dir = tmp();
  let decideCalls = 0;
  let hintSeq = 0;
  let hintInjected = false;
  const e = new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 6,
    chooseDecide: makeNoChangeDecide(() => {
      decideCalls += 1;
      if (!hintInjected) {
        hintInjected = true;
        // injected after the pack (and its snapshot seq H) was built
        e.hint("sched-s09", "mid-run hint: switch focus");
        // markRequested pins requested_seq to the hint's event seq
        hintSeq = e.storage.getCampaign("sched-s09").requested_seq;
      }
    }),
    chooseExecute: () => ({ type: "text", text: "nothing to do" }),
  });
  const spec = loadDemoSpec("sched-s09");
  e.createCampaign(spec);
  await e.start("sched-s09");
  const runs = e.storage.store.db
    .prepare("SELECT reviewed_seq FROM decision_runs WHERE campaign_id = ? AND committed = 1 ORDER BY rowid")
    .all("sched-s09") as { reviewed_seq: number | null }[];
  assert.ok(hintSeq > 0, "hint recorded");
  assert.ok(runs.length >= 1, "at least one committed decide");
  // the first commit only confirms the snapshot H taken before the hint arrived
  assert.ok(
    runs[0]!.reviewed_seq !== null && runs[0]!.reviewed_seq < hintSeq,
    `first commit reviewed ${runs[0]!.reviewed_seq}, hint at ${hintSeq}`,
  );
  // and the loop notices the unreviewed hint and decides again
  assert.ok(decideCalls >= 2, `expected a second Decide for the mid-run hint, got ${decideCalls}`);
  e.close();
});
