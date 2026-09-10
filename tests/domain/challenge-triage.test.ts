import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyKindOverride } from "../../src/domain/challenge-kind.ts";
import { classifyChallenge, listZipMembers } from "../../src/domain/challenge-triage.ts";
import { stageInput } from "../../src/domain/input-manifest.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-triage-"));
}

/** Minimal 64-bit LE ELF with one PT_INTERP program header. */
function elf64(): Buffer {
  const b = Buffer.alloc(4096);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = 2; // 64-bit
  b[5] = 1; // little-endian
  b[6] = 1;
  b.writeUInt16LE(3, 16); // ET_DYN
  b.writeUInt16LE(0x3e, 18); // x86-64
  b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(0x1000n, 24);
  b.writeBigUInt64LE(64n, 32); // phoff
  b.writeUInt16LE(64, 52);
  b.writeUInt16LE(56, 54);
  b.writeUInt16LE(1, 56);
  b.writeUInt32LE(3, 64); // PT_INTERP
  return b;
}

function pe32plus(dotnet: boolean): Buffer {
  const b = Buffer.alloc(4096);
  b[0] = 0x4d;
  b[1] = 0x5a;
  b.writeUInt32LE(0x80, 0x3c);
  b.writeUInt32LE(0x00004550, 0x80);
  b.writeUInt16LE(0x8664, 0x84);
  b.writeUInt16LE(0x20b, 0x98); // PE32+
  const dd = 0x98 + 112;
  if (dotnet) b.writeUInt32LE(0x2000, dd + 14 * 8); // COM descriptor
  return b;
}

/** Hand-rolled ZIP: local headers + central directory + EOCD. */
function zip(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(20, 8);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, n]));
    offset += 30 + n.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function stage(file: string, data: Buffer | string): { manifest: ReturnType<typeof stageInput>; originalDir: string } {
  const dir = tmp();
  const src = join(dir, file);
  writeFileSync(src, data);
  const ws = join(dir, "ws");
  const manifest = stageInput(src, ws);
  return { manifest, originalDir: join(ws, "input", "original") };
}

test("ELF binary routes to reverse", () => {
  const { manifest, originalDir } = stage("crackme", elf64());
  const r = classifyChallenge({ manifest, originalDir });
  assert.equal(r.kind, "reverse");
  assert.equal(r.seed_method_family, "reverse-native");
  assert.equal(r.confidence, "high");
});

test("ELF plus endpoint routes to pwn", () => {
  const { manifest, originalDir } = stage("chall", elf64());
  const r = classifyChallenge({ manifest, originalDir, endpoint: { host: "pwn.example", port: 31337 } });
  assert.equal(r.kind, "pwn");
  assert.equal(r.seed_method_family, "pwn-chain");
});

test("ELF plus pwn description routes to pwn", () => {
  const dir = tmp();
  mkdirSync(join(dir, "in"));
  writeFileSync(join(dir, "in", "chall"), elf64());
  writeFileSync(join(dir, "in", "README.txt"), "stack overflow, build a ROP chain, nc host 9001");
  const ws = join(dir, "ws");
  const manifest = stageInput(join(dir, "in"), ws);
  const r = classifyChallenge({ manifest, originalDir: join(ws, "input", "original") });
  assert.equal(r.kind, "pwn");
  assert.equal(r.confidence, "medium");
});

test("APK zip structure routes to reverse with apk overlay", () => {
  const { manifest, originalDir } = stage("app.apk", zip(["AndroidManifest.xml", "classes.dex", "res/values/strings.xml"]));
  const r = classifyChallenge({ manifest, originalDir });
  assert.equal(r.kind, "reverse");
  assert.equal(r.overlay, "apk");
  assert.equal(r.seed_method_family, "apk-reverse");
});

test("Office zip routes to misc, jar routes to generic", () => {
  const docx = stage("doc.docx", zip(["[Content_Types].xml", "word/document.xml"]));
  const r1 = classifyChallenge({ manifest: docx.manifest, originalDir: docx.originalDir });
  assert.equal(r1.kind, "misc");
  const jar = stage("lib.jar", zip(["META-INF/MANIFEST.MF", "a/b/Main.class"]));
  const r2 = classifyChallenge({ manifest: jar.manifest, originalDir: jar.originalDir });
  assert.equal(r2.kind, "generic");
});

test(".NET PE routes to reverse with dotnet overlay", () => {
  const { manifest, originalDir } = stage("app.exe", pe32plus(true));
  const r = classifyChallenge({ manifest, originalDir });
  assert.equal(r.kind, "reverse");
  assert.equal(r.overlay, "dotnet");
  assert.equal(r.seed_method_family, "dotnet-reverse");
});

test("native PE routes to reverse without overlay", () => {
  const { manifest, originalDir } = stage("app.exe", pe32plus(false));
  const r = classifyChallenge({ manifest, originalDir });
  assert.equal(r.kind, "reverse");
  assert.equal(r.overlay, undefined);
});

test("PNG and PCAP route to misc with overlays", () => {
  const png = stage("a.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));
  const r1 = classifyChallenge({ manifest: png.manifest, originalDir: png.originalDir });
  assert.equal(r1.kind, "misc");
  assert.equal(r1.overlay, "stego");
  const pcap = stage("cap.pcap", Buffer.concat([Buffer.from([0xd4, 0xc3, 0xb2, 0xa1]), Buffer.alloc(64)]));
  const r2 = classifyChallenge({ manifest: pcap.manifest, originalDir: pcap.originalDir });
  assert.equal(r2.kind, "misc");
  assert.equal(r2.overlay, "protocol");
  assert.equal(r2.seed_method_family, "protocol-pcap");
});

test("RSA parameter text routes to crypto", () => {
  const body = "RSA challenge\nn = 2519590847565789349402718324004839857142928212620403202777713783604366202070\ne = 65537\nc = 42\n";
  const { manifest, originalDir } = stage("cipher.txt", body);
  const r = classifyChallenge({ manifest, originalDir });
  assert.equal(r.kind, "crypto");
  assert.equal(r.seed_method_family, "ctf-crypto");
});

test("unknown blob routes to generic", () => {
  const { manifest, originalDir } = stage("mystery.bin", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  const r = classifyChallenge({ manifest, originalDir });
  assert.equal(r.kind, "generic");
  assert.equal(r.seed_method_family, "ctf-triage");
  assert.equal(r.confidence, "low");
});

test("--kind override beats magic", () => {
  const { manifest, originalDir } = stage("crackme", elf64());
  const detected = classifyChallenge({ manifest, originalDir });
  const overridden = applyKindOverride(detected, "crypto");
  assert.equal(overridden.kind, "crypto");
  assert.equal(overridden.seed_method_family, "ctf-crypto");
  assert.equal(detected.kind, "reverse");
});

test("zip central directory listing is exact", () => {
  const names = listZipMembersOf(zip(["a.txt", "dir/b.bin"]));
  assert.deepEqual(names.sort(), ["a.txt", "dir/b.bin"]);
});

function listZipMembersOf(buf: Buffer): string[] {
  const dir = tmp();
  const p = join(dir, "x.zip");
  writeFileSync(p, buf);
  return listZipMembers(p);
}
