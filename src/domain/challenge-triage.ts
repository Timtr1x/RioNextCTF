/**
 * Deterministic challenge triage. Pure host-side Node: reads magic bytes,
 * container listings and shallow headers; never executes the sample, never
 * spawns a container, never calls a model. When evidence is weak the answer
 * is "generic", not a guess.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChallengeKind, TriageEvidence, TriageOverlay, TriageResult } from "./challenge-kind.ts";
import { seedFamilyForKind } from "./challenge-kind.ts";
import type { InputManifest, InputManifestEntry } from "./input-manifest.ts";

const PWN_TEXT = /\b(pwn|pwntools|buffer\s*overflow|bof\b|stack\s*overflow|\brop\b|shellcode|ret2|canary|got\s*overwrite|format\s*string|heap\s*exploit)/i;
const CRYPTO_TEXT = /\b(rsa|aes\b|des\b|cipher(text)?|encrypt|decrypt|modulus|\bprimes?\b|elliptic|\becc\b|lattice|\blcg\b|xor\s*key|one[- ]time\s*pad|diffie)/i;
const RSA_PARAMS = /(^|\n)\s*(n|N|modulus)\s*=\s*\d{20,}/;
const FLAG_HINT = /flag\{|flag format|recover the flag/i;

export interface ClassifyInput {
  manifest: InputManifest;
  /** Directory containing the staged originals (input/original). */
  originalDir: string;
  /** tcp endpoint from --endpoint, already normalized to host:port. */
  endpoint?: { host: string; port: number };
  /** Free-text hint from the operator (e.g. --hint). */
  hint?: string;
}

export function classifyChallenge(input: ClassifyInput): TriageResult {
  const evidence: TriageEvidence[] = [];
  const texts = collectTextEvidence(input, evidence);

  const binaries: { entry: InputManifestEntry; info: BinaryInfo }[] = [];
  const containers: { entry: InputManifestEntry; members: string[] }[] = [];
  const pcaps: InputManifestEntry[] = [];
  const media: InputManifestEntry[] = [];
  const archives: InputManifestEntry[] = [];

  for (const entry of input.manifest.entries) {
    const abs = join(input.originalDir, entry.relative_path);
    switch (entry.format) {
      case "elf":
      case "pe":
      case "mach-o":
      case "wasm": {
        const info = entry.format === "elf" ? parseElf(abs) : entry.format === "pe" ? parsePe(abs) : { label: entry.format };
        binaries.push({ entry, info });
        evidence.push({ source: "magic", value: `${entry.relative_path}: ${info.label}`, weight: 3 });
        break;
      }
      case "zip": {
        const members = listZipMembers(abs);
        containers.push({ entry, members });
        evidence.push({ source: "container", value: `${entry.relative_path}: zip (${members.length} members)`, weight: 2 });
        break;
      }
      case "pcap":
      case "pcapng":
        pcaps.push(entry);
        evidence.push({ source: "magic", value: `${entry.relative_path}: ${entry.format}`, weight: 3 });
        break;
      case "png":
      case "jpeg":
      case "gif":
      case "bmp":
      case "wav":
      case "mp3":
      case "ogg":
      case "pdf":
        media.push(entry);
        evidence.push({ source: "magic", value: `${entry.relative_path}: ${entry.format}`, weight: 3 });
        break;
      case "7z":
      case "gzip":
      case "xz":
      case "rar":
        archives.push(entry);
        evidence.push({ source: "magic", value: `${entry.relative_path}: ${entry.format}`, weight: 2 });
        break;
      default:
        break;
    }
  }

  for (const { entry, members } of containers) {
    if (hasAll(members, ["AndroidManifest.xml", "classes.dex"])) {
      evidence.push({ source: "container", value: `${entry.relative_path}: apk structure`, weight: 3 });
      return finish("reverse", "apk", "high", evidence);
    }
    if (members.some((m) => m === "META-INF/MANIFEST.MF" || m.endsWith(".class"))) {
      // Java RE needs jadx/cfr, which v1 does not install; route honestly.
      evidence.push({ source: "container", value: `${entry.relative_path}: jar structure (no JVM tooling in v1)`, weight: 2 });
      return finish("generic", undefined, "medium", evidence);
    }
    if (members.some((m) => m.startsWith("word/") || m.startsWith("xl/") || m === "[Content_Types].xml")) {
      evidence.push({ source: "container", value: `${entry.relative_path}: office document`, weight: 3 });
      media.push(entry);
    }
  }

  if (binaries.length > 0) {
    const dotnet = binaries.find((b) => b.info.dotnet);
    if (dotnet) {
      evidence.push({ source: "header", value: `${dotnet.entry.relative_path}: .NET assembly`, weight: 3 });
      return finish("reverse", "dotnet", "high", evidence);
    }
    const pwny = input.endpoint !== undefined || PWN_TEXT.test(texts);
    if (input.endpoint) evidence.push({ source: "user", value: `endpoint ${input.endpoint.host}:${input.endpoint.port}`, weight: 2 });
    if (PWN_TEXT.test(texts)) evidence.push({ source: "text", value: "pwn keywords in description", weight: 1 });
    if (pwny) return finish("pwn", undefined, input.endpoint ? "high" : "medium", evidence);
    return finish("reverse", undefined, binaries.length === 1 ? "high" : "medium", evidence);
  }

  if (pcaps.length > 0) {
    return finish("misc", "protocol", "high", evidence);
  }
  if (media.length > 0) {
    const overlay: TriageOverlay = media.some((m) => ["png", "jpeg", "gif", "bmp", "wav", "mp3", "ogg"].includes(m.format))
      ? "stego"
      : "forensics";
    return finish("misc", overlay, "high", evidence);
  }
  if (archives.length > 0 || containers.length > 0) {
    return finish("misc", "forensics", "medium", evidence);
  }

  if (RSA_PARAMS.test(texts) || CRYPTO_TEXT.test(texts)) {
    evidence.push({ source: "text", value: "crypto material in text input", weight: 1 });
    return finish("crypto", undefined, "medium", evidence);
  }
  if (FLAG_HINT.test(texts)) {
    evidence.push({ source: "text", value: "flag instructions only", weight: 1 });
    return finish("generic", undefined, "low", evidence);
  }
  evidence.push({ source: "magic", value: "no decisive format evidence", weight: 0 });
  return finish("generic", undefined, "low", evidence);
}

