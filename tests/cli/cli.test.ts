import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HELP, parseArgs, resolveCampaignId } from "../../src/cli/args.ts";
import { applyExecuteLimitFlags, applyFinalizationFlags, makeRuntimeConfig } from "../../src/contracts/config.ts";
import { formatList, formatProgress, formatStatus, formatVerify } from "../../src/cli/format.ts";

test("parseArgs ? is help and help provider is a topic", () => {
  const q = parseArgs(["?"]);
  assert.equal(q.cmd, "help");
  const topic = parseArgs(["?", "provider"]);
  assert.equal(topic.cmd, "help");
  assert.deepEqual(topic.positional, ["provider"]);
  const flag = parseArgs(["--?"]);
  assert.equal(flag.flags.help, true);
});

test("parseArgs treats accept/reject as commands and keeps positional id", () => {
  const a = parseArgs(["accept", "camp_x"]);
  assert.equal(a.cmd, "accept");
  assert.deepEqual(a.positional, ["camp_x"]);
  const r = parseArgs(["reject", "camp_x", "--text", "flag不正确", "--continue"]);
  assert.equal(r.cmd, "reject");
  assert.equal(r.flags.text, "flag不正确");
  assert.equal(r.flags.continue, true);
  const old = parseArgs(["campaign", "verify-goal", "--id", "camp_x", "--reject"]);
  assert.equal(old.cmd, "verify-goal");
  assert.equal(old.flags.id, "camp_x");
  assert.equal(old.flags.reject, true);
});

test("resolveCampaignId uses the only campaign or demands an id", () => {
  assert.equal(resolveCampaignId({}, [], [{ id: "only", state: "active" }]), "only");
  assert.equal(resolveCampaignId({}, ["camp_a"], [{ id: "camp_a", state: "active" }, { id: "camp_b", state: "paused" }]), "camp_a");
  assert.throws(() => resolveCampaignId({}, [], []), /no campaigns/);
  assert.throws(() => resolveCampaignId({}, [], [{ id: "a", state: "active" }, { id: "b", state: "active" }]), /multiple campaigns/);
});

test("formatStatus shows pending flag and accept/reject commands", () => {
  const text = formatStatus({
    campaign_id: "camp_x",
    state: "awaiting_verify",
    pending_goal_claim: { id: "f1", proposition: "CTF2{abc}", fact_key: "flag_recovered" },
    budget: { spent_calls: 40, total_calls: 120, free_calls: 80, spent_tokens: 12, total_tokens: 800000 },
    candidates_ready: 1,
  });
  assert.match(text, /awaiting_verify/);
  assert.match(text, /CTF2\{abc\}/);
  assert.match(text, /rionext accept camp_x/);
  assert.match(text, /rionext reject camp_x/);
});

test("formatList and formatVerify are operator text, not JSON", () => {
  const list = formatList([
    { id: "camp_a", state: "active", updated_at: "t", pending_goal_claim: null },
    {
      id: "camp_b",
      state: "awaiting_verify",
      updated_at: "t",
      pending_goal_claim: { id: "f", proposition: "CTF2{x}", fact_key: "flag_recovered" },
    },
  ]);
  assert.match(list, /camp_b/);
  assert.match(list, /pending CTF2\{x\}/);
  const acc = formatVerify({ state: "completed", proposition: "CTF2{x}" }, "camp_b", true);
  assert.match(acc, /accepted/);
  const rej = formatVerify({ state: "active", proposition: "CTF2{x}" }, "camp_b", false);
  assert.match(rej, /rejected/);
  assert.match(rej, /rionext start camp_b/);
});

test("CLI help documents default-on Finalize and the off switch", () => {
  assert.match(HELP, /rionext \?/);
  assert.match(HELP, /Finalize is on by default/);
  assert.match(HELP, /--no-finalization/);
  assert.match(HELP, /RIONEXT_FINALIZATION=0/);
  assert.match(HELP, /--finalization/);
  assert.match(HELP, /RIONEXT_FINALIZATION=1/);
  assert.match(HELP, /run --url/);
  assert.match(HELP, /provider list\|show\|add\|set\|key\|rm/);
  assert.match(HELP, /72 model turns/);
  assert.match(HELP, /120_000_000 tokens/);
});

test("ops.md documents default-on Finalize and the off switch", () => {
  const ops = readFileSync(join(process.cwd(), "docs/ops.md"), "utf8");
  assert.match(ops, /finalization\.enabled=true/);
  assert.match(ops, /--no-finalization/);
  assert.match(ops, /RIONEXT_FINALIZATION=0/);
  assert.match(ops, /--finalization/);
  assert.match(ops, /RIONEXT_FINALIZATION=1/);
});

