import { DomainError } from "../domain/errors.ts";

export const KALI_IMAGE = process.env.RIONEXT_KALI_IMAGE ?? "rionext-kali:rolling";
export const KALI_MASTER_TAG = "rionext-kali:master";
export const KALI_BASE_IMAGE = "kalilinux/kali-rolling";
/** Stopped container that pins the master image against `docker system prune -a`. Never a campaign. */
export const KALI_KEEPER_NAME = "rionext-master-keep";

export const PROTECTED_IMAGE_REFS = new Set([KALI_IMAGE, KALI_MASTER_TAG, "rionext-kali:rolling", "rionext-kali:master"]);

export function isProtectedImageRef(ref: string): boolean {
  const t = ref.trim();
  if (PROTECTED_IMAGE_REFS.has(t)) return true;
  return t === "rionext-kali" || t.startsWith("rionext-kali:");
}

/**
 * Allowlists are composed per challenge kind. BASE+WEB must stay byte-identical
 * to the legacy flat KALI_BINARIES set; CTF kinds add their own tools on top of
 * BASE so a Web campaign never sees reverse/misc/crypto binaries.
 */
export const BASE_BINS = new Set([
  "cat",
  "head",
  "tail",
  "ls",
  "find",
  "grep",
  "rg",
  "wc",
  "file",
  "bash",
  "sh",
  "python3",
  "mkdir",
  "chmod",
  "tee",
  "rm",
  "cp",
  "mv",
]);

export const WEB_BINS = new Set([
  "nmap",
  "curl",
  "wget",
  "gobuster",
  "ffuf",
  "nikto",
  "sqlmap",
  "whatweb",
  "dig",
  "whois",
  "openssl",
  "httpx",
  "httpx-toolkit",
  "httpx-pd",
  "nuclei",
  "katana",
  "dalfox",
  "cloudfox",
  "kerbrute",
  "chisel",
  "chromium",
  "chromium-browser",
]);

/** Shared by every non-web CTF kind: hex/encoding/archive basics. */
export const CTF_BASE_BINS = new Set([
  "xxd",
  "hexdump",
  "od",
  "sha256sum",
  "md5sum",
  "strings",
  "zip",
  "unzip",
  "7z",
  "tar",
  "ctf-python",
]);

export const BINARY_BINS = new Set([
  "readelf",
  "objdump",
  "nm",
  "ldd",
  "gdb",
  "gdbserver",
  "checksec",
  "r2",
  "rabin2",
  "rasm2",
  "radiff2",
  "strace",
  "ltrace",
  "patchelf",
  "qemu-x86_64",
  "qemu-i386",
  "qemu-arm",
  "qemu-aarch64",
  "ROPgadget",
  "one_gadget",
  "gcc",
  "g++",
  "make",
  "socat",
  "nc",
  "ncat",
]);

export const MISC_BINS = new Set([
  "binwalk",
  "foremost",
  "exiftool",
  "steghide",
  "stegseek",
  "zsteg",
  "pngcheck",
  "identify",
  "convert",
  "ffmpeg",
  "ffprobe",
  "zbarimg",
  "tesseract",
  "zipinfo",
  "qpdf",
  "pdfinfo",
  "pdftotext",
  "pdftoppm",
  "tshark",
  "tcpdump",
  "capinfos",
  "john",
]);

export const CRYPTO_BINS = new Set(["openssl", "john", "hashcat", "gp"]);

/** ctf-python libraries per capability group; mirrors the image tool-index. */
export const CTF_PY_LIBS = {
  binary: ["pwntools", "angr", "capstone", "unicorn", "z3", "pyelftools"],
  misc: ["scapy", "Pillow", "oletools", "numpy"],
  crypto: ["pycryptodome", "sympy", "gmpy2", "fpylll", "z3"],
} as const;

function union(...sets: ReadonlySet<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const b of s) out.add(b);
  return out;
}

/** Legacy flat web allowlist. Exactly BASE+WEB; do not add CTF tools here. */
export const KALI_BINARIES = union(BASE_BINS, WEB_BINS);

/** The full CTF capability set: every non-web challenge tool plus curl/wget. */
export const CTF_CAPABILITY_BINS = union(
  BASE_BINS,
  CTF_BASE_BINS,
  BINARY_BINS,
  MISC_BINS,
  CRYPTO_BINS,
  new Set(["curl", "wget"]),
);

/**
 * Recommendation helper: the binary set a challenge kind suggests starting
 * with. Admission no longer depends on it; the production exec path resolves
 * capabilities from the spec instead (resolveToolCapabilities).
 */
