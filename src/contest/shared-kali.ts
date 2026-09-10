/**
 * The contest supervisor's shared Kali container. One box for all slot
 * campaigns: it mounts the workspace PARENT dir, each campaign lives under
 * /workspace/<campaignId> inside it. Per-campaign network admission is still
 * enforced host-side by KaliRuntime.admitNet; the container-level iptables
 * egress list is best-effort (the image drops NET_ADMIN, so entrypoint/rules
 * replay silently no-op) and is maintained here only for parity.
 */
import { join } from "node:path";
import { KaliRuntime, collectAllowIps, systemLookup4, type KaliStartOpts } from "../tools/kali-runtime.ts";

export interface SharedKaliOptions {
  /** Container name, e.g. rionext-kali-contest. */
  name: string;
  /** Host dir mounted at /workspace — the per-campaign workspace parent. */
  mountHost: string;
  /** Contest data dir (for db/secrets/artifact collision checks). */
  dataDir: string;
  image?: string;
  /** Resource limits for the shared box; defaults are 4x single-campaign. */
  limits?: { memory?: string; cpus?: string };
  onLog?: (line: string) => void;
}

export const DEFAULT_SHARED_LIMITS = { memory: "16g", cpus: "8" } as const;

export class SharedKali {
  readonly name: string;
  private readonly kali: KaliRuntime;
  private readonly opts: SharedKaliOptions;

  constructor(opts: SharedKaliOptions, kali?: KaliRuntime) {
    this.opts = opts;
    this.name = opts.name;
    this.kali = kali ?? new KaliRuntime();
  }

  /** Idempotent: creates the shared container when missing, reuses when running. */
  ensure(unionAssets: string[]): void {
    const start: KaliStartOpts = {
      campaignId: "contest-shared",
      workspaceHost: this.opts.mountHost,
      dbPath: join(this.opts.dataDir, "rionext.sqlite"),
      secretsPath: join(this.opts.dataDir, "provider-secrets.json"),
      artifactRoot: join(this.opts.dataDir, "artifacts"),
      dataDir: this.opts.dataDir,
      allowAssets: unionAssets,
      // Per-campaign admission happens host-side; the box just needs egress.
      network: unionAssets.length ? "allowlist" : "bridge",
      image: this.opts.image,
      shared: { name: this.name, mountHost: this.opts.mountHost, containerRoot: "/workspace" },
      limits: this.opts.limits ?? DEFAULT_SHARED_LIMITS,
    };
    this.kali.ensure(start);
  }

  /**
   * Best-effort replay of the entrypoint egress rules with the union of live
   * campaigns' assets. Without NET_ADMIN inside the container every iptables
   * call no-ops silently (same as the entrypoint today); host-side admitNet
   * remains the effective per-campaign gate.
   */
  applyAllowlist(unionAssets: string[]): void {
    if (this.kali.inspectName(this.name) !== "running") return;
    const ips = collectAllowIps(unionAssets, systemLookup4);
    const lines = [
      "if command -v iptables >/dev/null 2>&1; then",
      "iptables -F OUTPUT 2>/dev/null || true",
      "iptables -P OUTPUT DROP 2>/dev/null || true",
      "iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true",
      "iptables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true",
      "iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || true",
      ...ips.map((ip) => `iptables -A OUTPUT -d ${ip} -j ACCEPT 2>/dev/null || true`),
      "fi",
    ];
    this.kali.execShell(this.name, lines.join("; "));
  }

  status(): "running" | "exited" | "missing" {
    return this.kali.inspectName(this.name);
  }

  kill(): void {
    this.kali.killName(this.name);
  }
}
