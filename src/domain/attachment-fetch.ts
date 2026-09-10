import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Chrome UA: challenge CDNs and the contest platform sit behind WAFs that 403 curl's default UA. */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export type AttachmentFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchedAttachment {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

/** File name for a downloaded attachment: last URL path segment, sanitized. */
export function attachmentNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
    return clean || "attachment.bin";
  } catch {
    return "attachment.bin";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Host-side attachment download. The server/CLI fetches, never the Kali
 * container: secrets stay on the host and the sandbox never talks to
 * challenge CDNs. Throws on non-2xx, non-http(s) scheme, oversize body,
 * empty body, or timeout.
 */
export async function fetchAttachment(
  url: string,
  destDir: string,
  opts?: {
    fetchFn?: AttachmentFetchFn;
    timeoutMs?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
  },
): Promise<FetchedAttachment> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`attachment download failed: bad url ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`attachment download failed: only http(s) urls are allowed, got ${parsed.protocol}//`);
  }
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchFn = opts?.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { "user-agent": BROWSER_UA, ...opts?.headers },
    });
    if (!res.ok) throw new Error(`attachment download failed: HTTP ${res.status}`);
    const buf = await readCapped(res, maxBytes);
    if (buf.length === 0) throw new Error("attachment download failed: empty body");
    mkdirSync(destDir, { recursive: true });
    const name = attachmentNameFromUrl(url);
    const dest = join(destDir, name);
    writeFileSync(dest, buf);
    return { name, path: dest, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  } finally {
    clearTimeout(timer);
  }
}

/** Buffer a response body with a hard cap; Content-Length alone is not trusted. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > maxBytes) {
    throw new Error(`attachment download failed: ${len}b exceeds cap of ${maxBytes}b`);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`attachment download failed: body exceeds cap of ${maxBytes}b`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`attachment download failed: body exceeds cap of ${maxBytes}b`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
