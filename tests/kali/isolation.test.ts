import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRuntimeConfig } from "../../src/contracts/config.ts";
import { Engine } from "../../src/controller/engine.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { loadKaliSpec } from "../../src/eval/helpers.ts";
import { FakeDockerCli, ProcessDockerCli } from "../../src/tools/docker-cli.ts";
import { checkEgress, checkRedirect, isLoopbackHost, parseAllowList, parseDestination } from "../../src/tools/egress.ts";
import { assertKaliArgv, KALI_KEEPER_NAME, shouldBackgroundKali, workspaceRelPath } from "../../src/tools/kali-profile.ts";
import { buildContainerSpec, kaliEntrypointHost, KaliRuntime, containerName, parseGetentHosts, systemLookup4 } from "../../src/tools/kali-runtime.ts";
import type { RunLease } from "../../src/domain/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-kali-"));
}

function resolveMap(map: Record<string, string[]>): (h: string) => string[] {
  return (h) => {
    if (map[h]) return map[h]!;
    throw new Error(`no dns for ${h}`);
  };
}

test("K05 container spec mounts only workspace, never db/secrets/artifacts", () => {
  const dir = tmp();
  const spec = buildContainerSpec({
    campaignId: "c1",
    workspaceHost: join(dir, "workspace", "c1"),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: [],
    network: "none",
  });
  assert.deepEqual(
    spec.mounts.map((m) => m.container),
    ["/workspace"],
  );
  const joined = spec.argv.join(" ");
  assert.equal(joined.includes("rionext.sqlite"), false);
  assert.equal(joined.includes("provider-secrets"), false);
  assert.equal(joined.includes("/artifacts"), false);
  assert.ok(spec.argv.includes("--cap-drop"));
  assert.ok(spec.argv.includes("ALL"));
  assert.ok(spec.argv.includes("--pids-limit"));
  assert.ok(spec.argv.includes("no-new-privileges=true"));
  assert.equal(spec.env.HOME, "/home/rionext");
  assert.equal(spec.env.RIONEXT_CAMPAIGN, "c1");
  assert.equal("OPENAI_API_KEY" in spec.env, false);
  assert.equal("ANTHROPIC_API_KEY" in spec.env, false);
});

test("campaign clone overlays host entrypoint; does not rebuild the master image", () => {
  const dir = tmp();
  const spec = buildContainerSpec({
    campaignId: "c-overlay",
    workspaceHost: join(dir, "workspace", "c-overlay"),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: [],
    network: "none",
  });
  const host = kaliEntrypointHost();
  assert.ok(host, "docker/kali/entrypoint.sh must be on disk");
  assert.ok(spec.argv.some((a) => a.endsWith("rionext-entrypoint:ro")));
  assert.ok(spec.argv.includes("--entrypoint"));
  assert.ok(spec.argv.includes("/bin/sh"));
  assert.ok(spec.argv.includes("/usr/local/bin/rionext-entrypoint"));
  assert.deepEqual(spec.mounts.map((m) => m.container), ["/workspace"]);
});

test("K11 container env does not copy host secrets", () => {
  process.env.OPENAI_API_KEY = "sk-should-never-enter-kali";
  const dir = tmp();
  const spec = buildContainerSpec({
    campaignId: "c2",
    workspaceHost: join(dir, "ws"),
    dbPath: join(dir, "db.sqlite"),
    secretsPath: join(dir, "secrets.json"),
    artifactRoot: join(dir, "art"),
    dataDir: dir,
    allowAssets: ["10.0.0.0/24"],
    network: "allowlist",
    resolve: () => ["10.0.0.1"],
  });
  delete process.env.OPENAI_API_KEY;
  const blob = JSON.stringify(spec);
  assert.equal(blob.includes("sk-should-never-enter-kali"), false);
  assert.equal(spec.argv.includes("NET_ADMIN"), false);
});

test("K06 host and redirect not in allowlist are denied", () => {
  const allow = parseAllowList(["10.0.0.0/24", "lab.internal"]);
  const resolve = resolveMap({ "lab.internal": ["10.0.0.8"], "evil.example": ["8.8.8.8"] });
  const ok = checkEgress(parseDestination("https://lab.internal/"), allow, resolve);
  assert.equal(ok.ok, true);
  const bad = checkEgress(parseDestination("https://evil.example/"), allow, resolve);
  assert.equal(bad.ok, false);
  const redir = checkRedirect("https://evil.example/loot", allow, resolve);
  assert.equal(redir.ok, false);
});

