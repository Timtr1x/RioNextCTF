import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasManagerSlot, parseManagerAdvice } from "../../src/contest/manager.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";

test("parseManagerAdvice reads the JSON block and maps next_action", () => {
  const a = parseManagerAdvice(
    `看起来是格式问题。\n{"diagnosis":"format","do_not_resubmit":["abc","def"],"next_action":"try_format_wrap","hint":"试试 flag{} 包装"}`,
  );
  assert.equal(a.hint, "试试 flag{} 包装");
  assert.equal(a.nextAction, "continue");
  assert.deepEqual(a.doNotResubmit, ["abc", "def"]);
  assert.equal(a.diagnosis, "format");

  assert.equal(parseManagerAdvice(`{"next_action":"reset_container","hint":"环境脏了"}`).nextAction, "reset_container");
  assert.equal(parseManagerAdvice(`{"next_action":"give_up_slot","hint":"放弃"}`).nextAction, "give_up");
});

test("parseManagerAdvice falls back to raw text when JSON is missing/broken", () => {
  const a = parseManagerAdvice("just prose advice, no json");
  assert.equal(a.hint, "just prose advice, no json");
  assert.equal(a.nextAction, "continue");
  const b = parseManagerAdvice("{broken json");
  assert.equal(b.hint, "{broken json");
});

test("hasManagerSlot requires an explicit manager assignment (no solver fallback)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-mgr-"));
  const cat = new ProviderCatalog(dir);
  const provider = cat.addProvider({
    display_name: "test",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://example.invalid/v1/chat/completions",
    api_key: "sk-test",
  });
  const model = cat.addModel({ provider_id: provider.id, name: "deepseek-chat" });
  cat.assignSlot("solver", model.id);
  assert.equal(hasManagerSlot(cat), false, "solver assigned but no manager slot");
  cat.assignSlot("manager", model.id);
  assert.equal(hasManagerSlot(cat), true);
});
