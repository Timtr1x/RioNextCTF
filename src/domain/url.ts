/**
 * Shared http(s) URL validation/normalization. Extracted from quick-spec so
 * spec.ts can validate challenge.web_url without importing quick-spec (which
 * itself imports spec.ts for the budget defaults — a cycle).
 */
import { invalidInput } from "./errors.ts";

export function looksLikeHttpUrl(raw: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(raw);
}

/** Accepts http(s) only; rejects ftp:, javascript:, blank and unparseable input. */
export function parseHttpUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw invalidInput("invalid_url", "target URL is required");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalidInput("invalid_url", `not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidInput("invalid_url", "URL must be http or https");
  }
  if (!url.hostname) {
    throw invalidInput("invalid_url", "URL must include a hostname");
  }
  return url;
}