test("parseGetentHosts keeps IPv4 columns from getent hosts", () => {
  assert.deepEqual(parseGetentHosts("117.21.200.176  node5.buuoj.cn foo.http-ctf2.dasctf.com\n"), ["117.21.200.176"]);
  assert.deepEqual(parseGetentHosts(""), []);
});

test("systemLookup4 uses OS GetAddrInfo for localhost, not c-ares resolve4", () => {
  const ips = systemLookup4("localhost");
  assert.ok(ips.includes("127.0.0.1"), `localhost IPv4 got ${JSON.stringify(ips)}`);
});

test("egress deny on kali_run is failed_known and drops the workspace lock", () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const e = new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 1,
    dockerCli: docker,
    kaliResolve: () => {
      throw new Error("queryA EREFUSED x");
    },
  });
  const spec = loadKaliSpec("t-dns");
  e.createCampaign(spec);
  const lease = kaliLease(e, "t-dns");
  const sent = e.dispatchGate.dispatch({
    lease,
    purpose: "kali_run",
    payload: { kind: "kali", bin: "curl", args: ["-sS", "http://lab.internal/"], url: "http://lab.internal/" },
    effect: "read",
    envTool: true,
  });
  assert.equal(sent.status, "rejected");
  assert.match(String(sent.reason), /resolve_failed|egress_denied/);
  assert.equal(e.storage.listResourceLocks("t-dns").length, 0);
  assert.equal(String(e.invocations.get(sent.invocation_id).state), "failed_known");
});

test("K06 nmap against an out-of-scope IP is denied", () => {
  const docker = new FakeDockerCli();
  const rt = new KaliRuntime(docker);
  const dir = tmp();
  const opts = {
    campaignId: "c3",
    workspaceHost: join(dir, "ws"),
    dbPath: join(dir, "db.sqlite"),
    secretsPath: join(dir, "secrets.json"),
    artifactRoot: join(dir, "art"),
    dataDir: dir,
    allowAssets: ["10.0.0.0/24"],
    network: "allowlist" as const,
    resolve: resolveMap({ "8.8.8.8": ["8.8.8.8"] }),
  };
  assert.throws(
    () => rt.exec(opts, "nmap", ["-sn", "8.8.8.8"]),
    (e: unknown) => e instanceof DomainError && e.code === "egress_denied",
  );
});

test("kali argv deny on dispatch is failed_known and drops the workspace lock", () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const e = new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 1,
    dockerCli: docker,
    kaliResolve: (h) => (h === "lab.internal" ? ["10.0.0.8"] : [h]),
  });
  const spec = loadKaliSpec("t-argv");
  e.createCampaign(spec);
  const lease = kaliLease(e, "t-argv");
  const sent = e.dispatchGate.dispatch({
    lease,
    purpose: "kali_run",
    payload: { kind: "kali", bin: "curl", args: ["-sS", "http://lab.internal/;id"] },
    effect: "read",
    envTool: true,
  });
  assert.equal(sent.status, "rejected");
  assert.match(String(sent.reason), /kali_argv|metacharacters/);
  assert.equal(e.storage.listResourceLocks("t-argv").length, 0);
  assert.equal(String(e.invocations.get(sent.invocation_id).state), "failed_known");
});

test("kali_start protocol_error is failed_known and drops the workspace lock", () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  docker.images.clear();
  const e = new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 1,
    dockerCli: docker,
    kaliResolve: (h) => (h === "lab.internal" ? ["10.0.0.8"] : [h]),
  });
  const spec = loadKaliSpec("t-start");
  e.createCampaign(spec);
  const lease = kaliLease(e, "t-start");
  const sent = e.dispatchGate.dispatch({
    lease,
    purpose: "kali_run",
    payload: { kind: "kali", bin: "curl", args: ["-sS", "http://lab.internal/"], url: "http://lab.internal/" },
    effect: "read",
    envTool: true,
  });
  assert.equal(sent.status, "rejected");
  assert.match(String(sent.reason), /kali_master_missing|kali_start/);
  assert.equal(e.storage.listResourceLocks("t-start").length, 0);
  assert.equal(String(e.invocations.get(sent.invocation_id).state), "failed_known");
});

