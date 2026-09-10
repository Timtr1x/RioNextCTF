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

/** Labelled binary groups for the skill_pack header, per challenge kind. */
export function binGroupsFor(kind: string): Array<[string, ReadonlySet<string>]> {
  const groups: Array<[string, ReadonlySet<string>]> = [
    ["基础", BASE_BINS],
    ["CTF 通用", CTF_BASE_BINS],
  ];
  const push = (label: string, bins: ReadonlySet<string>) => {
    if (!groups.some(([, s]) => s === bins)) groups.push([label, bins]);
  };
  if (kind === "reverse" || kind === "pwn") push("逆向/利用", BINARY_BINS);
  else if (kind === "misc") push("Misc/取证", MISC_BINS);
  else if (kind === "crypto") push("密码", CRYPTO_BINS);
  else {
    push("逆向/利用", BINARY_BINS);
    push("Misc/取证", MISC_BINS);
    push("密码", CRYPTO_BINS);
    push("网络", new Set(["curl", "wget"]));
  }
  return groups;
}

/** ctf-python library list for the skill_pack header, per challenge kind. */
export function pyLibsFor(kind: string): string[] {
  const out = new Set<string>();
  const add = (libs: readonly string[]) => libs.forEach((l) => out.add(l));
  if (kind === "reverse" || kind === "pwn") add(CTF_PY_LIBS.binary);
  else if (kind === "misc") add(CTF_PY_LIBS.misc);
  else if (kind === "crypto") add(CTF_PY_LIBS.crypto);
  else {
    add(CTF_PY_LIBS.binary);
    add(CTF_PY_LIBS.misc);
    add(CTF_PY_LIBS.crypto);
  }
  return [...out];
}

function union(...sets: ReadonlySet<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const b of s) out.add(b);
  return out;
}

/** Legacy flat web allowlist. Exactly BASE+WEB; do not add CTF tools here. */
export const KALI_BINARIES = union(BASE_BINS, WEB_BINS);

/**
 * Binary set for a challenge kind. "web" is the legacy set; unknown kinds fall
 * back to the broad CTF union (never used for web campaigns, which carry no
 * spec.challenge and default to "web" at the call site).
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
      return union(BASE_BINS, CTF_BASE_BINS, BINARY_BINS, MISC_BINS, CRYPTO_BINS, new Set(["curl", "wget"]));
  }
}

/** Any binary known to any profile; used only for payload routing, not admission. */
export function isKnownKaliBin(bin: string): boolean {
  if (!/^[A-Za-z0-9_.+-]+$/.test(bin)) return false;
  if (allowedBinsFor("generic").has(bin) || KALI_BINARIES.has(bin)) return true;
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

/** Per-kind admission: set membership, with the impacket- prefix reserved for web. */
export function isAllowedKaliBinFor(bin: string, kind: string): boolean {
  if (!/^[A-Za-z0-9_.+-]+$/.test(bin)) return false;
  if (allowedBinsFor(kind).has(bin)) return true;
  return kind === "web" && bin.startsWith("impacket-");
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
 * @param kind challenge kind for the campaign; undefined keeps legacy web
 * behavior (KALI_BINARIES + impacket- prefix).
 */
export function assertKaliArgv(bin: string, args: string[], kind?: string): void {
  const allowed = kind === undefined ? isAllowedKaliBin(bin) : isAllowedKaliBinFor(bin, kind);
  if (!allowed) {
    argvDenied(`kali binary not allowlisted${kind ? ` for ${kind}` : ""}: ${bin}`);
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
