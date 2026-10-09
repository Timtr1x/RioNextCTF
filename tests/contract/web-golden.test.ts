import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { composeSystemPrompt, loadPrompt } from "../../src/context/builder.ts";
import { buildKaliFlagSpec } from "../../src/domain/quick-spec.ts";
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
 * Web zero-regression golden. Locks the things a Web campaign's model can see:
 * the generic execute prompt, the composed prompt for a pure web flag campaign,
 * the kali tool schemas, and the binary allowlist. The 2026-10 prompt split
 * (generic base + ctf/web briefs + env index) intentionally changed the two
 * prompt hashes; tool schemas and binary sets did not change. If a change here
 * is intentional (a real web contract change), update the constants in the
 * same commit and say why in the commit message. CTF skill references must not
 * leak into the web composition.
 */
const GOLDEN = {
  execute_prompt_sha256: "109055c98fc24154d1c1d75870ee7843dcff73255afaeb64015ac7628897ec4f",
  web_execute_composed_sha256: "dc688aeb7f66b265dda6a1587e2d11d82f13a851b3c427b02a5966188b13f0c6",
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

test("web golden: composed prompt for a pure web flag campaign is stable and self-contained", () => {
  const spec = buildKaliFlagSpec({ url: "http://target.example/", provider: "prv_test", model: "m" });
  const composed = composeSystemPrompt("execute", spec);
  assert.equal(sha256(composed), GOLDEN.web_execute_composed_sha256);
  // the composition carries the flag semantics and the kali env index...
  assert.match(composed, /flag_recovered/);
  assert.match(composed, /kali_run/);
  // ...but no non-web CTF skill reference leaks in
  assert.ok(!composed.includes("逆向/利用"));
  assert.ok(!composed.includes("checksec"));
  assert.ok(!composed.includes("binwalk"));
});

test("web golden: a non-flag generic spec gets only the generic prompt", () => {
  const spec = buildKaliFlagSpec({ url: "http://target.example/", provider: "prv_test", model: "m" });
  const generic = {
    ...spec,
    root_goal: { statement: "answer a question", success_predicate_ref: "goal_observed" },
  };
  const composed = composeSystemPrompt("execute", generic);
  assert.ok(!composed.includes("flag_recovered"));
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