test("recover drops workspace lock when uncertain kali never got an external_id", () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const e = kaliEngine(dir, docker);
  const spec = loadKaliSpec("t-rec");
  e.createCampaign(spec);
  const lease = kaliLease(e, "t-rec");
  const inv = e.invocations.prepare({
    campaign_id: "t-rec",
    run_id: lease.run_id,
    kind: "tool",
    purpose: "kali_run",
    fence: lease.fence,
    cancel_epoch: lease.cancel_epoch,
    effect_class: "unknown",
    reserved_calls: 1,
  });
  e.budget.reserve("t-rec", inv.id, 1, 0, 0);
  e.budget.markLiability("t-rec", inv.id, 1, 0, 0);
  e.invocations.mark(inv.id, "uncertain", { error: "generic boom" });
  assert.equal(e.storage.acquireResourceLock("t-rec", "workspace:t-rec", inv.id, false), true);
  const rec = e.dispatchGate.recover("t-rec");
  assert.equal(rec.reconciled >= 1, true);
  assert.equal(e.storage.listResourceLocks("t-rec").length, 0);
  assert.equal(String(e.invocations.get(inv.id).state), "failed_known");
});

test("kali argv rejects unknown binaries and shell metacharacters", () => {
  assert.throws(
    () => assertKaliArgv("nmap", ["-p", "80; curl evil"]),
    (e: unknown) => e instanceof DomainError && e.code === "kali_argv",
  );
  assert.doesNotThrow(() => assertKaliArgv("nmap", ["-sn", "10.0.0.1"]));
  assert.doesNotThrow(() => assertKaliArgv("impacket-secretsdump", ["-h"]));
  assert.doesNotThrow(() => assertKaliArgv("nuclei", ["-duc", "-t", "/opt/nuclei-templates", "-u", "https://10.0.0.1/"]));
  assert.doesNotThrow(() => assertKaliArgv("cat", ["/opt/kb/INDEX.txt"]));
  assert.doesNotThrow(() => assertKaliArgv("katana", ["-u", "https://10.0.0.1/"]));
  assert.throws(() => assertKaliArgv("/bin/bash", []));
});

test("bash and python3 may author and run workspace scripts, not /etc", () => {
  assert.doesNotThrow(() => assertKaliArgv("bash", ["-c", "cat > /workspace/p.py <<'EOF'\nprint(1)\nEOF"]));
  assert.doesNotThrow(() => assertKaliArgv("bash", ["payloads/run.sh"]));
  assert.doesNotThrow(() => assertKaliArgv("python3", ["/workspace/p.py"]));
  assert.doesNotThrow(() => assertKaliArgv("mkdir", ["payloads"]));
  assert.throws(() => assertKaliArgv("bash", ["/etc/passwd"]));
  assert.throws(() => assertKaliArgv("python3", ["../escape.py"]));
  assert.throws(() => assertKaliArgv("rm", ["-rf", "/"]));
  assert.throws(() => workspaceRelPath("../x"));
  assert.equal(workspaceRelPath("/workspace/payloads/x.py"), "payloads/x.py");
});

test("kali_write puts files in the campaign workspace mount", () => {
  const docker = new FakeDockerCli();
  const rt = new KaliRuntime(docker);
  const dir = tmp();
  const opts = {
    campaignId: "w1",
    workspaceHost: join(dir, "ws"),
    dbPath: join(dir, "db.sqlite"),
    secretsPath: join(dir, "secrets.json"),
    artifactRoot: join(dir, "art"),
    dataDir: dir,
    allowAssets: [],
    network: "none" as const,
  };
  const r = rt.writeWorkspace(opts, "payloads/xss.html", "<script>alert(1)</script>");
  assert.equal(r.code, 0);
  const body = JSON.parse(r.stdout) as { path: string; bytes: number };
  assert.equal(body.path, "/workspace/payloads/xss.html");
  assert.equal(readFileSync(join(dir, "ws", "payloads", "xss.html"), "utf8"), "<script>alert(1)</script>");
  assert.throws(
    () => rt.writeWorkspace(opts, "../secrets.json", "nope"),
    (e: unknown) => e instanceof Error && /escape|workspace/.test(String(e)),
  );
});