export function allowedBinsFor(kind: string): ReadonlySet<string> {
  switch (kind) {
    case "web":
      return KALI_BINARIES;
    case "reverse":
    case "pwn":
      return union(BASE_BINS, CTF_BASE_BINS, BINARY_BINS);
    case "misc":
      return union(BASE_BINS, CTF_BASE_BINS, MISC_BINS);
    case "crypto":
      return union(BASE_BINS, CTF_BASE_BINS, CRYPTO_BINS);
    default:
      return CTF_CAPABILITY_BINS;
  }
}

/**
 * Tool capability groups a campaign may use. "ctf" covers attachments/binary/
 * misc/crypto work (including nc/socat TCP clients); "web" covers the HTTP
 * scanner set. They compose: a source-plus-live-app challenge gets both.
 */
export type ToolCapability = "web" | "ctf";

export interface ResolvedToolCapabilities {
  capabilities: ToolCapability[];
  reason: string[];
}

/** Structural view of CampaignSpec so this module stays free of domain cycles. */
export interface CapabilitySource {
  execution_profile: string;
  challenge?: { kind: string; web_url?: string; input?: unknown };
  scope: { entries: string[] };
}

/**
 * Deterministic capability resolution. kind/classification only recommends;
 * admission comes from what the task actually carries: a challenge record
 * (attachments), a configured http(s) entry point, or a validated web_url.
 * Nothing here reads prompts, model output or description text.
 */
export function resolveToolCapabilities(spec: CapabilitySource): ResolvedToolCapabilities {
  if (!isKaliProfile(spec.execution_profile)) {
    return { capabilities: [], reason: ["non-kali execution profile"] };
  }
  const caps = new Set<ToolCapability>();
  const reason: string[] = [];
  if (spec.challenge) {
    caps.add("ctf");
    reason.push("challenge record (attachments)");
  }
  const hasHttpEntry = spec.scope.entries.some((e) => /^https?:\/\//i.test(e));
  if (hasHttpEntry) {
    caps.add("web");
    reason.push("http(s) scope entry");
  }
  if (spec.challenge?.web_url) {
    caps.add("web");
    reason.push("challenge.web_url");
  }
  if (caps.size === 0) {
    // Legacy kali campaign without a challenge record: keep the old web set.
    caps.add("web");
    reason.push("legacy kali default");
  }
  const order: ToolCapability[] = ["ctf", "web"];
  return { capabilities: order.filter((c) => caps.has(c)), reason };
}

/** Actual binary set for resolved capabilities. Deduped by union. */
export function allowedBinsForCapabilities(caps: readonly ToolCapability[]): ReadonlySet<string> {
  const parts: ReadonlySet<string>[] = [];
  if (caps.includes("ctf")) parts.push(CTF_CAPABILITY_BINS);
  if (caps.includes("web")) parts.push(KALI_BINARIES);
  return union(...parts);
}

/** Per-campaign admission: capability set membership; impacket- needs web. */
export function isAllowedKaliBinForCaps(bin: string, caps: readonly ToolCapability[]): boolean {
  if (!/^[A-Za-z0-9_.+-]+$/.test(bin)) return false;
  if (allowedBinsForCapabilities(caps).has(bin)) return true;
  return caps.includes("web") && bin.startsWith("impacket-");
}

/**
 * Labelled binary groups for the skill_pack header, from the resolved
 * capability set. recommendKind only marks a group as suggested; every listed
 * group is actually usable.
 */
export function binGroupsForCaps(
  caps: readonly ToolCapability[],
  recommendKind?: string,
): Array<[string, ReadonlySet<string>]> {
  const rec = (label: string, kinds: string[]) =>
    recommendKind && kinds.includes(recommendKind) ? `${label}（推荐）` : label;
  const groups: Array<[string, ReadonlySet<string>]> = [["基础", BASE_BINS]];
  if (caps.includes("ctf")) {
    groups.push(["CTF 通用", CTF_BASE_BINS]);
    groups.push([rec("逆向/利用", ["reverse", "pwn"]), BINARY_BINS]);
    groups.push([rec("Misc/取证", ["misc"]), MISC_BINS]);
    groups.push([rec("密码", ["crypto"]), CRYPTO_BINS]);
    if (!caps.includes("web")) groups.push(["网络", new Set(["curl", "wget"])]);
  }
  if (caps.includes("web")) groups.push([rec("Web", ["web"]), WEB_BINS]);
  return groups;
}

/** Any binary known to any profile; used only for payload routing, not admission. */
export function isKnownKaliBin(bin: string): boolean {
  if (!/^[A-Za-z0-9_.+-]+$/.test(bin)) return false;
  if (CTF_CAPABILITY_BINS.has(bin) || KALI_BINARIES.has(bin)) return true;
  return bin.startsWith("impacket-");
}

export const KALI_INTERPRETERS = new Set(["bash", "sh", "python3", "ctf-python"]);
export const KALI_PATH_BINS = new Set(["mkdir", "chmod", "tee", "rm", "cp", "mv"]);
/** Scanners that must not block the Execute slot. Detached docker exec + poll. */
export const KALI_BACKGROUND_BINS = new Set([
  "nmap",
  "nuclei",
  "katana",
  "gobuster",
  "ffuf",
  "nikto",
  "sqlmap",
  "whatweb",
  "dalfox",
  "cloudfox",
  "kerbrute",
  "httpx-toolkit",
  "httpx-pd",
  "wget",
]);

export function isAllowedKaliBin(bin: string): boolean {
  if (!/^[A-Za-z0-9_.+-]+$/.test(bin)) return false;
  if (KALI_BINARIES.has(bin)) return true;
  return bin.startsWith("impacket-");
}

/** Relative path under /workspace. Absolute paths must start with /workspace/. */
function argvDenied(message: string): never {
  throw new DomainError("kali_argv", message, "invalid_input");
}

export function workspaceRelPath(raw: string): string {
  const n = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n || n === "." || n === "/workspace" || n === "/workspace/") {
    argvDenied("workspace path is empty");
  }
  if (n.split("/").includes("..") || n.includes("\0")) {
    argvDenied("workspace path escape");
  }
  if (n.startsWith("/")) {
    if (!n.startsWith("/workspace/")) argvDenied("path must be under /workspace");
    return n.slice("/workspace/".length);
  }
  if (n.startsWith("~") || n.startsWith("-")) argvDenied("workspace path escape");
  return n;
}