function finish(
  kind: Exclude<ChallengeKind, "auto">,
  overlay: TriageOverlay | undefined,
  confidence: TriageResult["confidence"],
  evidence: TriageEvidence[],
): TriageResult {
  return { kind, overlay, confidence, evidence, seed_method_family: seedFamilyForKind(kind, overlay) };
}

function collectTextEvidence(input: ClassifyInput, evidence: TriageEvidence[]): string {
  const parts: string[] = [];
  if (input.hint) {
    parts.push(input.hint);
    evidence.push({ source: "user", value: "operator hint", weight: 1 });
  }
  for (const entry of input.manifest.entries) {
    if (entry.format !== "text" || entry.size > 256 * 1024) continue;
    try {
      parts.push(readFileSync(join(input.originalDir, entry.relative_path), "utf8"));
      evidence.push({ source: "text", value: `${entry.relative_path}: description text`, weight: 1 });
    } catch {
      // unreadable text file is not evidence
    }
  }
  return parts.join("\n");
}

interface BinaryInfo {
  label: string;
  dotnet?: boolean;
}

const ELF_MACHINES: Record<number, string> = { 0x03: "i386", 0x28: "arm", 0x3e: "x86-64", 0xb7: "aarch64", 0xf3: "riscv" };
const PE_MACHINES: Record<number, string> = { 0x14c: "i386", 0x8664: "x64", 0x1c0: "arm", 0xaa64: "arm64" };

function readHead(file: string, n: number): Buffer {
  return readRegion(file, 0, n);
}

function readRegion(file: string, offset: number, n: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    if (offset >= size) return Buffer.alloc(0);
    const want = Math.min(n, size - offset);
    const buf = Buffer.alloc(want);
    const got = readSync(fd, buf, 0, want, offset);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** ELF header + PT_INTERP walk. No section parsing, no execution. */
export function parseElf(file: string): BinaryInfo & { machine?: number; hasInterp?: boolean } {
  const buf = readHead(file, 8192);
  if (buf.length < 52) return { label: "elf(truncated)" };
  const cls = buf[4];
  const le = buf[5] !== 2;
  const u16 = (off: number) => (le ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
  const u32 = (off: number) => (le ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
  const machine = u16(18);
  const name = ELF_MACHINES[machine] ?? `machine-${machine}`;
  let hasInterp = false;
  try {
    const phoff = cls === 2 ? Number(buf.readBigUInt64LE(32)) : u32(28);
    const phentsize = u16(cls === 2 ? 54 : 42);
    const phnum = Math.min(u16(cls === 2 ? 56 : 44), 64);
    for (let i = 0; i < phnum; i++) {
      const off = phoff + i * phentsize;
      if (off + 4 > buf.length) break;
      if (u32(off) === 3) {
        hasInterp = true;
        break;
      }
    }
  } catch {
    // truncated headers: label still identifies the file as ELF
  }
  return { label: `elf ${cls === 2 ? "64" : "32"}-bit ${name}${hasInterp ? " dynamic" : ""}`, machine, hasInterp };
}

/** PE header; checks data directory 14 (COM descriptor) for .NET. */
export function parsePe(file: string): BinaryInfo {
  const buf = readHead(file, 1024 * 1024);
  if (buf.length < 0x40) return { label: "pe(truncated)" };
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return { label: "pe(dos-stub only)" };
  const machine = buf.readUInt16LE(peOff + 4);
  const name = PE_MACHINES[machine] ?? `machine-${machine}`;
  const optMagic = buf.readUInt16LE(peOff + 24);
  const ddBase = peOff + 24 + (optMagic === 0x20b ? 112 : 96);
  let dotnet = false;
  if ((optMagic === 0x10b || optMagic === 0x20b) && ddBase + 15 * 8 <= buf.length) {
    dotnet = buf.readUInt32LE(ddBase + 14 * 8) !== 0;
  }
  return { label: `pe ${name}${dotnet ? " .NET" : ""}`, dotnet };
}

/** Central directory listing only; never decompresses members. */
export function listZipMembers(file: string): string[] {
  const size = statSync(file).size;
  const tail = readRegion(file, Math.max(0, size - 66000), 66000);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = Math.min(tail.readUInt16LE(eocd + 10), 4096);
  const cdOff = tail.readUInt32LE(eocd + 16);
  const cdSize = Math.min(tail.readUInt32LE(eocd + 12), 8 * 1024 * 1024);
  const cd = readRegion(file, cdOff, cdSize);
  let off = 0;
  const names: string[] = [];
  for (let i = 0; i < count && off + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    if (off + 46 + nameLen > cd.length) break;
    names.push(cd.subarray(off + 46, off + 46 + nameLen).toString("utf8"));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function hasAll(members: string[], wanted: string[]): boolean {
  return wanted.every((w) => members.includes(w));
}