test("K07 cancel uses docker kill of the container, not a parent pid", () => {
  const docker = new FakeDockerCli();
  const rt = new KaliRuntime(docker);
  rt.kill("camp-kill");
  const flat = docker.calls.map((c) => c.join(" "));
  assert.ok(flat.some((c) => c.startsWith("kill rionext-kali-camp-kill")));
  assert.ok(flat.some((c) => c.includes("rm -f rionext-kali-camp-kill")));
});

test("K10 huge output is truncated at the docker maxBytes cap", () => {
  const docker = new FakeDockerCli();
  docker.next = { stdout: "x".repeat(2_000_000), stderr: "", code: 0, timedOut: false };
  const rt = new KaliRuntime(docker);
  const dir = tmp();
  const r = rt.exec(
    {
      campaignId: "c4",
      workspaceHost: join(dir, "ws"),
      dbPath: join(dir, "db.sqlite"),
      secretsPath: join(dir, "secrets.json"),
      artifactRoot: join(dir, "art"),
      dataDir: dir,
      allowAssets: ["10.0.0.1"],
      network: "none",
      resolve: () => ["10.0.0.1"],
    },
    "curl",
    ["-s", "https://10.0.0.1/"],
    { url: "https://10.0.0.1/" },
  );
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 1_000_000);
});

test("J11 rate limit blocks a noisy host", () => {
  const docker = new FakeDockerCli();
  const rt = new KaliRuntime(docker);
  const dir = tmp();
  const opts = {
    campaignId: "c5",
    workspaceHost: join(dir, "ws"),
    dbPath: join(dir, "db.sqlite"),
    secretsPath: join(dir, "secrets.json"),
    artifactRoot: join(dir, "art"),
    dataDir: dir,
    allowAssets: ["10.0.0.1"],
    network: "none" as const,
    resolve: () => ["10.0.0.1"],
  };
  for (let i = 0; i < 20; i++) {
    rt.exec(opts, "curl", ["https://10.0.0.1/"], { url: "https://10.0.0.1/" });
  }
  assert.throws(
    () => rt.exec(opts, "curl", ["https://10.0.0.1/"], { url: "https://10.0.0.1/" }),
    (e: unknown) => e instanceof DomainError && e.code === "rate_limited",
  );
});

test("Engine cancel kills the Kali container for that campaign", () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const e = new Engine(makeRuntimeConfig(dir), { silent: true, maxCycles: 1, dockerCli: docker });
  const spec = loadKaliSpec("t-kali-cancel");
  e.createCampaign(spec);
  e.cancel("t-kali-cancel");
  const name = containerName("t-kali-cancel");
  assert.ok(docker.calls.some((c) => c[0] === "kill" && c.includes(name)));
  e.close();
});

test("K10 path escape is not a container mount", () => {
  const dir = tmp();
  mkdirSync(join(dir, "workspace", "c"), { recursive: true });
  writeFileSync(join(dir, "rionext.sqlite"), "db");
  const spec = buildContainerSpec({
    campaignId: "c",
    workspaceHost: join(dir, "workspace", "c"),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: [],
    network: "none",
  });
  assert.equal(
    spec.mounts.some((m) => m.host.replace(/\\/g, "/").endsWith("rionext.sqlite")),
    false,
  );
});

test("master image is required and never docker rmi'd", () => {
  const docker = new FakeDockerCli();
  docker.images.clear();
  const rt = new KaliRuntime(docker);
  assert.throws(
    () => rt.requireMasterImage(),
    (e: unknown) => e instanceof DomainError && e.code === "kali_master_missing",
  );
  docker.images.add("rionext-kali:rolling");
  assert.equal(rt.requireMasterImage().startsWith("sha256:"), true);
  rt.kill("camp-x");
  assert.equal(
    docker.calls.some((c) => c[0] === "rmi" || c.includes("docker rmi")),
    false,
  );
});

