import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startUiServer } from "../../src/web/server.ts";

test("static serving: assets, SPA fallback, mime, and placeholder without a build", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "rn-webstatic-data-"));
  const webRoot = mkdtempSync(join(tmpdir(), "rn-webstatic-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>rionext</title><div id=root></div>");
  writeFileSync(join(webRoot, "app.js"), "console.log('hi')");

  const ui = await startUiServer({ dataDir, port: 0, webRoot });
  t.after(async () => {
    await ui.close();
  });

  const root = await fetch(`${ui.url}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await root.text(), /id=root/);

  const js = await fetch(`${ui.url}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);

  const spa = await fetch(`${ui.url}/campaign/camp_whatever/graph`);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /id=root/);

  const api404 = await fetch(`${ui.url}/api/nope`);
  assert.equal(api404.status, 404);
  await api404.text();

  await ui.close();

  // Without a web build the server still answers with the placeholder page.
  const bare = await startUiServer({ dataDir, port: 0, webRoot: join(webRoot, "does-not-exist") });
  t.after(async () => {
    await bare.close();
  });
  const placeholder = await fetch(`${bare.url}/`);
  assert.equal(placeholder.status, 200);
  assert.match(await placeholder.text(), /web:build/);
});
