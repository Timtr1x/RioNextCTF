import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContestApi, type FetchLike } from "../../src/contest/api.ts";
import type { ManagerAdvice } from "../../src/contest/manager.ts";
import type { CampaignHandle, PreparedCampaign, RunnerControl, RunnerFactory } from "../../src/contest/runner.ts";
import type { SharedKali } from "../../src/contest/shared-kali.ts";
import { ContestSupervisor } from "../../src/contest/supervisor.ts";

/* ---------------------------------- fakes ---------------------------------- */

type Round = { state: string; flag?: string; block?: boolean };

interface FakeCampaign {
  rounds: Round[];
  openCount: number;
  rejects: string[];
  hints: string[];
  accepts: number;
  pauses: number;
  kills: number;
  cancels: number;
  updates: Array<{ assets: string[]; entries: string[]; note: string }>;
  cancelRequested: boolean;
}

function newCampaign(rounds: Round[]): FakeCampaign {
  return {
    rounds,
    openCount: 0,
    rejects: [],
    hints: [],
    accepts: 0,
    pauses: 0,
    kills: 0,
    cancels: 0,
    updates: [],
    cancelRequested: false,
  };
}

class FakeHandle implements CampaignHandle {
  constructor(
    readonly campaignId: string,
    private readonly camp: FakeCampaign,
  ) {}

  async start(): Promise<void> {
    if (this.camp.rounds[this.roundIndex()]?.block) {
      for (let i = 0; i < 150 && !this.camp.cancelRequested; i++) {
        await new Promise((r) => setTimeout(r, 2));
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1));
  }

  private roundIndex(): number {
    return Math.min(this.camp.openCount - 1, this.camp.rounds.length - 1);
  }

  state(): string {
    if (this.camp.cancelRequested) return "cancelled";
    return this.camp.rounds[this.roundIndex()]!.state;
  }

  pendingFlag(): string | null {
    return this.camp.rounds[this.roundIndex()]!.flag ?? null;
  }

  recentHints(): string[] {
    return this.camp.hints.slice(-8);
  }

  accept(): void {
    this.camp.accepts++;
  }

  reject(text: string): void {
    this.camp.rejects.push(text);
  }

  hint(text: string): void {
    this.camp.hints.push(text);
  }

  pause(): void {
    this.camp.pauses++;
  }

  cancel(): void {
    this.camp.cancels++;
    this.camp.cancelRequested = true;
  }

  killKali(): void {
    this.camp.kills++;
  }

  updateConnection(assets: string[], entries: string[], note: string): void {
    this.camp.updates.push({ assets, entries, note });
  }

  close(): void {}
}

class FakeFactory implements RunnerFactory {
  readonly campaigns = new Map<string, FakeCampaign>();
  readonly prepares: string[] = [];
  readonly pendingCancels = new Set<string>();
  cancelAllCount = 0;

  constructor(private readonly scripts: Record<string, Round[]>) {}

  async prepare(q: { question_id: string }): Promise<PreparedCampaign> {
    const id = `camp_q_${q.question_id}`;
    this.prepares.push(id);
    if (!this.campaigns.has(id)) {
      const camp = newCampaign(this.scripts[q.question_id] ?? [{ state: "cancelled" }]);
      if (this.pendingCancels.has(id)) camp.cancelRequested = true;
      this.campaigns.set(id, camp);
    }
    return { campaignId: id, created: true };
  }

  open(campaignId: string): CampaignHandle {
    const camp = this.campaigns.get(campaignId);
    if (!camp) throw new Error(`no fake campaign ${campaignId}`);
    camp.openCount++;
    return new FakeHandle(campaignId, camp);
  }

  control(): RunnerControl {
    return {
      cancel: (id) => {
        const camp = this.campaigns.get(id);
        if (camp) {
          camp.cancels++;
          camp.cancelRequested = true;
        } else {
          this.pendingCancels.add(id);
        }
      },
      cancelAll: () => {
        this.cancelAllCount++;
        for (const camp of this.campaigns.values()) camp.cancelRequested = true;
        return [];
      },
    };
  }

  dispose(): void {}
}

interface SubmitCall {
  qid: string;
  answer: string;
}

interface Harness {
  sup: ContestSupervisor;
  factory: FakeFactory;
  logs: string[];
  submitCalls: SubmitCall[];
  dir: string;
  setList: (fn: (call: number) => unknown) => void;
}

function q(over: Record<string, unknown>): Record<string, unknown> {
  return {
    question_id: "q1",
    title: "real question",
    category: "misc",
    description: "a real one",
    score: 100,
    real_score: 100,
    solved_number: 0,
    is_solved: false,
    interactive: "false",
    file_url: "",
    attributes: [],
    capabilities: [],
    connection: [],
    ...over,
  };
}