test("playwright goto is egress-checked and talks to the in-container driver", () => {
  const docker = new FakeDockerCli();
  docker.next = { stdout: JSON.stringify({ ok: true, url: "https://lab.internal/", elements: [] }), stderr: "", code: 0, timedOut: false };
  const rt = new KaliRuntime(docker);
  const dir = tmp();
  const opts = {
    campaignId: "pw1",
    workspaceHost: join(dir, "ws"),
    dbPath: join(dir, "db.sqlite"),
    secretsPath: join(dir, "secrets.json"),
    artifactRoot: join(dir, "art"),
    dataDir: dir,
    allowAssets: ["lab.internal", "10.0.0.0/24"],
    network: "allowlist" as const,
    resolve: resolveMap({ "lab.internal": ["10.0.0.8"], "evil.example": ["8.8.8.8"] }),
  };
  const ok = rt.playwright(opts, { op: "goto", url: "https://lab.internal/" });
  assert.equal(ok.code, 0);
  assert.ok(docker.calls.some((c) => c.includes("/opt/rionext/pw-ctl.mjs")));
  assert.ok(String(docker.lastInput).includes("goto"));
  assert.throws(
    () => rt.playwright(opts, { op: "goto", url: "https://evil.example/" }),
    (e: unknown) => e instanceof DomainError && e.code === "egress_denied",
  );
});

test("loopback playwright goto is not treated as egress", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  const allow = parseAllowList([]);
  const loop = checkEgress(parseDestination("http://127.0.0.1:8765/"), allow, () => {
    throw new Error("dns should not run for loopback");
  });
  assert.equal(loop.ok, true);
  const docker = new FakeDockerCli();
  docker.next = { stdout: JSON.stringify({ ok: true, url: "http://127.0.0.1:8765/", elements: [] }), stderr: "", code: 0, timedOut: false };
  const rt = new KaliRuntime(docker);
  const dir = tmp();
  const r = rt.playwright(
    {
      campaignId: "pw-lo",
      workspaceHost: join(dir, "ws"),
      dbPath: join(dir, "db.sqlite"),
      secretsPath: join(dir, "secrets.json"),
      artifactRoot: join(dir, "art"),
      dataDir: dir,
      allowAssets: [],
      network: "none",
    },
    { op: "goto", url: "http://127.0.0.1:8765/" },
  );
  assert.equal(r.code, 0);
});

