import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContestQuestion } from "../../src/contest/api.ts";
import {
  campaignIdFor,
  connectionKey,
  endpointFor,
  extractFlag,
  isMockQuestion,
  kindForCategory,
  planFor,
  rankQuestions,
  scopeFor,
  webUrlFor,
} from "../../src/contest/plan.ts";

function q(over: Partial<ContestQuestion>): ContestQuestion {
  return {
    question_id: "q",
    title: "t",
    category: "misc",
    description: "d",
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

test("mock detection covers title/description/attributes", () => {
  assert.equal(isMockQuestion(q({ title: "测试_附件" })), true);
  assert.equal(isMockQuestion(q({ description: "test" })), true);
  assert.equal(isMockQuestion(q({ title: "mock-pwn" })), true);
  assert.equal(isMockQuestion(q({ attributes: ["样例"] })), true);
  assert.equal(isMockQuestion(q({ title: "sign_shellcode", description: "real", attributes: ["docker"] })), false);
});

test("category mapping", () => {
  assert.equal(kindForCategory("web"), "web");
  assert.equal(kindForCategory("Web"), "web");
  assert.equal(kindForCategory("pwn"), "pwn");
  assert.equal(kindForCategory("reverse"), "reverse");
  assert.equal(kindForCategory("re"), "reverse");
  assert.equal(kindForCategory("crypto"), "crypto");
  assert.equal(kindForCategory("misc"), "misc");
  assert.equal(kindForCategory("forensics"), "generic");
});

test("endpointFor: ip/port fields, nc string; web host:port is NOT an endpoint", () => {
  assert.deepEqual(endpointFor({ docker_ip: "10.0.0.8", docker_port: "31337" }), { host: "10.0.0.8", port: 31337 });
  assert.deepEqual(endpointFor({ docker_url: "nc 10.0.0.9 1337" }), { host: "10.0.0.9", port: 1337 });
  assert.equal(endpointFor({ docker_url: "web-host:80" }), null);
  assert.equal(endpointFor(null), null);
  assert.equal(endpointFor({ docker_ip: "10.0.0.8" }), null);
});

test("webUrlFor normalizes docker_url shapes", () => {
  assert.equal(webUrlFor({ docker_url: "host.example:80" }), "http://host.example/");
  assert.equal(webUrlFor({ docker_url: "host.example:8080" }), "http://host.example:8080/");
  assert.equal(webUrlFor({ docker_url: "http://x.example/path" }), "http://x.example/path");
  assert.equal(webUrlFor({ docker_url: "nc 1.2.3.4 5" }), null);
  assert.equal(webUrlFor(null), null);
});

test("planFor maps question shapes to launch plans", () => {
  const web = q({ category: "web", interactive: true, connection: { docker_url: "w:80" } });
  assert.deepEqual(planFor(web), { type: "url", url: "http://w/" });

  const pwn = q({
    category: "pwn",
    interactive: true,
    file_url: "https://cdn/pwn.tgz",
    connection: { docker_ip: "10.0.0.8", docker_port: "31337" },
  });
  assert.deepEqual(planFor(pwn), {
    type: "input",
    kind: "pwn",
    endpoint: { host: "10.0.0.8", port: 31337 },
    fileUrl: "https://cdn/pwn.tgz",
    webUrl: null,
  });

  // misc keeps the classifier (overlay survival), even with an attachment
  const misc = q({ category: "misc", file_url: "https://cdn/a.pcap" });
  assert.deepEqual(planFor(misc), { type: "input", kind: undefined, endpoint: null, fileUrl: "https://cdn/a.pcap", webUrl: null });

  const cryptoText = q({ category: "crypto", description: "n=... e=65537" });
  assert.deepEqual(planFor(cryptoText), { type: "input", kind: "crypto", endpoint: null, fileUrl: null, webUrl: null });

  const empty = q({ description: "", file_url: null, connection: null });
  assert.equal(planFor(empty).type, "blocked");
});

test("planFor: web with source attachment becomes an input plan carrying the live url", () => {
  const mixed = q({
    category: "web",
    interactive: true,
    file_url: "https://cdn/web-src.zip",
    connection: { docker_url: "w:8080" },
  });
  assert.deepEqual(planFor(mixed), {
    type: "input",
    kind: undefined,
    endpoint: null,
    fileUrl: "https://cdn/web-src.zip",
    webUrl: "http://w:8080/",
  });
  // url only: still a pure web campaign
  const pureWeb = q({ category: "web", interactive: true, connection: { docker_url: "w:80" } });
  assert.deepEqual(planFor(pureWeb), { type: "url", url: "http://w/" });
  // file only: attachment input without a live url
  const fileOnly = q({ category: "web", file_url: "https://cdn/web-src.zip" });
  assert.deepEqual(planFor(fileOnly), {
    type: "input",
    kind: undefined,
    endpoint: null,
    fileUrl: "https://cdn/web-src.zip",
    webUrl: null,
  });
  // non-web http container paired with an attachment keeps the url too
  const miscHttp = q({ category: "misc", file_url: "https://cdn/a.bin", connection: { docker_url: "svc:9000" } });
  assert.deepEqual(planFor(miscHttp), {
    type: "input",
    kind: undefined,
    endpoint: null,
    fileUrl: "https://cdn/a.bin",
    webUrl: "http://svc:9000/",
  });
});

test("rankQuestions: easy layers first, score asc, solved_number desc", () => {
  const staticMisc100 = q({ question_id: "a", category: "misc", real_score: 100, description: "x" });
  const staticCrypto200 = q({ question_id: "b", category: "crypto", real_score: 200, description: "x" });
  const containerWeb100 = q({ question_id: "c", category: "web", interactive: true, connection: { docker_url: "w:80" }, real_score: 100 });
  const miscFile300 = q({ question_id: "d", category: "misc", file_url: "https://cdn/z", real_score: 300 });
  const pwn100 = q({ question_id: "e", category: "pwn", interactive: true, connection: { docker_ip: "1.2.3.4", docker_port: "5" }, real_score: 100 });
  const staticMisc100popular = q({ question_id: "f", category: "misc", real_score: 100, solved_number: 9, description: "x" });
  const ranked = rankQuestions([pwn100, miscFile300, staticCrypto200, containerWeb100, staticMisc100, staticMisc100popular]);
  assert.deepEqual(
    ranked.map((x) => x.question_id),
    ["f", "a", "b", "c", "d", "e"],
  );
});

test("extractFlag: pattern first, bare token fallback, prose rejected", () => {
  assert.equal(extractFlag("the flag is flag{abC_123-xyz}."), "flag{abC_123-xyz}");
  assert.equal(extractFlag("CTF2{warp_drive}"), "CTF2{warp_drive}");
  assert.equal(extractFlag("moectf{y0u_g0t_1t}"), "moectf{y0u_g0t_1t}");
  assert.equal(extractFlag("  d41d8cd98f00b204e9800998ecf8427e  "), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(extractFlag("I think the flag might be somewhere in /etc"), null);
  assert.equal(extractFlag("x".repeat(600)), null);
});

test("campaignIdFor is stable, sanitized and capped", () => {
  const id = campaignIdFor(q({ question_id: "ABCD-EF_GH 12/34" }));
  assert.equal(id, campaignIdFor(q({ question_id: "ABCD-EF_GH 12/34" })));
  assert.match(id, /^camp_q_[a-z0-9_-]+$/);
  assert.ok(id.length <= 48);
  assert.equal(campaignIdFor(q({ question_id: "x".repeat(80) })).length, 48);
});

test("connectionKey + scopeFor track endpoint moves", () => {
  const a = q({ category: "pwn", connection: { docker_ip: "1.1.1.1", docker_port: "1000" } });
  const b = q({ category: "pwn", connection: { docker_ip: "2.2.2.2", docker_port: "1000" } });
  assert.notEqual(connectionKey(a), connectionKey(b));
  assert.deepEqual(scopeFor(a), { assets: ["1.1.1.1:1000"], entries: ["tcp://1.1.1.1:1000"] });
  const web = q({ category: "web", connection: { docker_url: "w:80" } });
  assert.deepEqual(scopeFor(web), { assets: ["w", "http://w/"], entries: ["http://w/"] });
  // a connection that carries both an http app and a tcp service reports both
  const mixed = q({ category: "web", connection: { docker_url: "w:80", docker_ip: "1.2.3.4", docker_port: "9999" } });
  assert.deepEqual(scopeFor(mixed), {
    assets: ["w", "http://w/", "1.2.3.4:9999"],
    entries: ["http://w/", "tcp://1.2.3.4:9999"],
  });
});
