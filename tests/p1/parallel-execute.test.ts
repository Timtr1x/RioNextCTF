import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { buildKaliFlagSpec } from "../../src/domain/quick-spec.ts";
import type { DockerExecResult, DockerRunOpts } from "../../src/tools/docker-cli.ts";
import type { TurnChooser } from "../../src/runtime/pi/scripted-stream.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-par-"));
}

const OK: DockerExecResult = { stdout: "ok", stderr: "", code: 0, timedOut: false };

/**
 * Holds the FIRST foreground exec until a second one arrives. If the engine
 * ran serially, the first would wait forever, so a quick pass proves overlap.
 */
class RunGateDocker {
  calls: string[][] = [];
  runDirs: string[] = [];
  overlap = false;
  armed = false; // only gate when the test wants the rendezvous
  private waiter: (() => void) | null = null;

  run(argv: string[], _opts?: DockerRunOpts): DockerExecResult {
    this.calls.push([...argv]);
    return OK;
  }

  async runAsync(argv: string[], _opts?: DockerRunOpts): Promise<DockerExecResult> {
    this.calls.push([...argv]);
    if (argv[0] === "image") return { ...OK, stdout: "sha256:fake\n" };
    if (argv[0] === "inspect" && argv.some((a) => a.includes("Config.Labels"))) return { ...OK, stdout: '{"rionext.from":"master"}' };
    if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) return { ...OK, stdout: "true\n" };
    if (argv[0] === "exec" && argv[1] === "-w" && !argv.includes("-d")) {
      this.runDirs.push(String(argv[2]));
      if (this.armed) {
        if (this.runDirs.length === 1) {
          await new Promise<void>((r) => (this.waiter = r));
        } else {
          this.overlap = true;
          this.waiter?.();
        }
      }
    }
    return OK;
  }
}

function toolNamesCalled(messages: unknown[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; toolName?: string };
    if (msg.role === "toolResult" && typeof msg.toolName === "string") out.push(msg.toolName);
  }
  return out;
}

function executeTurnFor(getEngine: () => Engine, campaignId: string): TurnChooser {
  return (ctx) => {
    const called = toolNamesCalled(ctx.messages);
    if (called.includes("finish_step")) return { type: "text", text: "done" };
    if (called.includes("kali_run")) {
      const obs = getEngine().storage.list("observations", campaignId);
      const last = obs[obs.length - 1];
      return {
        type: "tool_calls",
        calls: [
          { name: "finish_step", arguments: { disposition: "resolved", summary: "done", evidence_refs: last ? [String(last.id)] : [] } },
        ],
      };
    }
    return { type: "tool_calls", calls: [{ name: "kali_run", arguments: { kind: "kali", bin: "cat", args: ["readme"] } }] };
  };
}

const SPEC_ID = "camp_lab-example"; // buildKaliFlagSpec derives it from the URL

test("M01+M03+M10: two kali fragments overlap, each in its own run dir", async () => {
  const dir = tmp();
  const docker = new RunGateDocker();
  docker.armed = true;
  const cfg = makeRuntimeConfig(dir);
  cfg.max_concurrent_execute = 2;
  let e!: Engine;
  e = new Engine(cfg, {
    silent: true,
    maxCycles: 30,
    pollWaitMs: 30,
    chooseDecide: () => ({ type: "text", text: "no plan changes" }),
    chooseExecute: executeTurnFor(() => e, SPEC_ID),
    dockerCli: docker as never,
    kaliResolve: () => ["10.6.6.6"],
  });
  const spec = buildKaliFlagSpec({ url: "http://lab.example/", provider: "prv_test", model: "m" });
  spec.execution_policy = { max_execute_workers: 2 };
  e.createCampaign(spec);
  e.storage.setCampaignState(spec.campaign_id, "active", { kind: "user", id: "t" });
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  for (let i = 0; i < 2; i++) {
    e.storage.proposeStepDirect({
      campaign_id: spec.campaign_id,
      producer_id: "t",
      submission_id: `seed-${i}`,
      question: `read readme ${i}`,
      kind: "explore",
      goal_refs: [root],
      preconditions: { op: "all", of: [] },
      method_family: "generic",
      expected_observations: [],
      completion_criteria: "done",
      fingerprint: `par-kali-fp-${i}`,
      reopen_rule: { kind: "never" },
    });
  }
  await e.start(spec.campaign_id);
  assert.equal(docker.overlap, true, "the second exec released the first: genuine overlap");
  // each run got its own private working directory
  assert.equal(new Set(docker.runDirs).size, 2, JSON.stringify(docker.runDirs));
  assert.ok(docker.runDirs.every((d) => /\/runs\/run_/.test(d)), JSON.stringify(docker.runDirs));
  const runs = e.storage.store.db
    .prepare("SELECT id, end_reason FROM task_runs WHERE campaign_id = ? AND mode = 'execute' ORDER BY created_at")
    .all(spec.campaign_id) as { id: string; end_reason: string | null }[];
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.end_reason === "resolved"), JSON.stringify(runs));
  const st = e.status(spec.campaign_id);
  assert.ok(Array.isArray(st.active_runs));
  e.close();
});

test("legacy campaigns still run one fragment at a time", async () => {
  const dir = tmp();
  const docker = new RunGateDocker();
  let e!: Engine;
  e = new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 30,
    pollWaitMs: 30,
    chooseDecide: () => ({ type: "text", text: "no plan changes" }),
    chooseExecute: executeTurnFor(() => e, SPEC_ID),
    dockerCli: docker as never,
    kaliResolve: () => ["10.6.6.6"],
  });
  const spec = buildKaliFlagSpec({ url: "http://lab.example/", provider: "prv_test", model: "m" });
  e.createCampaign(spec);
  e.storage.setCampaignState(spec.campaign_id, "active", { kind: "user", id: "t" });
  const root = String(e.storage.list("goals", spec.campaign_id)[0]!.id);
  e.storage.proposeStepDirect({
    campaign_id: spec.campaign_id,
    producer_id: "t",
    submission_id: "seed-1",
    question: "read readme",
    kind: "explore",
    goal_refs: [root],
    preconditions: { op: "all", of: [] },
    method_family: "generic",
    expected_observations: [],
    completion_criteria: "done",
    fingerprint: "par-old-kali-fp",
    reopen_rule: { kind: "always" },
  });
  await e.start(spec.campaign_id);
  assert.equal(docker.overlap, false, "single-worker legacy: no overlap");
  e.close();
});
