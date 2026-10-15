import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KaliEffectAdapter } from "../../src/tools/kali-adapter.ts";
import type { DockerExecResult, DockerRunOpts } from "../../src/tools/docker-cli.ts";
import { ContainerInitCoordinator } from "../../src/tools/container-init.ts";
import { KaliRuntime, type KaliStartOpts } from "../../src/tools/kali-runtime.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-asyncx-"));
}

const OK: DockerExecResult = { stdout: "", stderr: "", code: 0, timedOut: false };

/** Docker fake that can hold one container's foreground execs indefinitely. */
class GateDocker {
  calls: string[][] = [];
  heldContainers = new Set<string>();
  private releaseFns: (() => void)[] = [];

  run(argv: string[], _opts?: DockerRunOpts): DockerExecResult {
    this.calls.push([...argv]);
    if (argv[0] === "inspect" && argv.some((a) => a.includes("Config.Labels"))) return { ...OK, stdout: '{"rionext.from":"master"}' };
    if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) return { ...OK, stdout: "true\n" };
    if (argv[0] === "image") return { ...OK, stdout: "sha256:fake\n" };
    return OK;
  }

  async runAsync(argv: string[], opts?: DockerRunOpts): Promise<DockerExecResult> {
    this.calls.push([...argv]);
    if (argv[0] === "inspect" && argv.some((a) => a.includes("Config.Labels"))) return { ...OK, stdout: '{"rionext.from":"master"}' };
    if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) return { ...OK, stdout: "true\n" };
    if (argv[0] === "image") return { ...OK, stdout: "sha256:fake\n" };
    // foreground exec: ["exec","-w",root,<name>,"timeout",...]
    if (argv[0] === "exec" && argv[1] === "-w" && !argv.includes("-d")) {
      const name = String(argv[3] ?? "");
      if (this.heldContainers.has(name)) {
        await new Promise<void>((r) => this.releaseFns.push(r));
      }
    }
    void opts;
    return OK;
  }

  release(): void {
    for (const r of this.releaseFns.splice(0)) r();
  }
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

test("C1: while one foreground tool is held, the sibling's tool actually starts and finishes", async () => {
  const dir = tmp();
  const docker = new GateDocker();
  const rt = new KaliRuntime(docker as never, new ContainerInitCoordinator());
  const adapter = new KaliEffectAdapter(rt, (invocationId) => optsFor(dir, invocationId.startsWith("a") ? "a" : "b"));

  // warm both containers (ensure) without any gate
  await adapter.sendAsync("a0", { kind: "kali", bin: "cat", args: ["readme"] });
  await adapter.sendAsync("b0", { kind: "kali", bin: "cat", args: ["readme"] });

  // hold A's foreground exec; A's call reaches docker and then waits
  docker.heldContainers.add("rionext-kali-a");
  const aPending = adapter.sendAsync("a1", { kind: "kali", bin: "cat", args: ["big"] });
  await new Promise((r) => setTimeout(r, 50));
  const aExecCalls = docker.calls.filter((c) => c[0] === "exec" && c[3] === "rionext-kali-a" && !c.includes("-d"));
  assert.ok(aExecCalls.length >= 1, "A's exec actually started");

  // B starts and completes while A is still held
  const bResult = await adapter.sendAsync("b1", { kind: "kali", bin: "cat", args: ["work"] });
  assert.equal(bResult.pending ?? false, false);
  const bExecCalls = docker.calls.filter((c) => c[0] === "exec" && c[3] === "rionext-kali-b" && !c.includes("-d"));
  assert.ok(bExecCalls.length >= 1, "B's exec started while A was held");

  // release A; both settle
  docker.release();
  const aResult = await aPending;
  assert.equal(aResult.pending ?? false, false);
});

test("C1: aborting one invocation's signal kills only its own exec", async () => {
  const dir = tmp();
  const docker = new GateDocker();
  const rt = new KaliRuntime(docker as never, new ContainerInitCoordinator());
  const adapter = new KaliEffectAdapter(rt, (invocationId) => optsFor(dir, invocationId.startsWith("a") ? "a" : "b"));
  await adapter.sendAsync("a0", { kind: "kali", bin: "cat", args: ["readme"] });
  await adapter.sendAsync("b0", { kind: "kali", bin: "cat", args: ["readme"] });

  // hold every foreground exec; abort only A
  docker.heldContainers.add("rionext-kali-a");
  docker.heldContainers.add("rionext-kali-b");
  const ctrl = new AbortController();
  const aPending = adapter.sendAsync("a1", { kind: "kali", bin: "cat", args: ["slow"] }, ctrl.signal);
  const bPending = adapter.sendAsync("b1", { kind: "kali", bin: "cat", args: ["slow"] });
  await new Promise((r) => setTimeout(r, 50));
  ctrl.abort();
  docker.release();
  await aPending;
  await bPending;
  // the abort path is per-invocation; nothing at campaign level was killed
  assert.ok(docker.calls.every((c) => c[0] !== "kill" && c[0] !== "rm"), "no container-level kill happened");
});
