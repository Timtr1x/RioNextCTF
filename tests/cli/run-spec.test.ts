import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pickRunSource, specFromUrl } from "../../src/cli/run-spec.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";

test("pickRunSource prefers URL, rejects --url with --spec", () => {
  assert.deepEqual(pickRunSource({ url: "http://lab.example/" }, []), { kind: "url", url: "http://lab.example/" });
  assert.deepEqual(pickRunSource({}, ["http://lab.example/"]), { kind: "url", url: "http://lab.example/" });
  assert.deepEqual(pickRunSource({ spec: "x.json" }, []), { kind: "spec", path: "x.json" });
  assert.throws(
    () => pickRunSource({ url: "http://lab.example/", spec: "x.json" }, []),
    (e: unknown) => e instanceof DomainError && e.code === "run_source_conflict",
  );
  assert.throws(
    () => pickRunSource({}, []),
    (e: unknown) => e instanceof DomainError && e.code === "missing_run_source",
  );
});

test("pickRunSource accepts --input-url and keeps it exclusive", () => {
  assert.deepEqual(pickRunSource({ "input-url": "https://x.test/files/t.zip" }, []), {
    kind: "input-url",
    url: "https://x.test/files/t.zip",
    challengeKind: undefined,
    endpoint: undefined,
    hint: undefined,
  });
  const withKind = pickRunSource({ "input-url": "https://x.test/t.zip", kind: "misc" }, []);
  assert.equal(withKind.kind, "input-url");
  if (withKind.kind === "input-url") assert.equal(withKind.challengeKind, "misc");
  const conflicts: Record<string, string | boolean>[] = [
    { "input-url": "https://x.test/t.zip", input: "./local" },
    { "input-url": "https://x.test/t.zip", url: "http://lab.example/" },
    { "input-url": "https://x.test/t.zip", spec: "x.json" },
  ];
  for (const flags of conflicts) {
    assert.throws(
      () => pickRunSource(flags, []),
      (e: unknown) => e instanceof DomainError && e.code === "run_source_conflict",
    );
  }
  assert.throws(
    () => pickRunSource({ "input-url": true }, []),
    (e: unknown) => e instanceof DomainError && e.code === "invalid_input_url",
  );
  assert.throws(
    () => pickRunSource({ url: "http://lab.example/", kind: "misc" }, []),
    (e: unknown) => e instanceof DomainError && e.code === "kind_without_input",
  );
});

test("specFromUrl fills kali flag spec from the solver slot", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-quick-"));
  const cat = new ProviderCatalog(dir);
  const provider = cat.addProvider({
    display_name: "test",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://example.invalid/v1/chat/completions",
    api_key: "sk-test",
  });
  const model = cat.addModel({ provider_id: provider.id, name: "deepseek-chat" });
  cat.assignSlot("solver", model.id);
  const spec = specFromUrl("http://target.example/", dir);
  assert.equal(spec.campaign_id, "camp_target-example");
  assert.equal(spec.model_policy.provider, provider.id);
  assert.equal(spec.model_policy.model, "deepseek-chat");
  assert.equal(spec.execution_profile, "kali");
});
