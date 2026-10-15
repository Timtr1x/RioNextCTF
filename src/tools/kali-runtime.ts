import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "../domain/errors.ts";
import { hashJson } from "../domain/fingerprint.ts";
import { ContainerInitCoordinator, processInitCoordinator } from "./container-init.ts";
import type { DockerCli, DockerExecResult } from "./docker-cli.ts";
import { ProcessDockerCli } from "./docker-cli.ts";
import { checkEgress, checkRedirect, isLoopbackHost, parseAllowList, parseDestination, type AllowEntry, type ResolveFn } from "./egress.ts";
import {
  assertKaliArgv,
  DEFAULT_KALI_LIMITS,
  KALI_IMAGE,
  KALI_KEEPER_NAME,
  KALI_MASTER_TAG,
  PLAYWRIGHT_OPS,
  shouldBackgroundKali,
  workspaceRelPath,
  type ToolCapability,
} from "./kali-profile.ts";

/**
 * Shared-container mode (contest supervisor): several campaigns exec into ONE
 * container. The container mounts `mountHost` (the workspace parent dir) at
 * /workspace; each campaign's container-side root is `containerRoot`
 * (/workspace/<campaignId>). Host-side paths (workspaceHost, opFiles, artifact
 * staging) stay per-campaign and are unchanged.
 */
export interface KaliSharedSpec {
  name: string;
  mountHost: string;
  containerRoot: string;
}

export interface KaliStartOpts {
  campaignId: string;
  workspaceHost: string;
  dbPath: string;
  secretsPath: string;
  artifactRoot: string;
  dataDir: string;
  allowAssets: string[];
  network: "none" | "allowlist" | "bridge";
  image?: string;
  resolve?: ResolveFn;
  /** Resolved tool capabilities drive the binary allowlist; absent means legacy web. */
  capabilities?: ToolCapability[];
  /** Per-run private working directory under the campaign root (C4). */
  runId?: string;
  shared?: KaliSharedSpec;
  /** Container resource overrides; defaults come from DEFAULT_KALI_LIMITS. */
  limits?: { memory?: string; cpus?: string };
}

export interface ContainerSpec {
  name: string;
  argv: string[];
  mounts: { host: string; container: string; mode: "rw" | "ro" }[];
  env: Record<string, string>;
  network: string;
  image: string;
  /** Config identity: same container name + different fingerprint is a conflict. */
  fingerprint: string;
}

export function containerName(campaignId: string): string {
  return `rionext-kali-${campaignId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40)}`;
}

export function dockerVolumePath(hostPath: string): string {
  const n = hostPath.replace(/\\/g, "/");
  const m = n.match(/^([A-Za-z]):(.*)$/);
  if (m) return `/${m[1]!.toLowerCase()}${m[2]}`;
  return n;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Host entrypoint overlay. Avoids rebuilding the 12.9GB master for script-only fixes. */
export function kaliEntrypointHost(): string | undefined {
  const candidates = [
    join(process.cwd(), "docker/kali/entrypoint.sh"),
    join(here, "../../../docker/kali/entrypoint.sh"),
    join(here, "../../../../docker/kali/entrypoint.sh"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

function forbiddenMount(host: string, forbidden: string[]): boolean {
  const a = host.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return forbidden.some((f) => {
    const b = f.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!b) return false;
    // Mounting the secret itself, or a parent of it, would leak controller files.
    return a === b || b.startsWith(`${a}/`);
  });
}

export function buildContainerSpec(opts: KaliStartOpts): ContainerSpec {
  const name = opts.shared?.name ?? containerName(opts.campaignId);
  const mountHost = opts.shared?.mountHost ?? opts.workspaceHost;
  const containerRoot = opts.shared?.containerRoot ?? "/workspace";
  mkdirSync(mountHost, { recursive: true });
  const workspace = dockerVolumePath(mountHost);
  const forbidden = [opts.dbPath, opts.secretsPath, opts.artifactRoot, opts.dataDir].filter(Boolean);
  if (forbiddenMount(mountHost, forbidden.filter((p) => p !== mountHost))) {
    throw new DomainError("kali_mount", "workspace collides with controller paths", "denied");
  }
  const env: Record<string, string> = {
    HOME: "/home/rionext",
    LANG: "C.UTF-8",
    RIONEXT_CAMPAIGN: opts.campaignId,
    PLAYWRIGHT_BROWSERS_PATH: "/opt/pw-browsers",
    DISABLE_UPDATE_CHECK: "true",
  };
  const mounts = [{ host: mountHost, container: "/workspace", mode: "rw" as const }];
  const argv: string[] = [
    "run",
    "-d",
    "--name",
    name,
    "--hostname",
    "kali",
    "--workdir",
    containerRoot,
    "--memory",
    opts.limits?.memory ?? DEFAULT_KALI_LIMITS.memory,
    "--cpus",
    opts.limits?.cpus ?? DEFAULT_KALI_LIMITS.cpus,
    "--pids-limit",
    String(DEFAULT_KALI_LIMITS.pids),
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_RAW",
    "--cap-add",
    "NET_BIND_SERVICE",
    "--security-opt",
    "no-new-privileges=true",
    "--tmpfs",
    "/tmp:rw,nosuid,size=512m",
    "--tmpfs",
    "/dev/shm:rw,size=512m",
    "--shm-size",
    "512m",
    "-v",
    `${workspace}:/workspace:rw`,
  ];
  const entrypointHost = kaliEntrypointHost();
  if (entrypointHost) {
    argv.push("-v", `${dockerVolumePath(entrypointHost)}:/usr/local/bin/rionext-entrypoint:ro`);
    // Windows bind mounts often lack +x; sh can still run the overlay.
    argv.push("--entrypoint", "/bin/sh");
  }
  const network = opts.network === "none" ? "none" : "bridge";
  argv.push("--network", network);
  if (opts.network === "allowlist") {
    const ips = collectAllowIps(opts.allowAssets, opts.resolve ?? defaultResolve);
    env.RIONEXT_ALLOW_IPS = ips.join(",");
  }
  for (const [k, v] of Object.entries(env)) {
    argv.push("-e", `${k}=${v}`);
  }
  // The fingerprint pins the config identity of this container name: image,
  // mounts, network and the security-relevant limits. Two different configs
  // sharing one name is an explicit conflict, never a silent rebuild. The
  // --workdir is intentionally excluded: for shared containers it is the first
  // creator's per-campaign root, while every exec passes its own -w anyway.
  const fingerprint = hashJson({
    image: opts.image ?? KALI_IMAGE,
    network,
    mountHost: dockerVolumePath(mountHost),
    memory: opts.limits?.memory ?? DEFAULT_KALI_LIMITS.memory,
    cpus: opts.limits?.cpus ?? DEFAULT_KALI_LIMITS.cpus,
    pids: DEFAULT_KALI_LIMITS.pids,
    entrypoint: Boolean(entrypointHost),
  });
  argv.push("--label", `rionext.campaign=${opts.campaignId}`);
  argv.push("--label", "rionext.from=master");
  argv.push("--label", `rionext.fp=${fingerprint}`);
  if (entrypointHost) {
    argv.push(opts.image ?? KALI_IMAGE, "/usr/local/bin/rionext-entrypoint", "sleep", "infinity");
  } else {
    argv.push(opts.image ?? KALI_IMAGE, "sleep", "infinity");
  }
  assertNoSecretEnv(env);
  assertMountsSafe(mounts, forbidden);
  return { name, argv, mounts, env, network, image: opts.image ?? KALI_IMAGE, fingerprint };
}

export function collectAllowIps(assets: string[], resolve: ResolveFn): string[] {
  const allow = parseAllowList(assets);
  const ips = new Set<string>();
  for (const e of allow) {
    if (e.cidr) {
      const base = e.cidr.split("/")[0];
      if (base) ips.add(base);
    }
    if (e.host) {
      try {
        for (const ip of resolve(e.host)) ips.add(ip);
      } catch {
        // host-only entries still go through gateway DNS check at exec time
      }
    }
  }
  return [...ips];
}

const resolveCache = new Map<string, string[]>();

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Parse `getent hosts` / similar lines: `117.21.200.176  alias fqdn`. */
export function parseGetentHosts(stdout: string): string[] {
  const ips: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const ip = line.trim().split(/\s+/)[0];
    if (ip && isIpv4(ip)) ips.push(ip);
  }
  return [...new Set(ips)];
}

/**
 * OS GetAddrInfo (`dns.lookup`), not c-ares `resolve4`.
 * resolve4 walks every adapter DNS server and stops on REFUSED, so a stale
 * VMware/campus resolver can fail while Windows lookup still works.
 */
export function systemLookup4(host: string): string[] {
  const script = `require("node:dns").lookup(${JSON.stringify(host)},{family:4,all:true},(e,a)=>{if(e){process.stderr.write(String(e.message||e));process.exit(1)}process.stdout.write((a||[]).map((x)=>x.address).join("\\n"))})`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (r.status !== 0) return [];
  return [...new Set(String(r.stdout).split(/\s+/).map((s) => s.trim()).filter((s) => isIpv4(s)))];
}

function dockerResolve4(host: string): string[] {
  const r = spawnSync(
    "docker",
    ["run", "--rm", "--network", "bridge", "--entrypoint", "getent", KALI_IMAGE, "hosts", host],
    { encoding: "utf8", timeout: 20_000, windowsHide: true },
  );
  if ((r.status ?? 1) !== 0) return [];
  return parseGetentHosts(String(r.stdout ?? ""));
}

function defaultResolve(host: string): string[] {
  if (isIpv4(host)) return [host];
  const cached = resolveCache.get(host);
  if (cached) return cached;
  const fromOs = systemLookup4(host);
  if (fromOs.length) {
    resolveCache.set(host, fromOs);
    return fromOs;
  }
  const fromDocker = dockerResolve4(host);
  if (fromDocker.length) {
    resolveCache.set(host, fromDocker);
    return fromDocker;
  }
  throw new DomainError("dns_failed", `dns_failed:${host}`, "denied");
}

/** Async DNS for worker paths: native dns.promises first, docker getent as the
 *  cold fallback. Never spawnSync's a child for a warm lookup. */
export async function defaultResolveAsync(host: string): Promise<string[]> {
  if (isIpv4(host)) return [host];
  const cached = resolveCache.get(host);
  if (cached) return cached;
  try {
    const { lookup } = await import("node:dns/promises");
    const rows = await lookup(host, { family: 4, all: true });
    const ips = [...new Set(rows.map((r) => r.address).filter((a) => isIpv4(a)))];
    if (ips.length) {
      resolveCache.set(host, ips);
      return ips;
    }
  } catch {
    // fall through to the container resolver
  }
  const fromDocker = dockerResolve4(host);
  if (fromDocker.length) {
    resolveCache.set(host, fromDocker);
    return fromDocker;
  }
  throw new DomainError("dns_failed", `dns_failed:${host}`, "denied");
}

/** Async workspace size, fs.promises throughout. */
export async function workspaceBytesAsync(root: string): Promise<number> {
  if (!existsSync(root)) return 0;
  let n = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const st = await stat(p);
      if (st.isDirectory()) await walk(p);
      else n += st.size;
    }
  };
  await walk(root);
  return n;
}