function harness(
  scripts: Record<string, Round[]>,
  opts: {
    mode?: "test" | "official";
    slots?: number;
    maxAttempts?: number;
    maxTicks?: number;
    manager?: (input: unknown) => Promise<ManagerAdvice | null>;
    sharedKali?: SharedKali;
    submitTable?: (call: SubmitCall, n: number) => unknown;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "rn-contest-"));
  const factory = new FakeFactory(scripts);
  const logs: string[] = [];
  const submitCalls: SubmitCall[] = [];
  let listFn: (call: number) => unknown = () => ({ code: 0, message: "查询成功", data: [] });
  let listCalls = 0;
  const fetchFn: FetchLike = async (url) => {
    const u = new URL(url);
    if (u.pathname.includes("04cb")) {
      listCalls++;
      return new Response(JSON.stringify(listFn(listCalls)), { status: 200 });
    }
    if (u.pathname.includes("ff87")) {
      const call: SubmitCall = { qid: u.searchParams.get("question_id") ?? "", answer: u.searchParams.get("answer") ?? "" };
      submitCalls.push(call);
      const body = opts.submitTable
        ? opts.submitTable(call, submitCalls.length)
        : { code: 0, message: "答案正确", status: 1 };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, message: "操作成功" }), { status: 200 });
  };
  const api = new ContestApi({ token: "tok", fetchFn, retries: 1, sleep: async () => {} });
  const sup = new ContestSupervisor({
    dir,
    mode: opts.mode ?? "official",
    slots: opts.slots ?? 4,
    api,
    factory,
    manager: opts.manager as never,
    sharedKali: opts.sharedKali,
    maxAttempts: opts.maxAttempts ?? 3,
    submitIntervalMs: 0,
    rateLimitBackoffMs: 1,
    rateLimitRetries: 2,
    pollBoostMs: 1,
    pollSteadyMs: 1,
    maxTicks: opts.maxTicks ?? 60,
    stateFile: join(dir, "state.json"),
    stopFile: join(dir, "STOP"),
    onLog: (l) => logs.push(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(1, Math.min(ms, 2)))),
  });
  return {
    sup,
    factory,
    logs,
    submitCalls,
    dir,
    setList: (fn) => {
      listFn = fn;
    },
  };
}

/* ---------------------------------- tests ---------------------------------- */

test("empty board keeps polling; question appears → campaign runs → flag accepted → slot freed", async () => {
  const h = harness({ q1: [{ state: "awaiting_verify", flag: "flag{web1}" }] });
  h.setList((n) =>
    n < 3
      ? { code: 0, message: "查询成功", data: [] }
      : { code: 0, message: "查询成功", data: [q({ category: "web", interactive: "true", connection: { docker_url: "w1:80" } })] },
  );
  await h.sup.run();
  const camp = h.factory.campaigns.get("camp_q_q1")!;
  assert.ok(camp, "campaign was prepared");
  assert.equal(camp.accepts, 1);
  assert.equal(camp.kills, 1, "workspace reclaimed after accept");
  assert.deepEqual(h.submitCalls, [{ qid: "q1", answer: "flag{web1}" }]);
  assert.ok(h.sup.snapshot().solved.includes("q1"));
  assert.equal(camp.rejects.length, 0);
});

test("state file is published even while the board stays closed", async () => {
  const h = harness({});
  // The platform answers "比赛未开始" on every poll: no successful list, ever.
  h.setList(() => ({ code: 201, message: "比赛未开始" }));
  await h.sup.run();
  const state = JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8")) as {
    pid: number;
    mode: string;
    ticks: number;
    questions_seen: number;
    updated_at: string;
  };
  assert.equal(state.mode, "official");
  assert.equal(typeof state.pid, "number");
  assert.ok(state.ticks > 0, "ticks kept advancing while the board was closed");
  assert.equal(state.questions_seen, 0);
  assert.ok(state.updated_at);
});

