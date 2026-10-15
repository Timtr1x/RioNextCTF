/**
 * K01–K12: container init coordination — one creator per real container,
 * cancel isolation between waiters, ownership/fingerprint conflicts, and the
 * cross-process maintenance lock. Strict fakes only; real-Docker acceptance is
 * D03-D06 (tracked in docs/multiworker-stabilization.md).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../../src/domain/errors.ts";
import { ContainerInitCoordinator } from "../../src/tools/container-init.ts";
import { FakeDockerCli, type DockerCli, type DockerExecResult, type DockerRunOpts } from "../../src/tools/docker-cli.ts";
import { KaliEffectAdapter } from "../../src/tools/kali-adapter.ts";
import { KaliRuntime, acquireInitLock, containerName, type KaliStartOpts } from "../../src/tools/kali-runtime.ts";

const OK: DockerExecResult = { stdout: "", stderr: "", code: 0, timedOut: false };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-kinit-"));
}

function optsFor(dir: string, campaignId: string, shared?: { name: string; mountHost: string }): KaliStartOpts {
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
    shared: shared ? { ...shared, containerRoot: `/workspace/${campaignId}` } : undefined,
  };
}

function adapterFor(rt: KaliRuntime, opts: KaliStartOpts): KaliEffectAdapter {
  return new KaliEffectAdapter(rt, () => opts);
}

const runCreations = (docker: FakeDockerCli, name: string): number =>
  docker.calls.filter((c) => c[0] === "run" && c.includes("-d") && c.includes(name)).length;
const rmCalls = (docker: FakeDockerCli, name: string): number =>
  docker.calls.filter((c) => (c[0] === "rm" || c[0] === "kill") && c.includes(name)).length;

test("K01: two cold starts of the same missing container create it exactly once", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const coordinator = new ContainerInitCoordinator();
  const rtA = new KaliRuntime(docker, coordinator);
  const rtB = new KaliRuntime(docker, coordinator);
  const opts = optsFor(dir, "k01");
  // Park both first inspects behind one gate so both callers observe "missing"
  // before either can create.
  let release!: () => void;
  docker.gate = new Promise<void>((r) => (release = r));
  const p1 = adapterFor(rtA, opts).sendAsync("w1", { kind: "kali", bin: "cat", args: ["readme"] });
  const p2 = adapterFor(rtB, opts).sendAsync("w2", { kind: "kali", bin: "cat", args: ["readme"] });
  await new Promise((r) => setTimeout(r, 30));
  release();
  docker.gate = null;
  await p1;
  await p2;
  const name = containerName("k01");
  assert.equal(docker.created.size, 1, "exactly one container was created");
  assert.equal(runCreations(docker, name), 1, "exactly one docker run for the name");
  assert.ok(docker.alive.has(name));
});

test("K02: two KaliRuntime instances in the process share the coordinator entry", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const coordinator = new ContainerInitCoordinator();
  const rtA = new KaliRuntime(docker, coordinator);
  const rtB = new KaliRuntime(docker, coordinator);
  const opts = optsFor(dir, "k02");
  await adapterFor(rtA, opts).sendAsync("a0", { kind: "kali", bin: "cat", args: ["x"] });
  await adapterFor(rtB, opts).sendAsync("b0", { kind: "kali", bin: "cat", args: ["x"] });
  assert.equal(runCreations(docker, containerName("k02")), 1, "second runtime reused the running container");
});

test("K03: different campaigns sharing one contest container merge by container key", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const coordinator = new ContainerInitCoordinator();
  const rt = new KaliRuntime(docker, coordinator);
  const shared = { name: "rionext-kali-contest", mountHost: join(dir, "workspace") };
  await adapterFor(rt, optsFor(dir, "k03-a", shared)).sendAsync("a", { kind: "kali", bin: "cat", args: ["x"] });
  await adapterFor(rt, optsFor(dir, "k03-b", shared)).sendAsync("b", { kind: "kali", bin: "cat", args: ["x"] });
  assert.equal(runCreations(docker, "rionext-kali-contest"), 1, "one creation for the shared container");
  assert.ok(docker.alive.has("rionext-kali-contest"));
});

test("K04: different containers initialize independently", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const coordinator = new ContainerInitCoordinator();
  const rt = new KaliRuntime(docker, coordinator);
  await Promise.all([
    adapterFor(rt, optsFor(dir, "k04-a")).sendAsync("a", { kind: "kali", bin: "cat", args: ["x"] }),
    adapterFor(rt, optsFor(dir, "k04-b")).sendAsync("b", { kind: "kali", bin: "cat", args: ["x"] }),
  ]);
  assert.equal(docker.created.size, 2);
  assert.equal(runCreations(docker, containerName("k04-a")), 1);
  assert.equal(runCreations(docker, containerName("k04-b")), 1);
});

test("K05: cancelling one waiter fails only that waiter; the sibling completes", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const coordinator = new ContainerInitCoordinator();
  const rt = new KaliRuntime(docker, coordinator);
  const opts = optsFor(dir, "k05");
  let release!: () => void;
  docker.gate = new Promise<void>((r) => (release = r));
  const ctl = new AbortController();
  const adapter = adapterFor(rt, opts);
  const p1 = adapter.sendAsync("w1", { kind: "kali", bin: "cat", args: ["x"] }, ctl.signal).then(
    () => "ok" as const,
    (err) => (err instanceof DomainError && err.code === "cancelled" ? ("cancelled" as const) : ("other" as const)),
  );
  const p2 = adapter.sendAsync("w2", { kind: "kali", bin: "cat", args: ["x"] }).then(
    () => "ok" as const,
    () => "failed" as const,
  );
  await new Promise((r) => setTimeout(r, 30));
  ctl.abort();
  release();
  docker.gate = null;
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, "cancelled", "the cancelled waiter's own wait failed");
  assert.equal(r2, "ok", "the sibling was not affected by the cancellation");
  assert.equal(runCreations(docker, containerName("k05")), 1);
});

test("K06: when every waiter cancels, init stays bounded and a later attempt succeeds", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const coordinator = new ContainerInitCoordinator();
  const rt = new KaliRuntime(docker, coordinator);
  const opts = optsFor(dir, "k06");
  const c1 = new AbortController();
  const c2 = new AbortController();
  const adapter = adapterFor(rt, opts);
  const p1 = adapter.sendAsync("w1", { kind: "kali", bin: "cat", args: ["x"] }, c1.signal).catch(() => "cancelled");
  const p2 = adapter.sendAsync("w2", { kind: "kali", bin: "cat", args: ["x"] }, c2.signal).catch(() => "cancelled");
  c1.abort();
  c2.abort();
  await Promise.all([p1, p2]);
  // no entry may stay stuck: a fresh attempt must complete
  await adapter.sendAsync("w3", { kind: "kali", bin: "cat", args: ["x"] });
  assert.ok(docker.alive.has(containerName("k06")));
  assert.equal(coordinator.inFlight(containerName("k06")), false);
});

test("K07: a failed creation does not cache a rejection; the next attempt retries", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  const coordinator = new ContainerInitCoordinator();
  const rt = new KaliRuntime(docker, coordinator);
  const opts = optsFor(dir, "k07");
  const adapter = adapterFor(rt, opts);
  const origRun = docker.run.bind(docker);
  let sabotage = true;
  docker.run = (argv: string[], o?: DockerRunOpts): DockerExecResult => {
    if (sabotage && argv[0] === "run" && argv.includes("-d")) {
      sabotage = false;
      return { stdout: "", stderr: "simulated create failure", code: 1, timedOut: false };
    }
    return origRun(argv, o);
  };
  await assert.rejects(adapter.sendAsync("w1", { kind: "kali", bin: "cat", args: ["x"] }), /simulated create failure/);
  // retry succeeds against the same name
  await adapter.sendAsync("w2", { kind: "kali", bin: "cat", args: ["x"] });
  assert.equal(runCreations(docker, containerName("k07")), 1, "one successful creation after the failed attempt");
});

test("K08: a settled entry's cleanup never removes a newer retry's entry", async () => {
  const c = new ContainerInitCoordinator();
  await assert.rejects(c.join("k", "f", () => Promise.reject(new Error("first failure"))));
  const second = c.join("k", "f", () => new Promise((r) => setTimeout(() => r("second ok"), 20)));
  // let every stale finally run while the new entry is in flight
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(c.inFlight("k"), true, "the retry entry survives the old entry's cleanup");
  assert.equal(await second, "second ok");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(c.inFlight("k"), false, "the settled retry cleans itself up");
});

test("K09: a name conflict at create time reconciles by inspection — reuse, never rm -f", async () => {
  const dir = tmp();
  const coordinator = new ContainerInitCoordinator();
  let seenFirstInspect = false;
  const calls: string[][] = [];
  const docker: DockerCli = {
    available: () => true,
    run(argv: string[]): DockerExecResult {
      calls.push(argv);
      if (argv[0] === "image") return { ...OK, stdout: "sha256:f\n" };
      if (argv[0] === "inspect" && argv.some((a) => a.includes("Config.Labels"))) {
        return { ...OK, stdout: '{"rionext.from":"master"}' };
      }
      if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) {
        if (!seenFirstInspect) {
          seenFirstInspect = true;
          return { stdout: "", stderr: "No such object", code: 1, timedOut: false };
        }
        return { ...OK, stdout: "true\n" };
      }
      if (argv[0] === "run" && argv.includes("-d")) {
        return { stdout: "", stderr: 'Conflict. The container name "/x" is already in use by container "abc".', code: 1, timedOut: false };
      }
      return OK;
    },
    async runAsync(argv: string[]): Promise<DockerExecResult> {
      return this.run(argv);
    },
  };
  const rt = new KaliRuntime(docker, coordinator);
  const opts = optsFor(dir, "k09");
  await adapterFor(rt, opts).sendAsync("w1", { kind: "kali", bin: "cat", args: ["x"] });
  assert.equal(calls.filter((c) => c[0] === "rm" || c[0] === "kill").length, 0, "conflict path never removes anything");
});

test("K10: a same-name foreign or mismatched container is an explicit conflict, never deleted", async () => {
  for (const labels of [{ "rionext.from": "other" }, { "rionext.from": "master", "rionext.fp": "somebody-else" }]) {
    const dir = tmp();
    const docker = new FakeDockerCli();
    const coordinator = new ContainerInitCoordinator();
    const rt = new KaliRuntime(docker, coordinator);
    const opts = optsFor(dir, "k10");
    const name = containerName("k10");
    // pre-create the container with the foreign/mismatched labels
    docker.alive.add(name);
    docker.created.add(name);
    docker.labels.set(name, labels as Record<string, string>);
    await assert.rejects(adapterFor(rt, opts).sendAsync("w1", { kind: "kali", bin: "cat", args: ["x"] }), (e: unknown) => {
      assert.ok(e instanceof DomainError);
      assert.equal(e.code, "kali_init_conflict");
      return true;
    });
    assert.equal(rmCalls(docker, name), 0, "the foreign container was not removed");
    assert.ok(docker.alive.has(name), "the foreign container still runs");
  }
});

test("K11: two processes coordinate through the data-dir init lock without deleting each other", async () => {
  const dir = tmp();
  const docker = new FakeDockerCli();
  // Two separate coordinators simulate two OS processes.
  const rtA = new KaliRuntime(docker, new ContainerInitCoordinator());
  const rtB = new KaliRuntime(docker, new ContainerInitCoordinator());
  const opts = optsFor(dir, "k11");
  const name = containerName("k11");
  // Hold A's creation until B has tried and failed to take the lock.
  const origRunAsync = docker.runAsync.bind(docker);
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((r) => (releaseCreate = r));
  let creating = false;
  docker.runAsync = async (argv: string[], o?: DockerRunOpts): Promise<DockerExecResult> => {
    if (argv[0] === "run" && argv.includes("-d") && argv.includes(name) && !creating) {
      creating = true;
      await createGate;
    }
    return origRunAsync(argv, o);
  };
  const a = adapterFor(rtA, opts).sendAsync("w1", { kind: "kali", bin: "cat", args: ["x"] });
  // give A time to pass inspect and park inside the creation
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(creating, "A is parked in the container creation");
  const b = adapterFor(rtB, opts).sendAsync("w2", { kind: "kali", bin: "cat", args: ["x"] });
  await new Promise((r) => setTimeout(r, 60));
  releaseCreate();
  await a;
  await b;
  assert.equal(runCreations(docker, name), 1, "exactly one process created the container");
  assert.equal(rmCalls(docker, name), 0, "no process removed the peer's container");
});

test("K12: pw-daemon merges the first browser launch and keeps sessions per run", () => {
  // Source-level regression for the daemon's shared-init shape; the behavioral
  // browser isolation check is part of the real-Docker acceptance (D04).
  const src = readFileSync(join(process.cwd(), "docker/kali/pw/pw-daemon.mjs"), "utf8");
  assert.match(src, /let browserLaunch/, "a single shared launch promise exists");
  assert.match(src, /browserLaunch = chromium/, "the launch promise is registered before any await");
  assert.match(src, /sessionStarts/, "per-session creation is merged per run id");
  assert.match(src, /browserLaunch = null/, "a failed launch clears the cache for retry");
});

test("init lock: a fresh lock blocks, a stale lock is broken, release is token-checked", () => {
  const dir = tmp();
  const first = acquireInitLock(dir, "box", "fp1");
  assert.ok(first);
  assert.equal(acquireInitLock(dir, "box", "fp1"), null, "a fresh lock blocks a second acquirer");
  first!.release();
  const second = acquireInitLock(dir, "box", "fp1");
  assert.ok(second, "released lock can be reacquired");
  // stale: backdate beyond the TTL by rewriting the file
  const path = join(dir, "locks", "init-box.lock");
  writeFileSync(path, JSON.stringify({ token: "old", pid: 0, name: "box", fingerprint: "fp1", at: Date.now() - 10 * 60_000 }));
  const third = acquireInitLock(dir, "box", "fp1");
  assert.ok(third, "a stale lock is broken");
  third!.release();
});