test("ProcessDockerCli refuses rmi of the master image", () => {
  const cli = new ProcessDockerCli();
  const r = cli.run(["rmi", "rionext-kali:master"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refusing to rmi/);
  const rolling = cli.run(["rmi", "-f", "rionext-kali:rolling"]);
  assert.equal(rolling.code, 1);
});

test("protectMaster pins a keeper and campaign kill does not remove it", () => {
  const docker = new FakeDockerCli();
  const rt = new KaliRuntime(docker);
  const pin = rt.protectMaster();
  assert.equal(pin.keeper, KALI_KEEPER_NAME);
  assert.equal(pin.created, true);
  assert.ok(docker.created.has(KALI_KEEPER_NAME));
  rt.kill("camp-x");
  assert.equal(docker.created.has(KALI_KEEPER_NAME), true);
  assert.equal(
    docker.calls.some((c) => c[0] === "rmi"),
    false,
  );
  assert.equal(
    docker.calls.some((c) => (c[0] === "rm" || c[0] === "kill") && c.includes(KALI_KEEPER_NAME)),
    false,
  );
  const again = rt.protectMaster();
  assert.equal(again.created, false);
});

function kaliLease(e: Engine, campaignId: string): RunLease {
  e.storage.setCampaignState(campaignId, "active", { kind: "user", id: "t" });
  const root = e.storage.store.db.prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1").get(campaignId) as { id: string };
  e.storage.proposeStepDirect({
    campaign_id: campaignId,
    producer_id: "p",
    submission_id: `st-${campaignId}`,
    run_id: "seed",
    question: "browse lab",
    kind: "explore",
    goal_refs: [root.id],
    preconditions: { op: "all", of: [] },
    method_family: "http",
    expected_observations: [],
    completion_criteria: "observe",
    fingerprint: `fp-${campaignId}`,
    reopen_rule: { kind: "never" },
  });
  const claimed = e.storage.claimNextStep(campaignId, "owner-a", 1);
  if (!claimed) throw new Error("no execute slot");
  return {
    run_id: claimed.run_id,
    campaign_id: campaignId,
    step_id: claimed.step_id,
    mode: "execute",
    kind: claimed.kind,
    attempt_no: claimed.attempt_no,
    fence: claimed.fence,
    cancel_epoch: e.storage.getCampaign(campaignId).cancel_epoch,
    deadline_ms: Date.now() + 60_000,
    lease_owner: "owner-a",
    continuation_of: null,
  };
}

function kaliEngine(dir: string, docker: FakeDockerCli): Engine {
  return new Engine(makeRuntimeConfig(dir), {
    silent: true,
    maxCycles: 1,
    dockerCli: docker,
    kaliResolve: (h) => (h === "lab.internal" ? ["10.0.0.8"] : [h]),
  });
}

class CrashExecDocker extends FakeDockerCli {
  override run(argv: string[], opts?: { timeoutMs?: number; maxBytes?: number; input?: string }) {
    if (argv[0] === "exec") throw new Error("docker exec crashed");
    return super.run(argv, opts);
  }
}

test("K08 unknown-effect lock survives finishRun and is released only after cancel kills the clone", () => {
  const dir = tmp();
  const docker = new CrashExecDocker();
  const e = kaliEngine(dir, docker);
  const spec = loadKaliSpec("t-k08");
  e.createCampaign(spec);
  const lease = kaliLease(e, "t-k08");
  const sent = e.dispatchGate.dispatch({
    lease,
    purpose: "playwright",
    payload: { kind: "playwright", op: "goto", url: "https://lab.internal/" },
    effect: "unknown",
    envTool: true,
  });
  assert.equal(sent.status, "in_flight");
  const held = e.storage.listResourceLocks("t-k08");
  assert.ok(held.some((l) => l.lock_key === `workspace:t-k08:${lease.run_id}`));
  assert.ok(held.some((l) => l.lock_key === "target:lab.internal"));
  assert.ok(held.every((l) => l.effect_known === 0));
  e.storage.finishRun("t-k08", lease.run_id, {
    run_id: lease.run_id,
    step_id: lease.step_id,
    mode: "execute",
    reason: "incomplete_protocol",
    summary: "lease expired",
    observation_ids: [],
    fact_ids: [],
    finding_ids: [],
    blocked_on: null,
    reopen_rule: null,
    finish_requested: false,
    protocol_error: null,
  });
  assert.ok(e.storage.listResourceLocks("t-k08").length >= 2);
  e.cancel("t-k08");
  assert.equal(e.storage.listResourceLocks("t-k08").length, 0);
  e.close();
});

test("env dispatch writes an operations row and recover does not docker run again", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  docker.next = { stdout: JSON.stringify({ ok: true, elements: [] }), stderr: "", code: 0, timedOut: false };
  const e = kaliEngine(dir, docker);
  e.createCampaign(loadKaliSpec("t-k09"));
  const lease = kaliLease(e, "t-k09");
  const sent = e.dispatchGate.dispatch({
    lease,
    purpose: "playwright",
    payload: { kind: "playwright", op: "snapshot" },
    effect: "unknown",
    envTool: true,
  });
  assert.equal(sent.status, "sent");
  assert.equal(e.storage.getOperation(sent.execution_id!)?.execution_id, sent.execution_id);
  const runs = docker.calls.filter((c) => c[0] === "run").length;
  await e.reconcile("t-k09");
  assert.equal(docker.calls.filter((c) => c[0] === "run").length, runs);
  const listed = e.listOperations("t-k09");
  assert.equal(listed.length, 1);
  e.close();
  const e2 = kaliEngine(dir, docker);
  assert.equal(e2.storage.getOperation(sent.execution_id!)?.execution_id, sent.execution_id);
  assert.equal(e2.kali.inspectCampaign("t-k09"), "running");
  e2.kali.kill("t-k09");
  assert.equal(e2.kali.inspectCampaign("t-k09"), "missing");
  e2.close();
});

test("status lists residual after uncertain kali send and cancel does not claim retract", () => {
  const dir = tmp();
  const docker = new CrashExecDocker();
  const e = kaliEngine(dir, docker);
  e.createCampaign(loadKaliSpec("t-l13"));
  const lease = kaliLease(e, "t-l13");
  const sent = e.dispatchGate.dispatch({
    lease,
    purpose: "playwright",
    payload: { kind: "playwright", op: "goto", url: "https://lab.internal/" },
    effect: "unknown",
    envTool: true,
  });
  assert.equal(sent.status, "in_flight");
  e.cancel("t-l13");
  const st = e.status("t-l13") as {
    state: string;
    uncertain_invocations: { id: string }[];
    residual: { note: string; killable: boolean }[];
  };
  assert.equal(st.state, "cancelled");
  assert.ok(st.uncertain_invocations.length >= 1);
  assert.ok(st.residual.some((r) => /does not retract/.test(r.note)));
  assert.ok(e.logs.some((l) => /not retracted/.test(l)));
  e.close();
});