export function assertNoSecretEnv(env: Record<string, string>): void {
  const banned = /^(AWS_|OPENAI|ANTHROPIC|API_KEY|TOKEN|SECRET|PASSWORD|RIONEXT_PROVIDER)/i;
  for (const k of Object.keys(env)) {
    if (banned.test(k) || /key|secret|token|password/i.test(k)) {
      if (k !== "HOME" && k !== "LANG" && k !== "RIONEXT_CAMPAIGN" && k !== "RIONEXT_ALLOW_IPS" && k !== "DISABLE_UPDATE_CHECK") {
        throw new DomainError("kali_env", `refusing to pass ${k} into the container`, "denied");
      }
    }
  }
}

export function assertMountsSafe(
  mounts: { host: string; container: string }[],
  forbidden: string[],
): void {
  for (const m of mounts) {
    if (m.container !== "/workspace") {
      throw new DomainError("kali_mount", `unexpected container mount ${m.container}`, "denied");
    }
    if (forbiddenMount(m.host, forbidden)) {
      throw new DomainError("kali_mount", "refusing to mount controller db/secrets/artifacts", "denied");
    }
  }
}

export function workspaceBytes(root: string): number {
  if (!existsSync(root)) return 0;
  let n = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else n += st.size;
    }
  };
  walk(root);
  return n;
}

export class HostRateLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max = DEFAULT_KALI_LIMITS.ratePerHost,
    private readonly windowMs = DEFAULT_KALI_LIMITS.rateWindowMs,
  ) {}

  admit(host: string, now = Date.now()): boolean {
    const cut = now - this.windowMs;
    const prev = (this.hits.get(host) ?? []).filter((t) => t > cut);
    if (prev.length >= this.max) return false;
    prev.push(now);
    this.hits.set(host, prev);
    return true;
  }
}

export class KaliRuntime {
  private readonly rate = new HostRateLimit();
  private readonly last = new Map<string, DockerExecResult & { truncated: boolean; container: string }>();

  private readonly docker: DockerCli;
  private readonly coordinator: ContainerInitCoordinator;

  constructor(docker?: DockerCli, coordinator?: ContainerInitCoordinator) {
    this.docker = docker ?? new ProcessDockerCli();
    this.coordinator = coordinator ?? processInitCoordinator;
  }

  takeLast(campaignId: string): (DockerExecResult & { truncated: boolean; container: string }) | undefined {
    const r = this.last.get(campaignId);
    this.last.delete(campaignId);
    return r;
  }

  spec(opts: KaliStartOpts): ContainerSpec {
    return buildContainerSpec(opts);
  }

  requireMasterImage(image = KALI_IMAGE): string {
    const r = this.docker.run(["image", "inspect", "-f", "{{.Id}}", image], { timeoutMs: 8_000 });
    if (r.code !== 0 || !r.stdout.trim()) {
      throw new DomainError(
        "kali_master_missing",
        `master image ${image} is not present. Build once with: rionext kali build`,
        "protocol_error",
      );
    }
    return r.stdout.trim();
  }