test("wrong flag: platform message goes into reject, same value never resubmitted, manager hint written", async () => {
  const h = harness(
    { q1: [{ state: "awaiting_verify", flag: "flag{wrong}" }, { state: "awaiting_verify", flag: "flag{wrong}" }, { state: "awaiting_verify", flag: "flag{right}" }] },
    {
      manager: async () => ({ hint: "换个方向，先确认包装格式", nextAction: "continue", doNotResubmit: [], diagnosis: "format", raw: "" }),
      submitTable: (call) => (call.answer === "flag{right}" ? { code: 0, message: "答案正确", status: 1 } : { code: 101, message: "答案错误" }),
    },
  );
  h.setList(() => ({ code: 0, message: "查询成功", data: [q({})] }));
  await h.sup.run();
  const camp = h.factory.campaigns.get("camp_q_q1")!;
  // flag{wrong} hit the platform once; the repeat was rejected locally without a submit
  assert.deepEqual(
    h.submitCalls.map((c) => c.answer),
    ["flag{wrong}", "flag{right}"],
  );
  assert.equal(camp.rejects.length, 2);
  assert.ok(camp.rejects[0]!.includes("答案错误"), "platform message forwarded");
  assert.ok(camp.rejects[0]!.includes("attempt 1/3"));
  assert.ok(camp.rejects[1]!.includes("already rejected"), "dedupe reject explains itself");
  assert.ok(camp.hints.some((x) => x.includes("[manager] 换个方向")), "manager hint persisted");
  assert.equal(camp.accepts, 1);
});

test("platform rate limit is not a wrong answer: claim stays pending, retry succeeds", async () => {
  const h = harness(
    { q1: [{ state: "awaiting_verify", flag: "flag{x}" }] },
    {
      submitTable: (_call, n) => (n === 1 ? { code: 101, message: "对不起，您的操作太过频繁！" } : { code: 0, message: "答案正确", status: 1 }),
    },
  );
  h.setList(() => ({ code: 0, message: "查询成功", data: [q({})] }));
  await h.sup.run();
  const camp = h.factory.campaigns.get("camp_q_q1")!;
  assert.equal(camp.rejects.length, 0, "never rejected on rate limit");
  assert.equal(h.submitCalls.length, 2);
  assert.equal(camp.accepts, 1);
});

test("maxAttempts wrong answers → question paused and quarantined, slot freed", async () => {
  const h = harness(
    { q1: [{ state: "awaiting_verify", flag: "flag{a}" }, { state: "awaiting_verify", flag: "flag{b}" }] },
    { maxAttempts: 2, submitTable: () => ({ code: 101, message: "答案错误" }) },
  );
  h.setList(() => ({ code: 0, message: "查询成功", data: [q({})] }));
  await h.sup.run();
  const camp = h.factory.campaigns.get("camp_q_q1")!;
  assert.equal(h.submitCalls.length, 2);
  assert.equal(camp.pauses, 1);
  assert.equal(camp.kills, 1);
  assert.match(h.sup.snapshot().quarantined.q1 ?? "", /wrong flag x2/);
});

test("mode official skips mock questions; mode test accepts them", async () => {
  const scripts = { qm: [{ state: "cancelled" }], qr: [{ state: "cancelled" }] };
  const board = () => ({
    code: 0,
    message: "查询成功",
    data: [
      q({ question_id: "qm", title: "测试_附件", description: "测试题", file_url: "https://cdn.example/a.zip" }),
      q({ question_id: "qr", category: "crypto", description: "n=.." }),
    ],
  });
  const official = harness(scripts, { mode: "official" });
  official.setList(board);
  await official.sup.run();
  assert.deepEqual(official.factory.prepares.sort(), ["camp_q_qr"]);

  const drill = harness(scripts, { mode: "test" });
  drill.setList(board);
  await drill.sup.run();
  assert.deepEqual(drill.factory.prepares.sort(), ["camp_q_qm", "camp_q_qr"]);
});

test("question solved externally → local campaign cancelled, not counted as our solve", async () => {
  const h = harness({ q1: [{ state: "running", block: true }] });
  h.setList((n) =>
    n < 3
      ? { code: 0, message: "查询成功", data: [q({ category: "web", interactive: "true", connection: { docker_url: "w:80" } })] }
      : { code: 0, message: "查询成功", data: [q({ is_solved: true, category: "web", interactive: "true", connection: { docker_url: "w:80" } })] },
  );
  await h.sup.run();
  const camp = h.factory.campaigns.get("camp_q_q1")!;
  assert.ok(camp.cancels >= 1, "control cancel reached the campaign");
  assert.equal(h.submitCalls.length, 0);
  assert.deepEqual(h.sup.snapshot().solved, []);
  const fin = h.sup.snapshot().finished.find((f) => f.qid === "q1");
  assert.equal(fin?.note, "solved externally");
});

test("stop file shuts the supervisor down: campaigns cancelled, shared container removed", async () => {
  const killed: string[] = [];
  const fakeShared = {
    name: "rionext-kali-contest",
    ensure: () => {},
    applyAllowlist: () => {},
    status: () => "running" as const,
    kill: () => killed.push("k"),
  } as unknown as SharedKali;
  const h = harness({}, { sharedKali: fakeShared });
  writeFileSync(join(h.dir, "STOP"), "1");
  await h.sup.run();
  assert.equal(h.factory.cancelAllCount, 1);
  assert.equal(killed.length, 1);
});
