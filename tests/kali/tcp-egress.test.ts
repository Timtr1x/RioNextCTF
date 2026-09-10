import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../../src/domain/errors.ts";
import { checkEgress, parseAllowList, parseDestination } from "../../src/tools/egress.ts";
import type { DockerExecResult, DockerRunOpts } from "../../src/tools/docker-cli.ts";
import { KaliRuntime } from "../../src/tools/kali-runtime.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-tcp-"));
}

function okResult(): DockerExecResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false };
}

/** Minimal docker fake: every call succeeds, argv recorded. */
class RecordingDocker {
  calls: string[][] = [];
  available(): boolean {
    return true;
  }
  run(argv: string[], _opts?: DockerRunOpts): DockerExecResult {
    this.calls.push(argv);
    if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) return { ...okResult(), stdout: "true\n" };
    if (argv[0] === "image") return { ...okResult(), stdout: "sha256:fake\n" };
    return okResult();
  }
}

test("parseDestination accepts tcp with explicit port, rejects the rest", () => {
  const d = parseDestination("tcp://10.0.0.5:31337");
  assert.equal(d.protocol, "tcp");
  assert.equal(d.host, "10.0.0.5");
  assert.equal(d.port, 31337);
  assert.throws(
    () => parseDestination("tcp://10.0.0.5"),
    (e: unknown) => e instanceof DomainError && e.code === "dest_port",
  );
  assert.throws(
    () => parseDestination("ftp://10.0.0.5:21"),
    (e: unknown) => e instanceof DomainError && e.code === "dest_protocol",
  );
});

test("port-constrained allow entries gate tcp destinations by port", () => {
  const allow = parseAllowList(["pwn.example:31337"]);
  const resolve = (h: string) => (h === "pwn.example" ? ["10.9.9.9"] : []);
  const good = checkEgress(parseDestination("tcp://pwn.example:31337"), allow, resolve);
  assert.equal(good.ok, true);
  const badPort = checkEgress(parseDestination("tcp://pwn.example:4444"), allow, resolve);
  assert.equal(badPort.ok, false);
  if (!badPort.ok) assert.match(badPort.reason, /port_not_allowed/);
});

test("nc host port pairs pass egress only for the allowed endpoint", () => {
  const dir = tmp();
  const docker = new RecordingDocker();
  const rt = new KaliRuntime(docker as never);
  const opts = {
    campaignId: "c1",
    workspaceHost: join(dir, "workspace", "c1"),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: ["pwn.example:31337"],
    network: "allowlist" as const,
    resolve: (h: string) => (h === "pwn.example" ? ["10.9.9.9"] : []),
    challengeKind: "pwn",
  };
  const okExec = rt.exec(opts, "nc", ["pwn.example", "31337"]);
  assert.equal(okExec.code, 0);
  assert.throws(
    () => rt.exec(opts, "nc", ["pwn.example", "4444"]),
    (e: unknown) => e instanceof DomainError && e.code === "egress_denied",
  );
  assert.throws(
    () => rt.exec(opts, "nc", ["other.example", "31337"]),
    (e: unknown) => e instanceof DomainError && e.code === "egress_denied",
  );
});

test("socat TCP:host:port args are egress-checked", () => {
  const dir = tmp();
  const docker = new RecordingDocker();
  const rt = new KaliRuntime(docker as never);
  const opts = {
    campaignId: "c2",
    workspaceHost: join(dir, "workspace", "c2"),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: ["pwn.example:31337"],
    network: "allowlist" as const,
    resolve: (h: string) => (h === "pwn.example" ? ["10.9.9.9"] : []),
    challengeKind: "pwn",
  };
  assert.equal(rt.exec(opts, "socat", ["-", "TCP:pwn.example:31337"]).code, 0);
  assert.throws(() => rt.exec(opts, "socat", ["-", "TCP:pwn.example:22"]));
});

test("kind flows into the binary allowlist at exec time", () => {
  const dir = tmp();
  const docker = new RecordingDocker();
  const rt = new KaliRuntime(docker as never);
  const base = {
    campaignId: "c3",
    workspaceHost: join(dir, "workspace", "c3"),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: [] as string[],
    network: "none" as const,
  };
  // web campaign: gdb is denied even though the binary exists in the image
  assert.throws(() => rt.exec({ ...base, challengeKind: "web" }, "gdb", ["--version"]), /not allowlisted/);
  // reverse campaign: allowed
  assert.equal(rt.exec({ ...base, challengeKind: "reverse" }, "gdb", ["--version"]).code, 0);
  // legacy callers without challengeKind keep web semantics
  assert.throws(() => rt.exec(base, "gdb", ["--version"]), /not allowlisted/);
});
