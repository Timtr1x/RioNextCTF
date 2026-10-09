import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../../src/domain/errors.ts";
import {
  allowedBinsFor,
  allowedBinsForCapabilities,
  assertKaliArgv,
  BASE_BINS,
  isAllowedKaliBinForCaps,
  KALI_BINARIES,
  resolveToolCapabilities,
  WEB_BINS,
} from "../../src/tools/kali-profile.ts";

/** The pre-CTF flat allowlist, frozen. Web must keep exactly these binaries. */
const LEGACY_WEB_BINS = [
  "nmap", "curl", "wget", "gobuster", "ffuf", "nikto", "sqlmap", "whatweb", "dig", "whois", "openssl",
  "httpx", "httpx-toolkit", "httpx-pd", "nuclei", "katana", "dalfox", "cloudfox", "kerbrute", "chisel",
  "chromium", "chromium-browser",
  "cat", "head", "tail", "ls", "find", "grep", "rg", "wc", "file", "bash", "sh", "python3",
  "mkdir", "chmod", "tee", "rm", "cp", "mv",
].sort();

test("KALI_BINARIES is exactly the legacy web set (BASE+WEB, no CTF additions)", () => {
  assert.deepEqual([...KALI_BINARIES].sort(), LEGACY_WEB_BINS);
  const composed = new Set([...BASE_BINS, ...WEB_BINS]);
  assert.deepEqual([...composed].sort(), [...KALI_BINARIES].sort());
});

test("allowedBinsFor(web) equals the legacy set", () => {
  assert.deepEqual([...allowedBinsFor("web")].sort(), LEGACY_WEB_BINS);
});

// --- capability resolution ---

test("legacy kali campaign without a challenge record resolves to web only", () => {
  const r = resolveToolCapabilities({
    execution_profile: "kali",
    scope: { entries: ["http://target.example/"] },
  });
  assert.deepEqual(r.capabilities, ["web"]);
});

test("a challenge record (attachments) resolves to ctf even without any network entry", () => {
  const r = resolveToolCapabilities({
    execution_profile: "kali",
    challenge: { kind: "reverse", input: { source_name: "crackme", files: 1, total_bytes: 4, sha256: "x" } },
    scope: { entries: [] },
  });
  assert.deepEqual(r.capabilities, ["ctf"]);
});

test("challenge plus web_url resolves to ctf+web", () => {
  const r = resolveToolCapabilities({
    execution_profile: "kali",
    challenge: { kind: "generic", web_url: "http://mixed.example/" },
    scope: { entries: ["http://mixed.example/"] },
  });
  assert.deepEqual(r.capabilities, ["ctf", "web"]);
});

test("kind misclassification does not shrink the set: crypto-labelled ELF still gets the full ctf set", () => {
  const r = resolveToolCapabilities({
    execution_profile: "kali",
    challenge: { kind: "crypto", input: { source_name: "app.elf", files: 1, total_bytes: 4, sha256: "x" } },
    scope: { entries: [] },
  });
  const bins = allowedBinsForCapabilities(r.capabilities);
  assert.ok(bins.has("gdb") && bins.has("binwalk") && bins.has("openssl"));
});

test("an http(s) scope entry alone marks web capability (legacy field-lost campaigns)", () => {
  const r = resolveToolCapabilities({
    execution_profile: "kali",
    scope: { entries: ["http://legacy.example/"] },
  });
  assert.deepEqual(r.capabilities, ["web"]);
});

test("tcp-only endpoints do not add web capability", () => {
  const r = resolveToolCapabilities({
    execution_profile: "kali",
    challenge: { kind: "pwn" },
    scope: { entries: ["tcp://pwn.example:31337"] },
  });
  assert.deepEqual(r.capabilities, ["ctf"]);
});

test("non-kali profiles resolve to no capabilities", () => {
  const r = resolveToolCapabilities({ execution_profile: "synthetic", scope: { entries: [] } });
  assert.deepEqual(r.capabilities, []);
});

// --- capability admission ---

