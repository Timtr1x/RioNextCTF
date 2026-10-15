/**
 * E15–E17: persistent kali execution records and cancellation that confirms
 * the in-container process group, never trusting a host-client kill and never
 * killing on a stale pid or mismatched container identity.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeDockerCli, type DockerCli, type DockerExecResult, type DockerRunOpts } from "../../src/tools/docker-cli.ts";
import { KaliRuntime, writeExecRecord, readExecRecord, type KaliStartOpts } from "../../src/tools/kali-runtime.ts";

const OK: DockerExecResult = { stdout: "", stderr: "", code: 0, timedOut: false };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-xrec-"));
}

function optsFor(dir: string, campaignId: string): KaliStartOpts {
  return {
    campaignId,
    workspaceHost: join(dir, "workspace", campaignId),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: [],
    network: "none",
    capabilities: ["ctf"],
  };
}

test("E15: a foreground exec writes a persistent record; a restarted runtime reads it", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "e15");
  const r = await rt.execAsync(opts, "cat", ["readme"], { executionId: "kali_inv_e15" });
  assert.equal(r.code, 0);
  const recordPath = join(dir, "workspace", "e15", ".rionext-ops", "kali_inv_e15.json");
  const record = readExecRecord(recordPath);
  assert.ok(record, "record persisted");
  assert.equal(record!.phase, "ended");
  assert.equal(record!.code, 0);
  assert.equal(record!.container, "rionext-kali-e15");
  assert.deepEqual(record!.argv_preview, ["cat", "readme"]);
  assert.ok(record!.ended_at);
  // a fresh runtime (process restart, empty memory) answers from the record
  const rt2 = new KaliRuntime(docker);
  assert.equal(await rt2.backgroundStatusAsync(opts, "kali_inv_e15"), "completed");
});

test("E15: a background exec keeps its exit file and its record agrees", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "e15b");
  const r = await rt.execAsync(opts, "cat", ["readme"], { executionId: "kali_inv_e15b", background: true });
  assert.equal(r.pending, true);
  const recordPath = join(dir, "workspace", "e15b", ".rionext-ops", "kali_inv_e15b.json");
  const record = readExecRecord(recordPath);
  assert.ok(record);
  assert.equal(record!.phase, "started");
  // the background script writes its own pid marker first
  const script = readFileSync(join(dir, "workspace", "e15b", ".rionext-ops", "kali_inv_e15b.sh"), "utf8");
  assert.match(script, /echo \$\$ > /);
});

/** Probe-driven fake: the container reports the process alive once, then dead. */
class CancelFake implements DockerCli {
  calls: string[][] = [];
  killed = false;
  private probes = 0;
  constructor(private readonly firstProbe: "alive" | "dead" = "alive") {}
  available(): boolean {
    return true;
  }
  run(argv: string[], _o?: DockerRunOpts): DockerExecResult {
    this.calls.push(argv);
    if (argv[0] === "image") return { ...OK, stdout: "sha256:f\n" };
    if (argv[0] === "inspect" && argv.some((a) => a.includes("Config.Labels"))) return { ...OK, stdout: '{"rionext.from":"master"}' };
    if (argv[0] === "inspect") return { ...OK, stdout: "true\n" };
    return OK;
  }
  async runAsync(argv: string[], _o?: DockerRunOpts): Promise<DockerExecResult> {
    this.calls.push(argv);
    if (argv[0] === "image") return { ...OK, stdout: "sha256:f\n" };
    if (argv[0] === "inspect" && argv.some((a) => a.includes("Config.Labels"))) return { ...OK, stdout: '{"rionext.from":"master"}' };
    if (argv[0] === "inspect") return { ...OK, stdout: "true\n" };
    if (argv[0] === "exec") {
      const script = String(argv[argv.length - 1] ?? "");
      if (script.includes("kill -TERM")) {
        this.killed = true;
        return OK;
      }
      if (script.includes("kill -0")) {
        this.probes += 1;
        return { ...OK, stdout: this.probes === 1 && this.firstProbe === "alive" ? "alive\n" : "dead\n" };
      }
    }
    return OK;
  }
}

test("E17: cancel probes the persisted pid marker, kills the process group, and confirms", async () => {
  const dir = tmp();
  const docker = new CancelFake();
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "e17");
  const recordPath = join(dir, "workspace", "e17", ".rionext-ops", "kali_inv_e17.json");
  writeExecRecord(recordPath, {
    execution_id: "kali_inv_e17",
    container: "rionext-kali-e17",
    run_id: null,
    argv_preview: ["nmap"],
    phase: "started",
    started_at: new Date().toISOString(),
  });
  const result = await rt.cancelExecution(opts, "kali_inv_e17");
  assert.equal(result, "confirmed");
  assert.ok(docker.killed, "the process group was terminated");
  const after = readExecRecord(recordPath);
  assert.equal(after!.cancel_requested, true);
  assert.equal(after!.cancel_confirmed, true);
});

test("E16: a record/container identity mismatch refuses to signal anything", async () => {
  const dir = tmp();
  const docker = new CancelFake();
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "e16");
  writeExecRecord(join(dir, "workspace", "e16", ".rionext-ops", "kali_inv_e16.json"), {
    execution_id: "kali_inv_e16",
    container: "somebody-elses-container",
    run_id: null,
    argv_preview: ["nmap"],
    phase: "started",
    started_at: new Date().toISOString(),
  });
  const result = await rt.cancelExecution(opts, "kali_inv_e16");
  assert.equal(result, "unknown");
  assert.equal(docker.killed, false);
  assert.equal(docker.calls.filter((c) => c[0] === "exec").length, 0, "no probe, no kill: identity first");
});