function hasMeta(a: string): boolean {
  return /[;|&`$<>\n]/.test(a) || a.includes("$(");
}

export const PLAYWRIGHT_OPS = new Set([
  "goto",
  "snapshot",
  "click",
  "type",
  "press",
  "screenshot",
  "content",
  "wait",
  "back",
  "status",
]);

export const DEFAULT_KALI_LIMITS = {
  memory: "4g",
  cpus: "2",
  pids: 512,
  maxOutputBytes: 1_000_000,
  maxRuntimeMs: 60_000,
  maxBackgroundRuntimeMs: 60 * 60_000,
  pollIntervalMs: 2_000,
  maxWorkspaceBytes: 512_000_000,
  ratePerHost: 20,
  rateWindowMs: 60_000,
};

export function isKaliProfile(profile: string): boolean {
  return profile === "kali" || profile === "docker-kali";
}

export function shouldBackgroundKali(bin: string, _timeoutMs?: number): boolean {
  // Only scanners detach. bash/curl with a large timeout_ms stay in-process so
  // stdout returns on the same tool call instead of locking the campaign clone.
  return KALI_BACKGROUND_BINS.has(bin);
}

/**
 * @param caps resolved capabilities for the campaign; undefined keeps legacy
 * web behavior (KALI_BINARIES + impacket- prefix).
 */
export function assertKaliArgv(bin: string, args: string[], caps?: readonly ToolCapability[]): void {
  const allowed = caps === undefined ? isAllowedKaliBin(bin) : isAllowedKaliBinForCaps(bin, caps);
  if (!allowed) {
    argvDenied(`kali binary not allowlisted${caps ? ` for capabilities ${caps.join("+")}` : ""}: ${bin}`);
  }
  if (KALI_INTERPRETERS.has(bin)) {
    assertInterpreterArgv(args);
    return;
  }
  if (KALI_PATH_BINS.has(bin)) {
    assertPathBinArgv(bin, args);
    return;
  }
  for (const a of args) {
    if (hasMeta(a)) argvDenied("kali args contain shell metacharacters");
  }
}

function assertInterpreterArgv(args: string[]): void {
  const cIdx = args.indexOf("-c");
  if (cIdx >= 0) {
    if (cIdx !== args.length - 2) {
      argvDenied("interpreter -c requires a single script argument");
    }
    for (let i = 0; i < cIdx; i++) {
      if (!/^-[A-Za-z0-9]+$/.test(args[i]!)) {
        argvDenied("interpreter flags must be simple");
      }
    }
    const script = args[cIdx + 1] ?? "";
    if (script.length > 200_000) argvDenied("script too large");
    return;
  }
  const files = args.filter((a) => !a.startsWith("-"));
  if (files.length === 0) argvDenied("interpreter requires -c or a /workspace script");
  for (const f of files) workspaceRelPath(f);
  for (const a of args) {
    if (files.includes(a)) continue;
    if (hasMeta(a)) argvDenied("kali args contain shell metacharacters");
  }
}

function assertPathBinArgv(bin: string, args: string[]): void {
  for (const a of args) {
    if (a.startsWith("-") || (bin === "chmod" && /^[+=ugoa]*[rwxXst]+$/.test(a))) continue;
    if (hasMeta(a)) argvDenied("kali args contain shell metacharacters");
    workspaceRelPath(a);
  }
}