  protectMaster(image = KALI_IMAGE): { image_id: string; master_id: string; keeper: string; created: boolean } {
    const image_id = this.requireMasterImage(image);
    const master_id = this.requireMasterImage(KALI_MASTER_TAG);
    const inspect = this.docker.run(["inspect", "-f", "{{.Id}}", KALI_KEEPER_NAME], { timeoutMs: 5_000 });
    if (inspect.code === 0 && inspect.stdout.trim()) {
      return { image_id, master_id, keeper: KALI_KEEPER_NAME, created: false };
    }
    const created = this.docker.run(
      ["create", "--name", KALI_KEEPER_NAME, "--label", "rionext.role=master-keep", image, "true"],
      { timeoutMs: 15_000 },
    );
    if (created.code !== 0 && !/already in use|Conflict/i.test(created.stderr)) {
      throw new DomainError("kali_keeper", created.stderr || "failed to pin master image", "protocol_error");
    }
    return { image_id, master_id, keeper: KALI_KEEPER_NAME, created: created.code === 0 };
  }

  ensure(opts: KaliStartOpts): ContainerSpec {
    this.requireMasterImage(opts.image ?? KALI_IMAGE);
    const spec = this.spec(opts);
    const key = spec.name;
    const fp = spec.fingerprint;
    const verified = this.coordinator.verifiedFingerprint(key);
    if (verified != null && verified !== fp) throw initConflict(key);
    // A worker-path init may be running in this process: wait it out, then reuse.
    for (let i = 0; i < 600 && this.coordinator.inFlight(key); i += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (this.inspectRunningSync(key)) {
      if (verified === fp) return spec;
      this.verifyOwnedMatchSync(key, spec);
      this.coordinator.markVerified(key, fp);
      return spec;
    }
    const lock = acquireInitLock(opts.dataDir, key, fp);
    if (!lock) {
      const reused = this.awaitPeerInitSync(opts.dataDir, key, spec);
      if (reused) {
        this.coordinator.markVerified(key, fp);
        return spec;
      }
      throw new DomainError("kali_init_locked", `container ${key} is being initialized by another process`, "protocol_error");
    }
    try {
      return this.createExclusiveSync(spec);
    } finally {
      lock.release();
    }
  }

  private createExclusiveSync(spec: ContainerSpec): ContainerSpec {
    const key = spec.name;
    const fp = spec.fingerprint;
    // Re-inspect under the lock: a peer may have finished while we waited.
    if (this.inspectRunningSync(key)) {
      this.verifyOwnedMatchSync(key, spec);
      this.coordinator.markVerified(key, fp);
      return spec;
    }
    const state = this.inspectStateAndLabelsSync(key);
    if (state.exists && !state.running) {
      // Exited container: only ever remove one this project owns (K10).
      if (!ownedByThisProject(state.labels)) throw foreignConflict(key);
      this.docker.run(["rm", "-f", key], { timeoutMs: 10_000 });
      this.coordinator.invalidate(key);
    }
    const created = this.docker.run(spec.argv, { timeoutMs: 30_000 });
    if (created.code !== 0) {
      if (/already in use|Conflict/i.test(created.stderr)) {
        // Lost a create race: reconcile by inspection, never rm -f.
        this.verifyOwnedMatchSync(key, spec);
        if (this.inspectRunningSync(key)) {
          this.coordinator.markVerified(key, fp);
          return spec;
        }
      }
      throw new DomainError("kali_start", created.stderr || "docker run failed", "protocol_error");
    }
    for (let i = 0; i < 25; i++) {
      if (this.inspectRunningSync(key)) {
        this.verifyOwnedMatchSync(key, spec);
        this.coordinator.markVerified(key, fp);
        return spec;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    const died = this.docker.run(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", key], { timeoutMs: 5_000 });
    throw new DomainError(
      "kali_start",
      `campaign container ${key} exited before exec (${died.stdout.trim() || "missing"})`,
      "protocol_error",
    );
  }

  /** Async admission for worker paths: DNS resolves via dns.promises, disk scan via fs.promises. */
  private async admitExecAsync(opts: KaliStartOpts, bin: string, args: string[], extra?: { url?: string; redirects?: string[] }): Promise<void> {
    assertKaliArgv(bin, args, opts.capabilities);
    const allow = parseAllowList(opts.allowAssets);
    const resolveAsync = opts.resolve
      ? (h: string) => Promise.resolve(opts.resolve!(h))
      : (h: string) => defaultResolveAsync(h);
    const pre = new Map<string, string[]>();
    const presolve = async (raw: string): Promise<void> => {
      try {
        const d = parseDestination(raw);
        if (!isLoopbackHost(d.host) && !pre.has(d.host)) pre.set(d.host, await resolveAsync(d.host));
      } catch {
        // malformed dest is denied later by the sync checks
      }
    };
    if (extra?.url) {
      await presolve(extra.url);
      for (const loc of extra.redirects ?? []) await presolve(loc);
    } else if (TCP_CLIENT_BINS.has(bin)) {
      const dest = tcpDestFromArgs(bin, args);
      if (dest) await presolve(dest);
    } else if (looksLikeHostArg(args)) {
      const dest = args.find((a) => a.includes(".") && !a.startsWith("-"));
      if (dest) await presolve(dest);
    }
    const syncResolve = (host: string): string[] => {
      const hit = pre.get(host);
      if (hit) return hit;
      throw new DomainError("dns_failed", `dns_failed:${host}`, "denied");
    };
    if (extra?.url) this.admitNet(extra.url, allow, syncResolve, extra.redirects ?? []);
    else if (TCP_CLIENT_BINS.has(bin)) {
      const dest = tcpDestFromArgs(bin, args);
      if (dest) this.admitNet(dest, allow, syncResolve, []);
    } else if (looksLikeHostArg(args)) {
      const dest = args.find((a) => a.includes(".") && !a.startsWith("-"));
      if (dest) this.admitNet(dest, allow, syncResolve, []);
    }
    const used = await workspaceBytesAsync(opts.workspaceHost);
    if (used > DEFAULT_KALI_LIMITS.maxWorkspaceBytes) {
      throw new DomainError("disk_cap", "workspace disk occupancy exceeds limit", "denied");
    }
  }

  /** Admission shared by exec and execAsync: argv allowlist, egress, disk cap. */
  private admitExec(opts: KaliStartOpts, bin: string, args: string[], extra?: { url?: string; redirects?: string[] }): void {
    assertKaliArgv(bin, args, opts.capabilities);
    const allow = parseAllowList(opts.allowAssets);
    const resolve = opts.resolve ?? ((h: string) => defaultResolve(h));
    if (extra?.url) this.admitNet(extra.url, allow, resolve, extra.redirects ?? []);
    else if (TCP_CLIENT_BINS.has(bin)) {
      const dest = tcpDestFromArgs(bin, args);
      if (dest) this.admitNet(dest, allow, resolve, []);
    } else if (looksLikeHostArg(args)) {
      const dest = args.find((a) => a.includes(".") && !a.startsWith("-"));
      if (dest) this.admitNet(dest, allow, resolve, []);
    }
    const used = workspaceBytes(opts.workspaceHost);
    if (used > DEFAULT_KALI_LIMITS.maxWorkspaceBytes) {
      throw new DomainError("disk_cap", "workspace disk occupancy exceeds limit", "denied");
    }
  }

  /**
   * Async exec for worker paths: admission is identical to exec, but the actual
   * docker call awaits a spawned process, so a long foreground tool never blocks
   * the event loop (other workers and heartbeats keep running).
   */
  async execAsync(
    opts: KaliStartOpts,
    bin: string,
    args: string[],
    extra?: { url?: string; redirects?: string[]; timeout_ms?: number; executionId?: string; background?: boolean; signal?: AbortSignal },
  ): Promise<DockerExecResult & { truncated: boolean; container: string; pending?: boolean }> {
    await this.admitExecAsync(opts, bin, args, extra);
    const spec = await this.ensureAsync(opts, extra?.signal);
    const background = extra?.background ?? shouldBackgroundKali(bin, extra?.timeout_ms);
    if (background) {
      const executionId = extra?.executionId ?? `kali_${opts.campaignId}_${Date.now()}`;
      return this.execBackgroundAsync(opts, spec.name, bin, args, executionId, extra?.timeout_ms, extra?.signal);
    }
    const capSec = Math.ceil((extra?.timeout_ms ?? DEFAULT_KALI_LIMITS.maxRuntimeMs) / 1000);
    runDirHost(opts);
    // Persistent execution record + in-container pid marker (H04 §6.5): the
    // foreground path is recoverable too, and cancellation can find and stop
    // exactly this invocation's process group.
    const executionId = extra?.executionId ?? `kali_${opts.campaignId}_${Date.now()}`;
    const files = opFiles(opts.workspaceHost, executionId, containerRootOf(opts));
    const record: ExecRecord = {
      execution_id: executionId,
      container: spec.name,
      run_id: opts.runId ?? null,
      argv_preview: [bin, ...args].slice(0, 12),
      phase: "started",
      started_at: new Date().toISOString(),
    };
    writeExecRecord(files.json, record);
    const quoted = [bin, ...args].map(shQuote).join(" ");
    const argv = ["exec", "-w", runRootOf(opts), spec.name, "sh", "-c", `echo $$ > ${shQuote(files.containerPid)}; exec timeout ${capSec} ${quoted}`];
    const result = await this.docker.runAsync(argv, {
      timeoutMs: (extra?.timeout_ms ?? DEFAULT_KALI_LIMITS.maxRuntimeMs) + 5_000,
      maxBytes: DEFAULT_KALI_LIMITS.maxOutputBytes,
      signal: extra?.signal,
    });
    if (extra?.signal?.aborted) {
      // Killing the host docker client does not stop the in-container process.
      // Terminate the process group by its persisted marker and confirm.
      await this.cancelExecution(opts, executionId).catch(() => "unknown" as const);
    }
    const truncated =
      result.stdout.length >= DEFAULT_KALI_LIMITS.maxOutputBytes ||
      result.stderr.length >= DEFAULT_KALI_LIMITS.maxOutputBytes;
    // The in-container `timeout` wrapper already reaped this invocation's
    // process. Never kill the container here: sibling runs share it (C4).
    writeExecRecord(files.json, { ...record, phase: "ended", code: result.code, timed_out: result.timedOut, ended_at: new Date().toISOString() });
    const out = { ...result, truncated, container: spec.name };
    this.last.set(opts.runId ?? opts.campaignId, out);
    return out;
  }

  private async ensureAsync(opts: KaliStartOpts, signal?: AbortSignal): Promise<ContainerSpec> {
    this.requireMasterImage(opts.image ?? KALI_IMAGE);
    const spec = this.spec(opts);
    const key = spec.name;
    const fp = spec.fingerprint;
    const verified = this.coordinator.verifiedFingerprint(key);
    if (verified != null && verified !== fp) throw initConflict(key);
    if (await this.inspectRunningAsync(key, signal)) {
      // Fast path: verified once per process, one inspect per exec afterwards.
      if (verified === fp) return spec;
      await this.verifyOwnedMatchAsync(key, spec);
      this.coordinator.markVerified(key, fp);
      return spec;
    }
    // Cold path: one creator per container name per process; the rest join.
    // The creator runs without the caller's signal so one worker cancelling
    // cannot fail its peers; each waiter cancels only its own wait (K05).
    const joined = this.coordinator.join(key, fp, () => this.createExclusiveAsync(opts, spec));
    if (!signal) return joined;
    if (signal.aborted) throw new DomainError("cancelled", "init wait cancelled", "cancelled");
    return Promise.race([
      joined,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DomainError("cancelled", "init wait cancelled", "cancelled")), {
          once: true,
        });
      }),
    ]);
  }

