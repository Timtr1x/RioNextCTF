import assert from "node:assert/strict";
import { test } from "node:test";
import { ContestApi, ContestApiError, type FetchLike } from "../../src/contest/api.ts";

function jsonRsp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function apiWith(fetchFn: FetchLike, logs?: string[]): ContestApi {
  return new ContestApi({
    token: "tok-test",
    fetchFn,
    retries: 1,
    sleep: async () => {},
    onLog: (l) => logs?.push(l),
  });
}

const STATIC_MISC = {
  question_id: "q-static",
  title: "测试_附件",
  score: 100,
  real_score: 100,
  file_url: "https://cdn.example/a.zip",
  is_solved: false,
  solved_number: 0,
  category: "misc",
  attributes: ["标签", "杂项"],
  description: "测试_多附件题目",
  interactive: "false",
  capabilities: ["能力"],
  connection: [],
  extensions: { aaa: "<Misc扩展信息>" },
};

const PWN_CONTAINER = {
  question_id: "q-pwn",
  title: "sign_shellcode",
  score: 500,
  real_score: 500,
  file_url: "",
  is_solved: false,
  solved_number: 3,
  category: "pwn",
  attributes: ["docker"],
  description: "test",
  interactive: "true",
  capabilities: ["docker"],
  connection: { docker_url: "nc 10.0.0.8 31337", docker_ip: "10.0.0.8", docker_port: "31337" },
  extensions: { pwn: "<Pwn扩展信息>" },
  future_field: { whatever: true },
};

test("list parses the PDF-shaped envelope, tolerating extras", async () => {
  const logs: string[] = [];
  const api = apiWith(async () => jsonRsp({ code: 0, message: "查询成功", data: [STATIC_MISC, PWN_CONTAINER] }), logs);
  const qs = await api.listQuestions();
  assert.equal(qs.length, 2);
  const m = qs[0]!;
  const p = qs[1]!;
  assert.equal(m.question_id, "q-static");
  assert.equal(m.interactive, false);
  assert.equal(m.connection, null);
  assert.equal(m.file_url, "https://cdn.example/a.zip");
  assert.deepEqual(m.attributes, ["标签", "杂项"]);
  assert.equal(p.interactive, true);
  assert.deepEqual(p.connection, { docker_url: "nc 10.0.0.8 31337", docker_ip: "10.0.0.8", docker_port: "31337" });
  assert.equal(p.solved_number, 3);
  assert.equal((p.raw.future_field as { whatever: boolean }).whatever, true);
  assert.ok(logs.some((l) => l.includes("future_field")), "unknown key logged once");
});

test("list drops rows without question_id and coerces weird types", async () => {
  const api = apiWith(async () =>
    jsonRsp({
      code: 0,
      message: "查询成功",
      data: [{ title: "no id" }, { question_id: "q2", interactive: true, score: "250", connection: { docker_url: "h:80" } }],
    }),
  );
  const qs = await api.listQuestions();
  assert.equal(qs.length, 1);
  assert.equal(qs[0]!.interactive, true);
  assert.equal(qs[0]!.score, 250);
});

test("list accepts an empty board (pre-contest polling)", async () => {
  const api = apiWith(async () => jsonRsp({ code: 0, message: "查询成功", data: [] }));
  assert.deepEqual(await api.listQuestions(), []);
});

test("list errors are classified: auth vs rate", async () => {
  const authApi = apiWith(async () => jsonRsp({ code: 101, message: "暂无队伍信息" }));
  await assert.rejects(authApi.listQuestions(), (e: unknown) => e instanceof ContestApiError && e.kind === "auth");
  const rateApi = apiWith(async () => jsonRsp({ code: 101, message: "对不起，您的操作太过频繁！" }));
  await assert.rejects(rateApi.listQuestions(), (e: unknown) => e instanceof ContestApiError && e.kind === "rate");
});

test("submit verdicts: correct / wrong / rate_limited / blocked / ambiguous", async () => {
  const mk = (body: unknown) => apiWith(async () => jsonRsp(body));
  assert.deepEqual(await mk({ code: 0, message: "答案正确", status: 1 }).submitFlag("q", "flag{x}"), {
    kind: "correct",
    message: "答案正确",
  });
  assert.equal((await mk({ code: 0, message: "答案正确" }).submitFlag("q", "f")).kind, "correct");
  const wrong = await mk({ code: 101, message: "答案错误" }).submitFlag("q", "f");
  assert.equal(wrong.kind, "wrong");
  assert.ok("raw" in wrong && wrong.raw.includes("答案错误"));
  assert.equal((await mk({ code: 101, message: "对不起，您的操作太过频繁！" }).submitFlag("q", "f")).kind, "rate_limited");
  assert.equal((await mk({ code: 101, message: "提交的内容不能为空" }).submitFlag("q", "f")).kind, "blocked");
  assert.equal((await mk({ code: 101, message: "缺少参数" }).submitFlag("q", "f")).kind, "blocked");
  const amb = await mk({ code: 0, message: "" }).submitFlag("q", "f");
  assert.equal(amb.kind, "wrong");
  assert.ok("raw" in amb);
});

test("browser UA is sent (Knownsec WAF blocks default agents)", async () => {
  let seen = "";
  const api = apiWith(async (_url, init) => {
    seen = String((init?.headers as Record<string, string>)?.["user-agent"] ?? "");
    return jsonRsp({ code: 0, message: "查询成功", data: [] });
  });
  await api.listQuestions();
  assert.match(seen, /Chrome\//);
});

test("WAF HTML and network errors are retried as infra, then succeed", async () => {
  let calls = 0;
  const api = new ContestApi({
    token: "t",
    retries: 3,
    sleep: async () => {},
    fetchFn: async () => {
      calls++;
      if (calls === 1) return new Response("<html>Knownsec CloudWAF</html>", { status: 403 });
      if (calls === 2) throw new Error("socket hangup");
      return jsonRsp({ code: 0, message: "查询成功", data: [] });
    },
  });
  assert.deepEqual(await api.listQuestions(), []);
  assert.equal(calls, 3);
});

test("reset: ok / rate-limited / generic failure", async () => {
  const ok = apiWith(async () => jsonRsp({ code: 0, message: "操作成功" }));
  assert.deepEqual(await ok.resetQuestion("q"), { ok: true, message: "操作成功", rateLimited: false });
  const rate = apiWith(async () => jsonRsp({ code: 101, message: "对不起，您的操作太过频繁！" }));
  const r = await rate.resetQuestion("q");
  assert.equal(r.ok, false);
  assert.equal(r.rateLimited, true);
});
