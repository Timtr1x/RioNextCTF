/**
 * Stage a local challenge file/dir into the campaign workspace and emit a
 * SHA-256 manifest. Pure host-side Node: no docker, no execution of the input.
 *
 * Layout under <data_dir>/workspace/<campaign_id>/:
 *   input/original/    pristine copy, treated as read-only by convention
 *   input/manifest.json
 *   work/              scratch for scripts and decompiled text
 *   artifacts/         evidence and final products
 */
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { invalidInput } from "./errors.ts";

export const MAX_INPUT_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_INPUT_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_INPUT_FILES = 2000;

export interface InputManifestEntry {
  relative_path: string;
  size: number;
  sha256: string;
  format: string;
  executable: boolean;
}

export interface InputManifest {
  source_name: string;
  entries: InputManifestEntry[];
  total_bytes: number;
  /** sha256 over the sorted entry hashes; identifies this input set. */
  sha256: string;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const EXECUTABLE_FORMATS = new Set(["elf", "pe", "mach-o", "script"]);

/** Coarse magic-byte sniff. Deep parsing lives in challenge-triage.ts. */
export function sniffFormat(head: Buffer, name: string): string {
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return "elf";
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return "pe";
  if (head.length >= 4) {
    const w = head.readUInt32BE(0);
    if (w === 0xfeedface || w === 0xfeedfacf || w === 0xcefaedfe || w === 0xcffaedfe || w === 0xcafebabe) return "mach-o";
    if (w === 0x0a0d0d0a) return "pcapng";
    const le = head.readUInt32LE(0);
    if (le === 0xa1b2c3d4 || le === 0xd4c3b2a1 || le === 0xa1b23c4d || le === 0x4d3cb2a1) return "pcap";
  }
  if (head.length >= 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d) return "wasm";
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) return "zip";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 6 && (head.subarray(0, 6).toString("ascii") === "GIF87a" || head.subarray(0, 6).toString("ascii") === "GIF89a")) return "gif";
  if (head.length >= 2 && head.subarray(0, 2).toString("ascii") === "BM") return "bmp";
  if (head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
  if (head.length >= 3 && head.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
  if (head.length >= 4 && head.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
  if (head.length >= 5 && head.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (head.length >= 6 && head.readUInt32BE(0) === 0x377abcaf && head[4] === 0x27 && head[5] === 0x1c) return "7z";
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  if (head.length >= 6 && head.readUInt32BE(0) === 0xfd377a58 && head[4] === 0x5a && head[5] === 0x00) return "xz";
  if (head.length >= 4 && head.subarray(0, 4).toString("ascii") === "Rar!") return "rar";
  if (head.length >= 16 && head.subarray(0, 16).toString("ascii") === "SQLite format 3") return "sqlite";
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return "script";
  if (isMostlyText(head)) return "text";
  const lower = name.toLowerCase();
  if (/\.(txt|md|json|yaml|yml|csv|sage|gp)$/.test(lower)) return "text";
  return "data";
}

function isMostlyText(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  let bad = 0;
  for (const b of buf) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) bad += 1;
  }
  return bad / buf.length < 0.02;
}

function isExecutableFormat(format: string, head: Buffer): boolean {
  return EXECUTABLE_FORMATS.has(format);
}

export function inputRoot(workspaceHost: string): string {
  return join(workspaceHost, "input");
}

export function originalRoot(workspaceHost: string): string {
  return join(workspaceHost, "input", "original");
}

/** Read the manifest written by stageInput, or null when absent. */
export function readInputManifest(workspaceHost: string): InputManifest | null {
  try {
    const raw = readFileSync(join(inputRoot(workspaceHost), "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as InputManifest;
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Copy one file or one directory into <workspaceHost>/input/original and write
 * input/manifest.json. Rejects symlinks outright, empty directories, and
 * inputs beyond the size caps. Never modifies the source.
 */
export function stageInput(sourcePath: string, workspaceHost: string): InputManifest {
  const src = resolve(sourcePath);
  let st;
  try {
    st = lstatSync(src);
  } catch {
    throw invalidInput("input_missing", `input not found or unreadable: ${sourcePath}`);
  }
  if (st.isSymbolicLink()) {
    throw invalidInput("input_symlink", `refusing symlink input: ${sourcePath}`);
  }
  if (!st.isFile() && !st.isDirectory()) {
    throw invalidInput("input_not_file", `input must be a file or directory: ${sourcePath}`);
  }

  const files: { abs: string; rel: string }[] = [];
  if (st.isFile()) {
    files.push({ abs: src, rel: basename(src) });
  } else {
    collectFiles(src, src, files);
    if (files.length === 0) {
      throw invalidInput("input_empty", `input directory is empty: ${sourcePath}`);
    }
  }
  if (files.length > MAX_INPUT_FILES) {
    throw invalidInput("input_too_many", `input has ${files.length} files (max ${MAX_INPUT_FILES})`);
  }

  const original = originalRoot(workspaceHost);
  mkdirSync(original, { recursive: true });
  mkdirSync(join(workspaceHost, "work"), { recursive: true });
  mkdirSync(join(workspaceHost, "artifacts"), { recursive: true });

  const entries: InputManifestEntry[] = [];
  let total = 0;
  for (const f of files) {
    const fst = statSync(f.abs);
    if (!fst.isFile()) continue;
    if (fst.size > MAX_INPUT_FILE_BYTES) {
      throw invalidInput("input_too_large", `${f.rel} is ${fst.size} bytes (max ${MAX_INPUT_FILE_BYTES})`);
    }
    total += fst.size;
    if (total > MAX_INPUT_TOTAL_BYTES) {
      throw invalidInput("input_too_large", `input exceeds total cap of ${MAX_INPUT_TOTAL_BYTES} bytes`);
    }
    const dest = join(original, f.rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.abs, dest);
    const head = readHead(dest, 512);
    const format = sniffFormat(head, f.rel);
    entries.push({
      relative_path: f.rel.split(sep).join("/"),
      size: fst.size,
      sha256: sha256File(dest),
      format,
      executable: isExecutableFormat(format, head),
    });
  }
  entries.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const aggregate = createHash("sha256").update(entries.map((e) => `${e.relative_path}:${e.sha256}`).join("\n")).digest("hex");
  const manifest: InputManifest = {
    source_name: basename(src),
    entries,
    total_bytes: total,
    sha256: aggregate,
  };
  writeFileSync(join(inputRoot(workspaceHost), "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function collectFiles(root: string, dir: string, out: { abs: string; rel: string }[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      throw invalidInput("input_symlink", `refusing symlink in input: ${p}`);
    }
    if (st.isDirectory()) {
      collectFiles(root, p, out);
    } else if (st.isFile()) {
      out.push({ abs: p, rel: p.slice(root.length + 1) });
    }
  }
}

function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}