  private async createExclusiveAsync(opts: KaliStartOpts, spec: ContainerSpec): Promise<ContainerSpec> {
    const key = spec.name;
    const fp = spec.fingerprint;
    const lock = acquireInitLock(opts.dataDir, key, fp);
    if (!lock) {
      // Another process is initializing: wait for the container to appear.
      const reused = await this.awaitPeerInitAsync(opts.dataDir, key, spec);
      if (reused) {
        this.coordinator.markVerified(key, fp);
        return spec;
      }
      throw new DomainError("kali_init_locked", `container ${key} is being initialized by another process`, "protocol_error");
    }
    try {
      if (await this.inspectRunningAsync(key)) {
        await this.verifyOwnedMatchAsync(key, spec);
        this.coordinator.markVerified(key, fp);
        return spec;
      }
      const state = await this.inspectStateAndLabelsAsync(key);
      if (state.exists && !state.running) {
        if (!ownedByThisProject(state.labels)) throw foreignConflict(key);
        await this.docker.runAsync(["rm", "-f", key], { timeoutMs: 10_000 });
        this.coordinator.invalidate(key);
      }
      const created = await this.docker.runAsync(spec.argv, { timeoutMs: 30_000 });
      if (created.code !== 0) {
        if (/already in use|Conflict/i.test(created.stderr)) {
          // Lost a create race: reconcile by inspection, never rm -f (K09).
          await this.verifyOwnedMatchAsync(key, spec);
          if (await this.inspectRunningAsync(key)) {
            this.coordinator.markVerified(key, fp);
            return spec;
          }
        }
        throw new DomainError("kali_start", created.stderr || "docker run failed", "protocol_error");
      }
      for (let i = 0; i < 25; i++) {
        if (await this.inspectRunningAsync(key)) {
          await this.verifyOwnedMatchAsync(key, spec);
          this.coordinator.markVerified(key, fp);
          return spec;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const died = await this.docker.runAsync(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", key], { timeoutMs: 5_000 });
      throw new DomainError(
        "kali_start",
        `campaign container ${key} exited before exec (${died.stdout.trim() || "missing"})`,
        "protocol_error",
      );
    } finally {
      lock.release();
    }
  }

  private async inspectRunningAsync(name: string, signal?: AbortSignal): Promise<boolean> {
    const r = await this.docker.runAsync(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 5_000, signal });
    return r.code === 0 && r.stdout.trim() === "true";
  }

  private inspectRunningSync(name: string): boolean {
    const r = this.docker.run(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 5_000 });
    return r.code === 0 && r.stdout.trim() === "true";
  }

  private async inspectStateAndLabelsAsync(name: string): Promise<{ exists: boolean; running: boolean; labels: Record<string, string> }> {
    const state = await this.docker.runAsync(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 5_000 });
    if (state.code !== 0) return { exists: false, running: false, labels: {} };
    return { exists: true, running: state.stdout.trim() === "true", labels: await this.inspectLabelsAsync(name) };
  }