test("K08 successful kali dispatch releases locks so the next call can run", () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  docker.next = { stdout: JSON.stringify({ ok: true, url: "https://lab.internal/", elements: [] }), stderr: "", code: 0, timedOut: false };
  const e = kaliEngine(dir, docker);
  const spec = loadKaliSpec("t-k08b");
  e.createCampaign(spec);
  const lease = kaliLease(e, "t-k08b");
  const sent = e.dispatchGate.dispatch({
    lease,
    purpose: "playwright",
    payload: { kind: "playwright", op: "goto", url: "https://lab.internal/" },
    effect: "unknown",
    envTool: true,
  });
  assert.equal(sent.status, "sent");
  assert.equal(e.storage.listResourceLocks("t-k08b").length, 0);
  const again = e.dispatchGate.dispatch({
    lease,
    purpose: "playwright",
    payload: { kind: "playwright", op: "snapshot" },
    effect: "unknown",
    envTool: true,
  });
  assert.equal(again.status, "sent");
  e.close();
});

test("bash and curl stay synchronous even when timeout_ms exceeds 60s", () => {
  assert.equal(shouldBackgroundKali("bash", 180_000), false);
  assert.equal(shouldBackgroundKali("curl", 240_000), false);
  assert.equal(shouldBackgroundKali("python3", 600_000), false);
  assert.equal(shouldBackgroundKali("nmap", 30_000), true);
  const docker = new FakeDockerCli();
  docker.next = { stdout: "ok", stderr: "", code: 0, timedOut: false };
  const rt = new KaliRuntime(docker);
  const dir = tmp();
  const r = rt.exec(
    {
      campaignId: "c-sync",
      workspaceHost: join(dir, "ws"),
      dbPath: join(dir, "db.sqlite"),
      secretsPath: join(dir, "secrets.json"),
      artifactRoot: join(dir, "art"),
      dataDir: dir,
      allowAssets: [],
      network: "none",
    },
    "bash",
    ["/workspace/probe.sh"],
    { timeout_ms: 180_000 },
  );
  assert.equal(r.pending, undefined);
  assert.equal(r.code, 0);
  assert.equal(
    docker.calls.some((c) => c[0] === "exec" && c.includes("-d")),
    false,
  );
  const exec = docker.calls.find((c) => c[0] === "exec");
  assert.ok(exec);
  assert.ok(exec.includes("180"));
});

test("nmap is detached so dispatch does not wait, then poll ingests when exit file appears", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const e = kaliEngine(dir, docker);
  e.createCampaign(loadKaliSpec("t-bg"));
  const lease = kaliLease(e, "t-bg");
  const t0 = Date.now();
  const sent = e.dispatchGate.dispatch({
    lease,
    purpose: "kali_run",
    payload: { kind: "kali", bin: "nmap", args: ["-sn", "10.0.0.8"] },
    effect: "unknown",
    envTool: true,
  });
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(sent.status, "sent");
  assert.equal(sent.pending, true);
  assert.equal(e.storage.getOperation(sent.execution_id!)?.state, "running");
  assert.ok(docker.calls.some((c) => c[0] === "exec" && c.includes("-d")));
  assert.ok(e.storage.listResourceLocks("t-bg").length >= 1);
  const rec = await e.reconcile("t-bg");
  assert.equal(rec.still_running, 1);
  const opDir = join(dir, "workspace", "t-bg", ".rionext-ops");
  const id = String(sent.execution_id).replace(/[^a-zA-Z0-9_.-]/g, "_");
  mkdirSync(opDir, { recursive: true });
  writeFileSync(join(opDir, `${id}.out`), "Nmap done: 1 IP up");
  writeFileSync(join(opDir, `${id}.err`), "");
  writeFileSync(join(opDir, `${id}.exit`), "0\n");
  const done = await e.reconcile("t-bg");
  assert.equal(done.still_running, 0);
  assert.ok(done.reconciled >= 1);
  assert.equal(e.storage.listResourceLocks("t-bg").length, 0);
  const obs = e.storage.list("observations", "t-bg");
  assert.ok(obs.some((o) => String(o.subject).startsWith("kali_op:")));
  e.close();
});

