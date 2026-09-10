import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../../src/domain/errors.ts";
import {
  allowedBinsFor,
  assertKaliArgv,
  BASE_BINS,
  isAllowedKaliBinFor,
  KALI_BINARIES,
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

test("reverse/pwn see binary tools but no web scanners", () => {
  for (const kind of ["reverse", "pwn"]) {
    const bins = allowedBinsFor(kind);
    for (const b of ["gdb", "r2", "checksec", "readelf", "ROPgadget", "qemu-x86_64", "socat", "nc", "ctf-python", "gcc"]) {
      assert.ok(bins.has(b), `${kind} missing ${b}`);
    }
    for (const b of ["nmap", "sqlmap", "nuclei", "gobuster", "curl", "chromium"]) {
      assert.ok(!bins.has(b), `${kind} should not expose ${b}`);
    }
    // base utilities stay
    for (const b of ["bash", "python3", "file", "grep"]) assert.ok(bins.has(b), `${kind} missing base ${b}`);
  }
  assert.deepEqual([...allowedBinsFor("reverse")].sort(), [...allowedBinsFor("pwn")].sort());
});

test("misc and crypto see their own tools only", () => {
  const misc = allowedBinsFor("misc");
  for (const b of ["binwalk", "exiftool", "tshark", "zsteg", "ffmpeg", "qpdf", "7z", "xxd"]) assert.ok(misc.has(b), `misc missing ${b}`);
  for (const b of ["gdb", "r2", "nmap", "gp"]) assert.ok(!misc.has(b), `misc should not expose ${b}`);
  const crypto = allowedBinsFor("crypto");
  for (const b of ["openssl", "john", "hashcat", "gp", "ctf-python"]) assert.ok(crypto.has(b), `crypto missing ${b}`);
  for (const b of ["gdb", "binwalk", "nmap"]) assert.ok(!crypto.has(b), `crypto should not expose ${b}`);
});

test("generic sees the CTF union plus curl/wget, still no web scanners", () => {
  const g = allowedBinsFor("generic");
  for (const b of ["gdb", "binwalk", "gp", "curl", "wget", "nc", "tshark"]) assert.ok(g.has(b), `generic missing ${b}`);
  for (const b of ["nmap", "sqlmap", "nuclei", "chromium"]) assert.ok(!g.has(b), `generic should not expose ${b}`);
});

test("per-kind argv assertion denies cross-kind binaries", () => {
  assert.throws(
    () => assertKaliArgv("gdb", ["./chall"], "web"),
    (e: unknown) => e instanceof DomainError && e.code === "kali_argv",
  );
  assert.doesNotThrow(() => assertKaliArgv("gdb", ["./chall"], "reverse"));
  assert.doesNotThrow(() => assertKaliArgv("gdb", ["./chall"], "pwn"));
  assert.throws(() => assertKaliArgv("nmap", ["-sn", "10.0.0.1"], "reverse"));
  assert.doesNotThrow(() => assertKaliArgv("binwalk", ["a.png"], "misc"));
  assert.throws(() => assertKaliArgv("binwalk", ["a.png"], "crypto"));
});

test("impacket- prefix stays web-only; legacy no-kind call is web semantics", () => {
  assert.ok(isAllowedKaliBinFor("impacket-secretsdump", "web"));
  assert.equal(isAllowedKaliBinFor("impacket-secretsdump", "reverse"), false);
  assert.throws(() => assertKaliArgv("impacket-secretsdump", ["-h"], "reverse"));
  // legacy behavior unchanged
  assert.doesNotThrow(() => assertKaliArgv("impacket-secretsdump", ["-h"]));
  assert.throws(() => assertKaliArgv("gdb", []));
});

test("ctf-python follows interpreter rules for CTF kinds", () => {
  assert.doesNotThrow(() => assertKaliArgv("ctf-python", ["/workspace/work/exp.py"], "pwn"));
  assert.throws(() => assertKaliArgv("ctf-python", ["/etc/passwd"], "pwn"));
  assert.throws(() => assertKaliArgv("ctf-python", ["-c", "print(1)"], "web"));
});
