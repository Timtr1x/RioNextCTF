import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachmentNameFromUrl, BROWSER_UA, fetchAttachment, type AttachmentFetchFn } from "../../src/domain/attachment-fetch.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-fetch-"));
}

function fakeFetch(res: Response, seen?: { url?: string; ua?: string }): AttachmentFetchFn {
  return async (url, init) => {
    if (seen) {
      seen.url = url;
      seen.ua = new Headers(init?.headers).get("user-agent") ?? "";
    }
    return res;
  };
}

test("fetchAttachment downloads with the browser UA and hashes the file", async () => {
  const seen: { url?: string; ua?: string } = {};
  const got = await fetchAttachment("https://ctf.example/files/task.zip?token=abc", tmp(), {
    fetchFn: fakeFetch(new Response("hello"), seen),
  });
  assert.equal(got.name, "task.zip");
  assert.equal(got.bytes, 5);
  assert.equal(got.sha256, createHash("sha256").update("hello").digest("hex"));
  assert.equal(readFileSync(got.path, "utf8"), "hello");
  assert.equal(seen.ua, BROWSER_UA);
});

test("attachmentNameFromUrl sanitizes and falls back to attachment.bin", () => {
  assert.equal(attachmentNameFromUrl("https://x.test/a/hello%20world.zip"), "hello_world.zip");
  assert.ok(attachmentNameFromUrl("https://x.test/a/%E9%A2%98%E7%9B%AE%20v2.tar.gz").endsWith("v2.tar.gz"));
  assert.equal(attachmentNameFromUrl("https://x.test/"), "attachment.bin");
  assert.equal(attachmentNameFromUrl("not a url"), "attachment.bin");
});

test("fetchAttachment rejects non-http schemes and error statuses", async () => {
  await assert.rejects(
    () => fetchAttachment("file:///etc/passwd", tmp(), { fetchFn: fakeFetch(new Response("x")) }),
    /only http\(s\)/,
  );
  await assert.rejects(
    () => fetchAttachment("ftp://x.test/t.zip", tmp(), { fetchFn: fakeFetch(new Response("x")) }),
    /only http\(s\)/,
  );
  await assert.rejects(
    () => fetchAttachment("https://x.test/t.zip", tmp(), { fetchFn: fakeFetch(new Response("nope", { status: 404 })) }),
    /HTTP 404/,
  );
  // The fake must never even be called for a bad scheme.
  let called = false;
  await assert.rejects(() =>
    fetchAttachment("gopher://x.test/", tmp(), {
      fetchFn: async () => {
        called = true;
        return new Response("x");
      },
    }),
  );
  assert.equal(called, false);
});

test("fetchAttachment enforces the size cap from headers and from the stream", async () => {
  await assert.rejects(
    () =>
      fetchAttachment("https://x.test/big.bin", tmp(), {
        maxBytes: 10,
        fetchFn: fakeFetch(new Response("ok", { headers: { "content-length": "999" } })),
      }),
    /exceeds cap/,
  );
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(8));
      c.enqueue(new Uint8Array(8));
      c.close();
    },
  });
  await assert.rejects(
    () => fetchAttachment("https://x.test/big.bin", tmp(), { maxBytes: 10, fetchFn: fakeFetch(new Response(stream)) }),
    /exceeds cap/,
  );
});

test("fetchAttachment rejects an empty body", async () => {
  await assert.rejects(
    () => fetchAttachment("https://x.test/t.zip", tmp(), { fetchFn: fakeFetch(new Response(null)) }),
    /empty body/,
  );
});