test("parseArgs --finalization and RIONEXT_FINALIZATION enable the switch", () => {
  const parsed = parseArgs(["run", "--spec", "x.json", "--finalization"]);
  assert.equal(parsed.flags.finalization, true);
  const cfg = applyFinalizationFlags(makeRuntimeConfig("C:/tmp/rionext-fin"), parsed.flags, {});
  assert.equal(cfg.finalization.enabled, true);
  const envOn = applyFinalizationFlags(makeRuntimeConfig("C:/tmp/rionext-fin3"), {}, { RIONEXT_FINALIZATION: "1" } as NodeJS.ProcessEnv);
  assert.equal(envOn.finalization.enabled, true);
});

test("parseArgs --no-finalization and RIONEXT_FINALIZATION=0 disable Finalize", () => {
  const parsed = parseArgs(["run", "--spec", "x.json", "--no-finalization"]);
  assert.equal(parsed.flags["no-finalization"], true);
  const off = applyFinalizationFlags(makeRuntimeConfig("C:/tmp/rionext-fin-off"), parsed.flags, {});
  assert.equal(off.finalization.enabled, false);
  const envOff = applyFinalizationFlags(makeRuntimeConfig("C:/tmp/rionext-fin-env0"), {}, { RIONEXT_FINALIZATION: "0" } as NodeJS.ProcessEnv);
  assert.equal(envOff.finalization.enabled, false);
});

test("parseArgs treats a bare URL as run --url", () => {
  const a = parseArgs(["http://cd60aefe0490ac8ad594d643.http-ctf2.dasctf.com/"]);
  assert.equal(a.cmd, "run");
  assert.equal(a.flags.url, "http://cd60aefe0490ac8ad594d643.http-ctf2.dasctf.com/");
  const b = parseArgs(["run", "--url", "https://lab.example/"]);
  assert.equal(b.cmd, "run");
  assert.equal(b.flags.url, "https://lab.example/");
});

test("parseArgs --max-execute-turns and --max-tool-calls", () => {
  const parsed = parseArgs(["run", "--spec", "x.json", "--max-execute-turns", "36", "--max-tool-calls", "72"]);
  assert.equal(parsed.flags["max-execute-turns"], "36");
  assert.equal(parsed.flags["max-tool-calls"], "72");
  const cfg = applyExecuteLimitFlags(makeRuntimeConfig("C:/tmp/rionext-turns"), parsed.flags);
  assert.equal(cfg.max_execute_turns_per_run, 36);
  assert.equal(cfg.max_tool_calls_per_run, 72);
});

test("CLI --finalization and --no-finalization together conflict", () => {
  const parsed = parseArgs(["run", "--spec", "x.json", "--finalization", "--no-finalization"]);
  assert.equal(parsed.flags.finalization, true);
  assert.equal(parsed.flags["no-finalization"], true);
  assert.throws(
    () => applyFinalizationFlags(makeRuntimeConfig("C:/tmp/rionext-fin-conflict"), parsed.flags, {}),
    (err: Error & { code?: string }) =>
      err.code === "finalization_flag_conflict" && /cannot be used together/.test(err.message),
  );
});

test("formatProgress prints budget and recent calls", () => {
  const text = formatProgress(
    "2026-09-03T04:02:05.000Z",
    {
      campaign_id: "camp_x",
      state: "active",
      budget: { spent_calls: 78, total_calls: 1000, spent_tokens: 894472, total_tokens: 10000000 },
      active_run: { id: "run_1", mode: "execute", state: "running" },
    },
    [
      { created_at: "2026-09-03T04:00:11.000Z", kind: "model", purpose: "execute", state: "completed", actual_tokens: 57707, status: "toolUse" },
      { created_at: "2026-09-03T03:59:23.000Z", kind: "tool", purpose: "kali_run", state: "completed", actual_tokens: 0, status: null },
      { created_at: "2026-09-03T03:57:43.000Z", kind: "model", purpose: "execute", state: "failed_known", actual_tokens: 12, status: "timeout" },
    ],
  );
  assert.match(text, /04:02:05/);
  assert.match(text, /calls 78\/1000/);
  assert.match(text, /execute running/);
  assert.match(text, /model execute completed 57707 tok/);
  assert.match(text, /kali_run completed/);
  assert.match(text, /timeout/);
});