test("E17: a dead pid marker confirms without signaling (pid reuse is safe)", async () => {
  const dir = tmp();
  const docker = new CancelFake("dead");
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "e17b");
  writeExecRecord(join(dir, "workspace", "e17b", ".rionext-ops", "kali_inv_e17b.json"), {
    execution_id: "kali_inv_e17b",
    container: "rionext-kali-e17b",
    run_id: null,
    argv_preview: ["sleep"],
    phase: "started",
    started_at: new Date().toISOString(),
  });
  const result = await rt.cancelExecution(opts, "kali_inv_e17b");
  assert.equal(result, "confirmed");
  assert.equal(docker.killed, false, "nothing alive with this invocation marker — no signal sent");
});

test("E17: killing the host docker client triggers the in-container cancel probe", async () => {
  const dir = tmp();
  const docker = new CancelFake();
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "e17c");
  const ctl = new AbortController();
  ctl.abort(); // the host client is dead on arrival
  await rt.execAsync(opts, "cat", ["x"], { executionId: "kali_inv_e17c", signal: ctl.signal });
  const probed = docker.calls.some((c) => c[0] === "exec" && String(c[c.length - 1]).includes("kill -0"));
  assert.ok(probed, "the abort path confirmed the container side instead of assuming");
});

test("P1-05: a failed docker probe is unknown, never a confirmation", async () => {
  const dir = tmp();
  const docker = new CancelFake();
  // break the probe: docker exec itself errors out
  const orig = docker.runAsync.bind(docker);
  docker.runAsync = async (argv: string[], o?: DockerRunOpts): Promise<DockerExecResult> => {
    const script = String(argv[argv.length - 1] ?? "");
    if (argv[0] === "exec" && script.includes("kill -0")) {
      return { stdout: "", stderr: "docker daemon exploded", code: 1, timedOut: false };
    }
    return orig(argv, o);
  };
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "p15a");
  const recordPath = join(dir, "workspace", "p15a", ".rionext-ops", "kali_inv_p15a.json");
  writeExecRecord(recordPath, {
    execution_id: "kali_inv_p15a",
    container: "rionext-kali-p15a",
    run_id: null,
    argv_preview: ["sleep"],
    phase: "started",
    started_at: new Date().toISOString(),
  });
  const result = await rt.cancelExecution(opts, "kali_inv_p15a");
  assert.equal(result, "unknown", "a failed probe proves nothing");
  const after = readExecRecord(recordPath);
  assert.notEqual(after?.cancel_confirmed, true, "no confirmation was written");
});

test("P1-05: container missing without an exit record stays unknown at every layer", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli(); // nothing created: the container is missing
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "p15b");
  assert.equal(await rt.backgroundStatusAsync(opts, "kali_inv_p15b"), "unknown", "no exit record, no failed inference");
  const { KaliEffectAdapter } = await import("../../src/tools/kali-adapter.ts");
  const adapter = new KaliEffectAdapter(rt, () => opts);
  const ev = await adapter.queryEvidence("kali_inv_p15b");
  assert.equal(ev.status, "unknown", "queryEvidence never downgrades missing-container to failed/not_started");
});

test("P1-05: a reused container name with a different container id refuses to signal", async () => {
  const dir = tmp();
  const docker = new CancelFake();
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "p15c");
  const recordPath = join(dir, "workspace", "p15c", ".rionext-ops", "kali_inv_p15c.json");
  writeExecRecord(recordPath, {
    execution_id: "kali_inv_p15c",
    container: "rionext-kali-p15c",
    container_id: "cid-the-original",
    run_id: null,
    argv_preview: ["sleep"],
    phase: "started",
    started_at: new Date().toISOString(),
  });
  // the fake answers {{.Id}} with a DIFFERENT id: the name was reused
  const orig = docker.runAsync.bind(docker);
  docker.runAsync = async (argv: string[], o?: DockerRunOpts): Promise<DockerExecResult> => {
    if (argv[0] === "inspect" && argv.some((a) => a.includes("{{.Id}}"))) return { stdout: "cid-somebody-else\n", stderr: "", code: 0, timedOut: false };
    return orig(argv, o);
  };
  const result = await rt.cancelExecution(opts, "kali_inv_p15c");
  assert.equal(result, "unknown");
  assert.equal(docker.killed, false, "the reused container was never signaled");
});

test("P1-05: an unknown cancel never lets the record be written as ended", async () => {
  const dir = tmp();
  const docker = new CancelFake();
  // every probe errors: the container state is unknowable
  const orig = docker.runAsync.bind(docker);
  docker.runAsync = async (argv: string[], o?: DockerRunOpts): Promise<DockerExecResult> => {
    const script = String(argv[argv.length - 1] ?? "");
    if (argv[0] === "exec" && (script.includes("kill -0") || script.includes("kill -TERM"))) {
      return { stdout: "", stderr: "daemon gone", code: 1, timedOut: false };
    }
    return orig(argv, o);
  };
  const rt = new KaliRuntime(docker);
  const opts = optsFor(dir, "p15d");
  const ctl = new AbortController();
  ctl.abort();
  await rt.execAsync(opts, "cat", ["x"], { executionId: "kali_inv_p15d", signal: ctl.signal });
  const record = readExecRecord(join(dir, "workspace", "p15d", ".rionext-ops", "kali_inv_p15d.json"));
  assert.ok(record);
  assert.equal(record!.phase, "started", "unknown container state is not an ended record");
});
