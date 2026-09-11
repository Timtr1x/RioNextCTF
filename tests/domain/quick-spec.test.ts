import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../../src/domain/errors.ts";
import {
  buildKaliFlagSpec,
  campaignIdForTarget,
  looksLikeHttpUrl,
  parseTargetUrl,
} from "../../src/domain/quick-spec.ts";
import { validateCampaignSpec } from "../../src/domain/spec.ts";

test("looksLikeHttpUrl and parseTargetUrl accept http(s) only", () => {
  assert.equal(looksLikeHttpUrl("http://lab.example/"), true);
  assert.equal(looksLikeHttpUrl("https://lab.example/x"), true);
  assert.equal(looksLikeHttpUrl("ftp://lab.example/"), false);
  assert.equal(parseTargetUrl("http://lab.example/path").hostname, "lab.example");
  assert.throws(() => parseTargetUrl("not-a-url"), DomainError);
  assert.throws(() => parseTargetUrl("javascript:alert(1)"), DomainError);
});

test("campaignIdForTarget uses instance label or host slug", () => {
  const das = parseTargetUrl("http://cd60aefe0490ac8ad594d643.http-ctf2.dasctf.com/");
  assert.equal(campaignIdForTarget(das), "camp_cd60aefe0490ac8ad594d643");
  const plain = parseTargetUrl("https://lab.internal/");
  assert.equal(campaignIdForTarget(plain), "camp_lab-internal");
  const withPath = parseTargetUrl("http://lab.internal/app");
  assert.match(campaignIdForTarget(withPath), /^camp_lab-internal-[a-f0-9]{6}$/);
});

test("buildKaliFlagSpec is a valid kali flag campaign using the solver model", () => {
  const spec = buildKaliFlagSpec({
    url: "http://cd60aefe0490ac8ad594d643.http-ctf2.dasctf.com/",
    provider: "prv_9b5fe4be-bc55-44c6-992b-9afc9ca04d6f",
    model: "deepseek-chat",
  });
  const parsed = validateCampaignSpec(spec);
  assert.equal(parsed.campaign_id, "camp_cd60aefe0490ac8ad594d643");
  assert.equal(parsed.mode, "goal_seeking");
  assert.equal(parsed.execution_profile, "kali");
  assert.equal(parsed.root_goal.success_predicate_ref, "flag_recovered");
  assert.ok(parsed.scope.assets.includes("cd60aefe0490ac8ad594d643.http-ctf2.dasctf.com"));
  assert.ok(parsed.tool_allowlist.includes("kali_run"));
  assert.equal(parsed.model_policy.provider, "prv_9b5fe4be-bc55-44c6-992b-9afc9ca04d6f");
  assert.equal(parsed.model_policy.model, "deepseek-chat");
  assert.equal(parsed.model_policy.thinking_level, "max");
  assert.equal(parsed.budget.max_calls, 3000);
  assert.equal(parsed.budget.max_tokens, 80_000_000);
});