  private inspectStateAndLabelsSync(name: string): { exists: boolean; running: boolean; labels: Record<string, string> } {
    const state = this.docker.run(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 5_000 });
    if (state.code !== 0) return { exists: false, running: false, labels: {} };
    return { exists: true, running: state.stdout.trim() === "true", labels: this.inspectLabelsSync(name) };
  }

  private async inspectLabelsAsync(name: string): Promise<Record<string, string>> {
    const r = await this.docker.runAsync(["inspect", "-f", "{{json .Config.Labels}}", name], { timeoutMs: 5_000 });
    return parseLabels(r.stdout);
  }

  private inspectLabelsSync(name: string): Record<string, string> {
    const r = this.docker.run(["inspect", "-f", "{{json .Config.Labels}}", name], { timeoutMs: 5_000 });
    return parseLabels(r.stdout);
  }

  /**
   * An existing container under our name must be one this project created with
   * the same configuration. Foreign or mismatched containers are an explicit
   * conflict — they are never removed or silently reused (K10).
   */
  private async verifyOwnedMatchAsync(name: string, spec: ContainerSpec): Promise<void> {
    assertOwnedMatch(name, spec, await this.inspectLabelsAsync(name));
  }

  private verifyOwnedMatchSync(name: string, spec: ContainerSpec): void {
    assertOwnedMatch(name, spec, this.inspectLabelsSync(name));
  }

  /** The init lock is held by a peer: poll for the container it is creating. */
  private async awaitPeerInitAsync(dataDir: string, name: string, spec: ContainerSpec): Promise<boolean> {
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await this.inspectRunningAsync(name)) {
        await this.verifyOwnedMatchAsync(name, spec);
        return true;
      }
      if (!initLockHeldByOthers(dataDir, name)) return false;
    }
    return false;
  }

  private awaitPeerInitSync(dataDir: string, name: string, spec: ContainerSpec): boolean {
    for (let i = 0; i < 600; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      if (this.inspectRunningSync(name)) {
        this.verifyOwnedMatchSync(name, spec);
        return true;
      }
      if (!initLockHeldByOthers(dataDir, name)) return false;
    }
    return false;
  }

  private async execBackgroundAsync(
    opts: KaliStartOpts,
    container: string,
    bin: string,
    args: string[],
    executionId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<DockerExecResult & { truncated: boolean; container: string; pending: boolean }> {
    const files = opFiles(opts.workspaceHost, executionId, containerRootOf(opts));
    mkdirSync(dirname(files.sh), { recursive: true });
    const capSec = Math.ceil((timeoutMs ?? DEFAULT_KALI_LIMITS.maxBackgroundRuntimeMs) / 1000);
    const quoted = [bin, ...args].map(shQuote).join(" ");
    const script = [
      "#!/bin/sh",
      "set +e",
      `echo $$ > ${shQuote(files.containerPid)}`,
      `timeout ${capSec} ${quoted} > ${shQuote(files.containerOut)} 2> ${shQuote(files.containerErr)}`,
      `echo $? > ${shQuote(files.containerExit)}`,
      "",
    ].join("\n");
    writeFileSync(files.sh, script, { encoding: "utf8" });
    const record: ExecRecord = {
      execution_id: executionId,
      container,
      run_id: opts.runId ?? null,
      argv_preview: [bin, ...args].slice(0, 12),
      phase: "started",
      started_at: new Date().toISOString(),
    };
    writeExecRecord(files.json, record);
    runDirHost(opts);
    const started = await this.docker.runAsync(["exec", "-d", "-w", runRootOf(opts), container, "sh", files.containerSh], {
      timeoutMs: 15_000,
      signal,
    });
    if (started.code !== 0) {
      throw new DomainError("kali_start", started.stderr || "background exec failed", "protocol_error");
    }
    if (signal?.aborted) {
      await this.cancelExecution(opts, executionId).catch(() => "unknown" as const);
    }
    const out = {
      stdout: JSON.stringify({ pending: true, execution_id: executionId, path: files.containerOut }),
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      container,
      pending: true as const,
    };
    this.last.set(opts.runId ?? opts.campaignId, out);
    return out;
  }

  async playwrightAsync(
    opts: KaliStartOpts,
    cmd: { op: string; url?: string; ref?: string; selector?: string; text?: string; key?: string; timeout_ms?: number; redirects?: string[] },
    signal?: AbortSignal,
  ): Promise<DockerExecResult & { truncated: boolean; container: string }> {
    if (!PLAYWRIGHT_OPS.has(cmd.op)) {
      throw new DomainError("playwright_op", `unknown playwright op ${cmd.op}`, "invalid_input");
    }
    if (cmd.op === "goto" && cmd.url) {
      const allow = parseAllowList(opts.allowAssets);
      const resolve = opts.resolve ?? ((h: string) => defaultResolve(h));
      this.admitNet(cmd.url, allow, resolve, cmd.redirects ?? []);
    }
    const spec = await this.ensureAsync(opts, signal);
    const result = await this.docker.runAsync(["exec", "-i", spec.name, "node", "/opt/rionext/pw-ctl.mjs"], {
      input: JSON.stringify(opts.runId ? { ...cmd, session_id: opts.runId, run_dir: runRootOf(opts) } : cmd),
      timeoutMs: Math.max(DEFAULT_KALI_LIMITS.maxRuntimeMs, cmd.timeout_ms ?? 0) + 5_000,
      maxBytes: DEFAULT_KALI_LIMITS.maxOutputBytes,
      signal,
    });
    const truncated =
      result.stdout.length >= DEFAULT_KALI_LIMITS.maxOutputBytes ||
      result.stderr.length >= DEFAULT_KALI_LIMITS.maxOutputBytes;
    const out = { ...result, truncated, container: spec.name };
    this.last.set(opts.runId ?? opts.campaignId, out);
    return out;
  }

  async writeWorkspaceAsync(
    opts: KaliStartOpts,
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<DockerExecResult & { truncated: boolean; container: string }> {
    const rel = workspaceRelPath(path);
    if (content.length > DEFAULT_KALI_LIMITS.maxOutputBytes) {
      throw new DomainError("disk_cap", "workspace write exceeds output cap", "denied");
    }
    mkdirSync(opts.workspaceHost, { recursive: true });
    const used = workspaceBytes(opts.workspaceHost);
    if (used + content.length > DEFAULT_KALI_LIMITS.maxWorkspaceBytes) {
      throw new DomainError("disk_cap", "workspace disk occupancy exceeds limit", "denied");
    }
    const baseDir = runDirHost(opts) ?? opts.workspaceHost;
    const dest = join(baseDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
    const spec = await this.ensureAsync(opts, signal);
    const body = JSON.stringify({ ok: true, path: `/workspace/${rel.replace(/\\/g, "/")}`, bytes: Buffer.byteLength(content, "utf8") });
    const out = {
      stdout: body,
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      container: spec.name,
    };
    this.last.set(opts.runId ?? opts.campaignId, out);
    return out;
  }

  exec(
    opts: KaliStartOpts,
    bin: string,
    args: string[],
    extra?: { url?: string; redirects?: string[]; timeout_ms?: number; executionId?: string; background?: boolean },
  ): DockerExecResult & { truncated: boolean; container: string; pending?: boolean } {
    this.admitExec(opts, bin, args, extra);
    const spec = this.ensure(opts);
    const background = extra?.background ?? shouldBackgroundKali(bin, extra?.timeout_ms);
    if (background) {
      const executionId = extra?.executionId ?? `kali_${opts.campaignId}_${Date.now()}`;
      return this.execBackground(opts, spec.name, bin, args, executionId, extra?.timeout_ms);
    }
    const capSec = Math.ceil((extra?.timeout_ms ?? DEFAULT_KALI_LIMITS.maxRuntimeMs) / 1000);
    runDirHost(opts);
    const executionId = extra?.executionId ?? `kali_${opts.campaignId}_${Date.now()}`;
    const files = opFiles(opts.workspaceHost, executionId, containerRootOf(opts));
    const record: ExecRecord = {
      execution_id: executionId,
      container: spec.name,
      run_id: opts.runId ?? null,
      argv_preview: [bin, ...args].slice(0, 12),
      phase: "started",
      started_at: new Date().toISOString(),
    };
    writeExecRecord(files.json, record);
    const quoted = [bin, ...args].map(shQuote).join(" ");
    const argv = ["exec", "-w", runRootOf(opts), spec.name, "sh", "-c", `echo $$ > ${shQuote(files.containerPid)}; exec timeout ${capSec} ${quoted}`];
    const result = this.docker.run(argv, {
      timeoutMs: (extra?.timeout_ms ?? DEFAULT_KALI_LIMITS.maxRuntimeMs) + 5_000,
      maxBytes: DEFAULT_KALI_LIMITS.maxOutputBytes,
    });
    const truncated =
      result.stdout.length >= DEFAULT_KALI_LIMITS.maxOutputBytes ||
      result.stderr.length >= DEFAULT_KALI_LIMITS.maxOutputBytes;
    // The in-container `timeout` wrapper already reaped this invocation's
    // process. Never kill the container here: sibling runs share it (C4).
    writeExecRecord(files.json, { ...record, phase: "ended", code: result.code, timed_out: result.timedOut, ended_at: new Date().toISOString() });
    const out = { ...result, truncated, container: spec.name };
    this.last.set(opts.runId ?? opts.campaignId, out);
    return out;
  }

  collectBackground(
    opts: KaliStartOpts,
    executionId: string,
  ): DockerExecResult & { truncated: boolean; container: string; pending?: boolean } {
    const files = opFiles(opts.workspaceHost, executionId, containerRootOf(opts));
    const stdout = existsSync(files.out) ? readFileSync(files.out, "utf8") : "";
    const stderr = existsSync(files.err) ? readFileSync(files.err, "utf8") : "";
    const codeRaw = existsSync(files.exit) ? Number(readFileSync(files.exit, "utf8").trim()) : 1;
    const code = Number.isFinite(codeRaw) ? codeRaw : 1;
    const truncated =
      stdout.length >= DEFAULT_KALI_LIMITS.maxOutputBytes || stderr.length >= DEFAULT_KALI_LIMITS.maxOutputBytes;
    const out = {
      stdout: stdout.slice(0, DEFAULT_KALI_LIMITS.maxOutputBytes),
      stderr: stderr.slice(0, DEFAULT_KALI_LIMITS.maxOutputBytes),
      code,
      timedOut: code === 124,
      truncated,
      container: opts.shared?.name ?? containerName(opts.campaignId),
      pending: false,
    };
    const record = readExecRecord(files.json);
    if (record) {
      writeExecRecord(files.json, { ...record, phase: "ended", code, timed_out: code === 124, ended_at: new Date().toISOString() });
    }
    this.last.set(opts.runId ?? opts.campaignId, out);
    return out;
  }

  backgroundStatus(opts: KaliStartOpts, executionId: string): "unknown" | "completed" | "failed" {
    const files = opFiles(opts.workspaceHost, executionId, containerRootOf(opts));
    if (existsSync(files.exit)) {
      const code = Number(readFileSync(files.exit, "utf8").trim());
      return code === 0 ? "completed" : "failed";
    }
    const box = this.inspectName(opts.shared?.name ?? containerName(opts.campaignId));
    if (box === "missing" || box === "exited") return "failed";
    return "unknown";
  }

  /** Polling-friendly variant: fs.promises and runAsync, no spawnSync. The
   *  persistent exec record covers foreground commands, whose exit never
   *  writes an .exit file (E15). */
  async backgroundStatusAsync(opts: KaliStartOpts, executionId: string): Promise<"unknown" | "completed" | "failed"> {
    const files = opFiles(opts.workspaceHost, executionId, containerRootOf(opts));
    if (existsSync(files.exit)) {
      const { readFile } = await import("node:fs/promises");
      const code = Number((await readFile(files.exit, "utf8")).trim());
      return code === 0 ? "completed" : "failed";
    }
    const record = readExecRecord(files.json);
    if (record?.phase === "ended") return record.code === 0 ? "completed" : "failed";
    const box = await this.inspectNameAsync(opts.shared?.name ?? containerName(opts.campaignId));
    if (box === "missing" || box === "exited") return "failed";
    return "unknown";
  }

  /**
   * Cancel exactly one invocation's in-container process group (H04 §6.10).
   * Identity is checked against the persistent record and the pid marker's
   * cmdline before anything is signaled, so a reused pid or container name
   * never kills the wrong process (E16). Killing the host docker CLI is never
   * treated as proof the container side stopped (E17).
   */
  async cancelExecution(opts: KaliStartOpts, executionId: string): Promise<"confirmed" | "already_done" | "unknown"> {
    const files = opFiles(opts.workspaceHost, executionId, containerRootOf(opts));
    const record = readExecRecord(files.json);
    if (record?.phase === "ended") return "already_done";
    const container = opts.shared?.name ?? containerName(opts.campaignId);
    if (record && record.container !== container) return "unknown"; // identity mismatch: refuse to touch
    if (record) {
      writeExecRecord(files.json, { ...record, cancel_requested: true });
    }
    const box = await this.inspectNameAsync(container);
    if (box !== "running") {
      // A stopped container has no live processes: positive confirmation.
      if (record) writeExecRecord(files.json, { ...record, cancel_requested: true, cancel_confirmed: true });
      return "confirmed";
    }
    const probeCmd = `if [ -f ${shQuote(files.containerPid)} ]; then P=$(cat ${shQuote(files.containerPid)}); if kill -0 "$P" 2>/dev/null && grep -q ${shQuote(executionId)} /proc/$P/cmdline 2>/dev/null; then echo alive; else echo dead; fi; else echo dead; fi`;
    const probe = await this.docker.runAsync(["exec", container, "sh", "-c", probeCmd], { timeoutMs: 8_000 });
    if (probe.stdout.trim() !== "alive") {
      if (record) writeExecRecord(files.json, { ...record, cancel_requested: true, cancel_confirmed: true });
      return "confirmed";
    }
    await this.docker.runAsync(
      ["exec", container, "sh", "-c", `P=$(cat ${shQuote(files.containerPid)}); kill -TERM -"$P" 2>/dev/null || kill -TERM "$P"`],
      { timeoutMs: 8_000 },
    );
    const recheck = await this.docker.runAsync(["exec", container, "sh", "-c", probeCmd], { timeoutMs: 8_000 });
    const dead = recheck.stdout.trim() !== "alive";
    if (dead && record) writeExecRecord(files.json, { ...record, cancel_requested: true, cancel_confirmed: true });
    return dead ? "confirmed" : "unknown";
  }

  inspectCampaignAsync(campaignId: string): Promise<"running" | "exited" | "missing"> {
    return this.inspectNameAsync(containerName(campaignId));
  }

  private async inspectNameAsync(name: string): Promise<"running" | "exited" | "missing"> {
    const r = await this.docker.runAsync(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 5_000 });
    if (r.code !== 0) return "missing";
    return r.stdout.trim() === "true" ? "running" : "exited";
  }

  private execBackground(
    opts: KaliStartOpts,
    container: string,
    bin: string,
    args: string[],
    executionId: string,
    timeoutMs?: number,
  ): DockerExecResult & { truncated: boolean; container: string; pending: boolean } {
    const files = opFiles(opts.workspaceHost, executionId, containerRootOf(opts));
    mkdirSync(dirname(files.sh), { recursive: true });
    const capSec = Math.ceil((timeoutMs ?? DEFAULT_KALI_LIMITS.maxBackgroundRuntimeMs) / 1000);
    const quoted = [bin, ...args].map(shQuote).join(" ");
    const script = [
      "#!/bin/sh",
      "set +e",
      `echo $$ > ${shQuote(files.containerPid)}`,
      `timeout ${capSec} ${quoted} > ${shQuote(files.containerOut)} 2> ${shQuote(files.containerErr)}`,
      `echo $? > ${shQuote(files.containerExit)}`,
      "",
    ].join("\n");
    writeFileSync(files.sh, script, { encoding: "utf8" });
    writeExecRecord(files.json, {
      execution_id: executionId,
      container,
      run_id: opts.runId ?? null,
      argv_preview: [bin, ...args].slice(0, 12),
      phase: "started",
      started_at: new Date().toISOString(),
    });
    runDirHost(opts);
    const started = this.docker.run(["exec", "-d", "-w", runRootOf(opts), container, "sh", files.containerSh], {
      timeoutMs: 15_000,
    });
    if (started.code !== 0) {
      throw new DomainError("kali_start", started.stderr || "background exec failed", "protocol_error");
    }
    const out = {
      stdout: JSON.stringify({ pending: true, execution_id: executionId, path: files.containerOut }),
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      container,
      pending: true as const,
    };
    this.last.set(opts.runId ?? opts.campaignId, out);
    return out;
  }

  writeWorkspace(
    opts: KaliStartOpts,
    path: string,
    content: string,
  ): DockerExecResult & { truncated: boolean; container: string } {
    const rel = workspaceRelPath(path);
    if (content.length > DEFAULT_KALI_LIMITS.maxOutputBytes) {
      throw new DomainError("disk_cap", "workspace write exceeds output cap", "denied");
    }
    mkdirSync(opts.workspaceHost, { recursive: true });
    const used = workspaceBytes(opts.workspaceHost);
    if (used + content.length > DEFAULT_KALI_LIMITS.maxWorkspaceBytes) {
      throw new DomainError("disk_cap", "workspace disk occupancy exceeds limit", "denied");
    }
    const baseDir = runDirHost(opts) ?? opts.workspaceHost;
    const dest = join(baseDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
    const spec = this.ensure(opts);
    const body = JSON.stringify({ ok: true, path: `/workspace/${rel.replace(/\\/g, "/")}`, bytes: Buffer.byteLength(content, "utf8") });
    const out = {
      stdout: body,
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      container: spec.name,
    };
    this.last.set(opts.runId ?? opts.campaignId, out);
    return out;
  }

  playwright(
    opts: KaliStartOpts,
    cmd: { op: string; url?: string; ref?: string; selector?: string; text?: string; key?: string; timeout_ms?: number; redirects?: string[] },
  ): DockerExecResult & { truncated: boolean; container: string } {
    if (!PLAYWRIGHT_OPS.has(cmd.op)) {
      throw new DomainError("playwright_op", `unknown playwright op ${cmd.op}`, "invalid_input");
    }
    if (cmd.op === "goto" && cmd.url) {
      const allow = parseAllowList(opts.allowAssets);
      const resolve = opts.resolve ?? ((h: string) => defaultResolve(h));
      this.admitNet(cmd.url, allow, resolve, cmd.redirects ?? []);
    }
    const spec = this.ensure(opts);
    const result = this.docker.run(["exec", "-i", spec.name, "node", "/opt/rionext/pw-ctl.mjs"], {
      input: JSON.stringify(opts.runId ? { ...cmd, session_id: opts.runId, run_dir: runRootOf(opts) } : cmd),
      timeoutMs: Math.max(DEFAULT_KALI_LIMITS.maxRuntimeMs, cmd.timeout_ms ?? 0) + 5_000,
      maxBytes: DEFAULT_KALI_LIMITS.maxOutputBytes,
    });
    const truncated =
      result.stdout.length >= DEFAULT_KALI_LIMITS.maxOutputBytes ||
      result.stderr.length >= DEFAULT_KALI_LIMITS.maxOutputBytes;
    const out = { ...result, truncated, container: spec.name };
    this.last.set(opts.runId ?? opts.campaignId, out);
    return out;
  }

  /** Fire-and-forget browser session cleanup for a finished run. Never throws. */
  closePlaywrightSession(opts: KaliStartOpts): void {
    if (!opts.runId) return;
    try {
      void this.docker
        .runAsync(["exec", "-i", opts.shared?.name ?? containerName(opts.campaignId), "node", "/opt/rionext/pw-ctl.mjs"], {
          input: JSON.stringify({ op: "close", session_id: opts.runId }),
          timeoutMs: 8_000,
        })
        .catch(() => {
          // daemon down or container gone: the session dies with them anyway
        });
    } catch {
      // best effort only
    }
  }

  kill(campaignId: string): void {
    this.killName(containerName(campaignId));
  }

  /** Kill + rm a container by literal name (shared contest container included). */
  killName(name: string): void {
    if (name === KALI_KEEPER_NAME) {
      throw new DomainError("kali_keeper", "refusing to kill the master keeper", "denied");
    }
    this.docker.run(["kill", name], { timeoutMs: 10_000 });
    this.docker.run(["rm", "-f", name], { timeoutMs: 10_000 });
    this.coordinator.invalidate(name);
  }

  inspectName(name: string): "running" | "exited" | "missing" {
    const r = this.docker.run(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 5_000 });
    if (r.code !== 0 || !r.stdout.trim()) return "missing";
    return r.stdout.trim() === "true" ? "running" : "exited";
  }

  inspectCampaign(campaignId: string): "running" | "exited" | "missing" {
    return this.inspectName(containerName(campaignId));
  }

  /** Raw `docker exec <name> sh -c <script>` for supervisor-side container
   *  maintenance (egress replay). Not model-facing; no argv allowlist here. */
  execShell(name: string, script: string, timeoutMs = 15_000): DockerExecResult {
    return this.docker.run(["exec", name, "sh", "-c", script], { timeoutMs, maxBytes: 65_536 });
  }

  query(campaignId: string): "unknown" | "completed" | "failed" {
    const box = this.inspectCampaign(campaignId);
    if (box === "missing" || box === "exited") return "failed";
    return "unknown";
  }

  private admitNet(raw: string, allow: AllowEntry[], resolve: ResolveFn, redirects: string[]): void {
    const dest = parseDestination(raw);
    const first = checkEgress(dest, allow, resolve);
    if (!first.ok) throw new DomainError("egress_denied", first.reason, "denied");
    if (!this.rate.admit(dest.host)) throw new DomainError("rate_limited", `rate limit for ${dest.host}`, "denied");
    for (const loc of redirects) {
      const hop = checkRedirect(loc, allow, resolve);
      if (!hop.ok) throw new DomainError("redirect_denied", hop.reason, "denied");
      if (!this.rate.admit(hop.dest.host)) throw new DomainError("rate_limited", `rate limit for ${hop.dest.host}`, "denied");
    }
  }
}

function looksLikeHostArg(args: string[]): boolean {
  return args.some(
    (a) =>
      /^https?:\/\//.test(a) ||
      /^\d{1,3}(\.\d{1,3}){3}/.test(a) ||
      (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(a) && !a.startsWith("-")),
  );
}

/** nc/ncat/socat take raw host+port args; pair them so the port is egress-checked. */
const TCP_CLIENT_BINS = new Set(["nc", "ncat", "socat"]);

function tcpDestFromArgs(bin: string, args: string[]): string | null {
  if (bin === "socat") {
    for (const a of args) {
      const m = a.match(/^TCP[46]?:([A-Za-z0-9.-]+):(\d{1,5})$/);
      if (m) return `tcp://${m[1]}:${m[2]}`;
    }
    return null;
  }
  let host: string | null = null;
  let port: string | null = null;
  for (const a of args) {
    if (a.startsWith("-")) continue;
    if (/^\d{1,5}$/.test(a)) {
      if (!port) port = a;
      continue;
    }
    if (!host && /^[A-Za-z0-9.-]+$/.test(a)) host = a;
  }
  return host && port ? `tcp://${host}:${port}` : null;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parseLabels(stdout: string): Record<string, string> {
  try {
    const parsed = JSON.parse(stdout.trim() || "{}") as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    // unparseable inspect output: treat as unlabeled
  }
  return {};
}

function ownedByThisProject(labels: Record<string, string>): boolean {
  return labels["rionext.from"] === "master";
}

function initConflict(name: string): DomainError {
  return new DomainError(
    "kali_init_conflict",
    `container ${name} is already initialized with a different configuration`,
    "denied",
  );
}

function foreignConflict(name: string): DomainError {
  return new DomainError(
    "kali_init_conflict",
    `container ${name} exists but is not owned by this project; refusing to remove or reuse it`,
    "denied",
  );
}

function assertOwnedMatch(name: string, spec: ContainerSpec, labels: Record<string, string>): void {
  if (!ownedByThisProject(labels)) throw foreignConflict(name);
  // Containers created before fingerprints existed carry no fp label; accept
  // them as owned (their config predates conflict detection).
  const fp = labels["rionext.fp"];
  if (fp != null && fp !== spec.fingerprint) throw initConflict(name);
}

/**
 * Cross-process init maintenance lock: a file in the data dir's locks/ folder,
 * created O_EXCL, self-describing, with a TTL so a crashed initializer cannot
 * block later attempts forever. Init is bounded by the docker call timeouts
 * (well under the TTL). The lock never authorizes deleting a container — it
 * only serializes creation; ownership checks stay authoritative.
 */
const INIT_LOCK_TTL_MS = 120_000;

interface InitLockHandle {
  release(): void;
}

function initLockPath(dataDir: string, name: string): string {
  return join(dataDir, "locks", `init-${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.lock`);
}

export function acquireInitLock(dataDir: string, name: string, fingerprint: string): InitLockHandle | null {
  const path = initLockPath(dataDir, name);
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ token, pid: process.pid, name, fingerprint, at: Date.now() }), {
        encoding: "utf8",
        flag: "wx",
      });
      return {
        release: () => {
          try {
            const cur = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
            if (cur.token === token) rmSyncSilent(path);
          } catch {
            // lock file already gone or replaced
          }
        },
      };
    } catch {
      // EEXIST: held by someone else — maybe stale
      if (!initLockHeldByOthers(dataDir, name) && attempt === 0) {
        rmSyncSilent(path);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** True when a fresh lock file for this name exists (any holder). */
export function initLockHeldByOthers(dataDir: string, name: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(initLockPath(dataDir, name), "utf8")) as { at?: number };
    return typeof raw.at === "number" && Date.now() - raw.at < INIT_LOCK_TTL_MS;
  } catch {
    return false;
  }
}

