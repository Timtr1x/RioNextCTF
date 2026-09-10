import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadPrompt } from "../../src/context/builder.ts";
import { KALI_FLAG_TOOLS } from "../../src/domain/quick-spec.ts";
import { KALI_BINARIES } from "../../src/tools/kali-profile.ts";
import {
  KALI_RUN_DESCRIPTION,
  KALI_RUN_PARAMETERS,
  KALI_WRITE_DESCRIPTION,
  KALI_WRITE_PARAMETERS,
  PLAYWRIGHT_DESCRIPTION,
  PLAYWRIGHT_PARAMETERS,
} from "../../src/tools/kali-schemas.ts";

/**
 * Web zero-regression golden. Locks the three things a Web campaign's model
 * can see, byte for byte: the execute system prompt, the kali tool schemas,
 * and the binary allowlist. If a change here is intentional (a real web
 * contract change), update the constants in the same commit and say why in
 * the commit message. CTF work must not touch these values.
 */
const GOLDEN = {
  execute_prompt_sha256: "e015c3d0b91ed313221b8cb6740889d594059c2e6b1195b51d770a40a26e07f5",
  kali_tool_schema_sha256: "980846d077eb8408c42fc52387f0bf6a49441b21e7f668a46bdb7f62fb0ac074",
  web_binaries_sha256: "ba521f7738b958b8893ecbe80c2d205b4bba36604d568353bba709391ec1694b",
  web_tool_allowlist_sha256: "adf8cd7680b0c82cf96e7b61c4a10f060bd3e4848c0d016bea911d8a9f7ca25c",
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("web golden: execute system prompt is unchanged", () => {
  assert.equal(sha256(loadPrompt("execute")), GOLDEN.execute_prompt_sha256);
});

test("web golden: kali tool schemas are unchanged", () => {
  const bundle = JSON.stringify({
    kali_run: { description: KALI_RUN_DESCRIPTION, parameters: KALI_RUN_PARAMETERS },
    kali_write: { description: KALI_WRITE_DESCRIPTION, parameters: KALI_WRITE_PARAMETERS },
    playwright: { description: PLAYWRIGHT_DESCRIPTION, parameters: PLAYWRIGHT_PARAMETERS },
  });
  assert.equal(sha256(bundle), GOLDEN.kali_tool_schema_sha256);
});

test("web golden: binary allowlist and tool allowlist are unchanged", () => {
  assert.equal(sha256(JSON.stringify([...KALI_BINARIES].sort())), GOLDEN.web_binaries_sha256);
  assert.equal(sha256(JSON.stringify([...KALI_FLAG_TOOLS])), GOLDEN.web_tool_allowlist_sha256);
});