test("ctf capability admits binary/misc/crypto tools plus curl/wget, but not web scanners", () => {
  const bins = allowedBinsForCapabilities(["ctf"]);
  for (const b of ["gdb", "r2", "checksec", "binwalk", "gp", "curl", "wget", "nc", "tshark", "openssl"]) {
    assert.ok(bins.has(b), `ctf missing ${b}`);
  }
  for (const b of ["nmap", "sqlmap", "nuclei", "chromium"]) {
    assert.ok(!bins.has(b), `ctf should not expose ${b}`);
  }
});

test("web capability equals the legacy set", () => {
  assert.deepEqual([...allowedBinsForCapabilities(["web"])].sort(), LEGACY_WEB_BINS);
});

test("ctf+web composes both sets", () => {
  const bins = allowedBinsForCapabilities(["ctf", "web"]);
  for (const b of ["gdb", "binwalk", "gp", "nmap", "sqlmap", "nuclei", "curl"]) {
    assert.ok(bins.has(b), `ctf+web missing ${b}`);
  }
});

test("argv assertion follows capabilities, not classification", () => {
  assert.throws(
    () => assertKaliArgv("gdb", ["./chall"], ["web"]),
    (e: unknown) => e instanceof DomainError && e.code === "kali_argv",
  );
  assert.doesNotThrow(() => assertKaliArgv("gdb", ["./chall"], ["ctf"]));
  assert.throws(() => assertKaliArgv("nmap", ["-sn", "10.0.0.1"], ["ctf"]));
  assert.doesNotThrow(() => assertKaliArgv("nmap", ["-sn", "10.0.0.1"], ["web"]));
  assert.doesNotThrow(() => assertKaliArgv("nmap", ["-sn", "10.0.0.1"], ["ctf", "web"]));
  assert.doesNotThrow(() => assertKaliArgv("binwalk", ["a.png"], ["ctf"]));
});

test("impacket- prefix needs the web capability; legacy no-caps call is web semantics", () => {
  assert.ok(isAllowedKaliBinForCaps("impacket-secretsdump", ["web"]));
  assert.ok(isAllowedKaliBinForCaps("impacket-secretsdump", ["ctf", "web"]));
  assert.equal(isAllowedKaliBinForCaps("impacket-secretsdump", ["ctf"]), false);
  assert.throws(() => assertKaliArgv("impacket-secretsdump", ["-h"], ["ctf"]));
  // legacy behavior unchanged
  assert.doesNotThrow(() => assertKaliArgv("impacket-secretsdump", ["-h"]));
  assert.throws(() => assertKaliArgv("gdb", []));
});

test("ctf-python follows interpreter rules under ctf capability", () => {
  assert.doesNotThrow(() => assertKaliArgv("ctf-python", ["/workspace/work/exp.py"], ["ctf"]));
  assert.throws(() => assertKaliArgv("ctf-python", ["/etc/passwd"], ["ctf"]));
  assert.throws(() => assertKaliArgv("ctf-python", ["-c", "print(1)"], ["web"]));
});

// --- recommendation sets (kind only recommends; it never admits) ---

test("allowedBinsFor stays as per-kind recommendation sets", () => {
  for (const kind of ["reverse", "pwn"]) {
    const bins = allowedBinsFor(kind);
    for (const b of ["gdb", "r2", "checksec", "readelf", "ROPgadget", "qemu-x86_64", "socat", "nc", "ctf-python", "gcc"]) {
      assert.ok(bins.has(b), `${kind} missing ${b}`);
    }
  }
  assert.deepEqual([...allowedBinsFor("reverse")].sort(), [...allowedBinsFor("pwn")].sort());
  const misc = allowedBinsFor("misc");
  for (const b of ["binwalk", "exiftool", "tshark", "zsteg"]) assert.ok(misc.has(b), `misc missing ${b}`);
  const crypto = allowedBinsFor("crypto");
  for (const b of ["openssl", "john", "hashcat", "gp"]) assert.ok(crypto.has(b), `crypto missing ${b}`);
  // the broad CTF recommendation equals the ctf capability set
  assert.deepEqual([...allowedBinsFor("generic")].sort(), [...allowedBinsForCapabilities(["ctf"])].sort());
});