function rmSyncSilent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function containerRootOf(opts: KaliStartOpts): string {
  return opts.shared?.containerRoot ?? "/workspace";
}

/** Container-side cwd: the campaign root, or the run's private dir under it. */
function runRootOf(opts: KaliStartOpts): string {
  const base = containerRootOf(opts);
  return opts.runId ? `${base}/runs/${opts.runId}` : base;
}

/** Host-side run dir; created on demand so the container -w target exists. */
function runDirHost(opts: KaliStartOpts): string | null {
  if (!opts.runId) return null;
  const dir = join(opts.workspaceHost, "runs", opts.runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function opFiles(workspaceHost: string, executionId: string, containerRoot = "/workspace"): {
  sh: string;
  out: string;
  err: string;
  exit: string;
  json: string;
  pid: string;
  containerSh: string;
  containerOut: string;
  containerErr: string;
  containerExit: string;
  containerJson: string;
  containerPid: string;
} {
  const id = executionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const dir = join(workspaceHost, ".rionext-ops");
  return {
    sh: join(dir, `${id}.sh`),
    out: join(dir, `${id}.out`),
    err: join(dir, `${id}.err`),
    exit: join(dir, `${id}.exit`),
    json: join(dir, `${id}.json`),
    pid: join(dir, `${id}.pid`),
    containerSh: `${containerRoot}/.rionext-ops/${id}.sh`,
    containerOut: `${containerRoot}/.rionext-ops/${id}.out`,
    containerErr: `${containerRoot}/.rionext-ops/${id}.err`,
    containerExit: `${containerRoot}/.rionext-ops/${id}.exit`,
    containerJson: `${containerRoot}/.rionext-ops/${id}.json`,
    containerPid: `${containerRoot}/.rionext-ops/${id}.pid`,
  };
}

/**
 * The persistent per-execution record (H04 §6.5): what was launched, where,
 * for which run, and how it ended. Written atomically (tmp + rename) so a
 * query never reads a half-written record.
 */
export interface ExecRecord {
  execution_id: string;
  container: string;
  run_id: string | null;
  argv_preview: string[];
  phase: "started" | "ended";
  started_at: string;
  ended_at?: string;
  code?: number;
  timed_out?: boolean;
  cancel_requested?: boolean;
  cancel_confirmed?: boolean;
}

export function writeExecRecord(path: string, record: ExecRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record), "utf8");
  // rename over the target is atomic on POSIX and on Windows (Node maps to
  // MoveFileEx with REPLACE_EXISTING).
  renameSync(tmp, path);
}

export function readExecRecord(path: string): ExecRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ExecRecord;
    return parsed && typeof parsed.execution_id === "string" ? parsed : null;
  } catch {
    return null;
  }
}
