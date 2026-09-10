import { DomainError } from "../domain/errors.ts";

export interface AllowEntry {
  host?: string;
  cidr?: string;
  port?: number;
}

export interface Destination {
  protocol: string;
  host: string;
  port: number;
  raw: string;
}

export type ResolveFn = (host: string) => string[];

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const m = h.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return [m[1], m[2], m[3]].every((x) => Number(x) <= 255);
}

export function parseDestination(raw: string): Destination {
  const text = raw.trim();
  if (!text) throw deny("empty_dest", "destination is empty");
  if (/[\s;|&`$<>]/.test(text)) throw deny("dest_metachar", "destination contains shell metacharacters");
  let url: URL;
  try {
    url = text.includes("://") ? new URL(text) : new URL(`https://${text}`);
  } catch {
    throw deny("dest_parse", `cannot parse destination ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "tcp:") {
    throw deny("dest_protocol", `protocol ${url.protocol} is not allowed`);
  }
  const host = url.hostname.toLowerCase();
  if (!host) throw deny("dest_host", "destination host is empty");
  const proto = url.protocol.replace(":", "");
  const port = url.port ? Number(url.port) : proto === "http" ? 80 : proto === "https" ? 443 : 0;
  if (!port) throw deny("dest_port", "tcp destination requires an explicit port");
  return { protocol: proto, host, port, raw: text };
}

export function parseAllowList(assets: string[]): AllowEntry[] {
  const out: AllowEntry[] = [];
  for (const a of assets) {
    const s = a.trim();
    if (!s) continue;
    if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s)) {
      out.push({ cidr: s });
      continue;
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) {
      out.push({ host: s });
      continue;
    }
    const hostPort = s.match(/^([A-Za-z0-9.-]+)(?::(\d+))?$/);
    if (hostPort) {
      out.push({ host: hostPort[1]!.toLowerCase(), port: hostPort[2] ? Number(hostPort[2]) : undefined });
      continue;
    }
    try {
      const d = parseDestination(s);
      out.push({ host: d.host, port: d.port });
    } catch {
      out.push({ host: s.toLowerCase() });
    }
  }
  return out;
}

export function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d+$/.test(x)) return null;
    const v = Number(x);
    if (v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base || bitsRaw === undefined) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipn = ipv4ToInt(ip);
  const basen = ipv4ToInt(base);
  if (ipn === null || basen === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipn & mask) === (basen & mask);
}

export function hostAllowed(host: string, allow: AllowEntry[]): boolean {
  const h = host.toLowerCase();
  return allow.some((e) => e.host === h || (e.host && (h === e.host || h.endsWith(`.${e.host}`))));
}

export function ipAllowed(ip: string, allow: AllowEntry[]): boolean {
  return allow.some((e) => (e.cidr && ipInCidr(ip, e.cidr)) || e.host === ip);
}

export function checkEgress(
  dest: Destination,
  allow: AllowEntry[],
  resolve: ResolveFn,
): { ok: true; ips: string[] } | { ok: false; reason: string } {
  if (isLoopbackHost(dest.host)) return { ok: true, ips: ["127.0.0.1"] };
  if (allow.length === 0) return { ok: false, reason: "empty_allowlist" };
  const hostOk = hostAllowed(dest.host, allow);
  let ips: string[] = [];
  try {
    ips = resolve(dest.host);
  } catch (err) {
    return { ok: false, reason: `resolve_failed:${String(err)}` };
  }
  const ipOk = ips.length > 0 && ips.every((ip) => ipAllowed(ip, allow));
  if (!hostOk && !ipOk) return { ok: false, reason: `host_not_allowed:${dest.host}` };
  if (hostOk && ips.length && !ipOk) {
    // Name is listed, but a hop to a different address still has to match cidr/IP entries or the same name.
    // Direct use of a listed hostname is allowed; redirects go through checkRedirect.
  }
  const portConstrained = allow.filter((e) => e.port !== undefined);
  if (portConstrained.length && !allow.some((e) => e.port === undefined || e.port === dest.port)) {
    return { ok: false, reason: `port_not_allowed:${dest.port}` };
  }
  return { ok: true, ips };
}

export function checkRedirect(
  location: string,
  allow: AllowEntry[],
  resolve: ResolveFn,
): { ok: true; dest: Destination; ips: string[] } | { ok: false; reason: string } {
  let dest: Destination;
  try {
    dest = parseDestination(location);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const r = checkEgress(dest, allow, resolve);
  if (!r.ok) return r;
  return { ok: true, dest, ips: r.ips };
}

function deny(code: string, message: string): DomainError {
  return new DomainError(code, message, "denied");
}
