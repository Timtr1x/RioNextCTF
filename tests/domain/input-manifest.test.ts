import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../../src/domain/errors.ts";
import { readInputManifest, sha256File, sniffFormat, stageInput } from "../../src/domain/input-manifest.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-input-"));
}

test("single file stages with matching sha256 and layout", () => {
  const dir = tmp();
  const src = join(dir, "note.txt");
  writeFileSync(src, "hello ctf");
  const ws = join(dir, "ws");
  const manifest = stageInput(src, ws);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0]!.relative_path, "note.txt");
  assert.equal(manifest.entries[0]!.sha256, sha256File(src));
  assert.equal(manifest.entries[0]!.format, "text");
  assert.equal(manifest.entries[0]!.executable, false);
  assert.ok(existsSync(join(ws, "input", "original", "note.txt")));
  assert.ok(existsSync(join(ws, "input", "manifest.json")));
  assert.ok(existsSync(join(ws, "work")));
  assert.ok(existsSync(join(ws, "artifacts")));
  // source untouched
  assert.equal(readFileSync(src, "utf8"), "hello ctf");
  // manifest round-trips
  const reread = readInputManifest(ws);
  assert.equal(reread?.sha256, manifest.sha256);
  assert.equal(reread?.source_name, "note.txt");
});

test("directory hierarchy is preserved with forward-slash relative paths", () => {
  const dir = tmp();
  const src = join(dir, "chal");
  mkdirSync(join(src, "sub"), { recursive: true });
  writeFileSync(join(src, "a.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]));
  writeFileSync(join(src, "sub", "b.txt"), "hint");
  const ws = join(dir, "ws");
  const manifest = stageInput(src, ws);
  const paths = manifest.entries.map((e) => e.relative_path).sort();
  assert.deepEqual(paths, ["a.bin", "sub/b.txt"]);
  const elf = manifest.entries.find((e) => e.relative_path === "a.bin")!;
  assert.equal(elf.format, "elf");
  assert.equal(elf.executable, true);
  assert.equal(manifest.source_name, "chal");
});

test("missing input and empty directory fail before staging", () => {
  const dir = tmp();
  assert.throws(
    () => stageInput(join(dir, "nope"), join(dir, "ws")),
    (e: unknown) => e instanceof DomainError && e.code === "input_missing",
  );
  mkdirSync(join(dir, "empty"));
  assert.throws(
    () => stageInput(join(dir, "empty"), join(dir, "ws")),
    (e: unknown) => e instanceof DomainError && e.code === "input_empty",
  );
});

test("symlink inputs are refused", (t) => {
  const dir = tmp();
  const real = join(dir, "real.txt");
  writeFileSync(real, "data");
  const link = join(dir, "link.txt");
  try {
    symlinkSync(real, link);
  } catch {
    t.skip("symlink creation not permitted on this host");
    return;
  }
  assert.throws(
    () => stageInput(link, join(dir, "ws")),
    (e: unknown) => e instanceof DomainError && e.code === "input_symlink",
  );
});

test("sniffFormat covers the routed magics", () => {
  assert.equal(sniffFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), "x"), "elf");
  assert.equal(sniffFormat(Buffer.from([0x4d, 0x5a, 0, 0]), "x.exe"), "pe");
  assert.equal(sniffFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04]), "x.zip"), "zip");
  assert.equal(sniffFormat(Buffer.from([0xd4, 0xc3, 0xb2, 0xa1]), "x.pcap"), "pcap");
  assert.equal(sniffFormat(Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]), "x.pcap"), "pcap");
  assert.equal(sniffFormat(Buffer.from([0x0a, 0x0d, 0x0d, 0x0a]), "x.pcapng"), "pcapng");
  assert.equal(sniffFormat(Buffer.from("%PDF-1.7\n", "utf8"), "x.pdf"), "pdf");
  assert.equal(sniffFormat(Buffer.from("just some text\n", "utf8"), "x.txt"), "text");
  assert.equal(sniffFormat(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), "x.bin"), "data");
});
