import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDemoSpec } from "../../src/eval/helpers.ts";
import { startUiServer, type UiServer } from "../../src/web/server.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-webapi-"));
}

function elf64(): Buffer {
  const b = Buffer.alloc(256);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = 2;
  b[5] = 1;
  b.writeUInt16LE(3, 16);
  b.writeUInt16LE(0x3e, 18);
  return b;
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 15_000, step = 100): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

test("rionext ui api end to end", async (t) => {
  const dir = tmp();
  const ui: UiServer = await startUiServer({ dataDir: dir, port: 0, serveStatic: false, maxCycles: 2 });
  t.after(async () => {
    await ui.close();
  });

  const api = async (path: string, init?: { method?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> }) => {
    const res = await fetch(`${ui.url}${path}`, {
      method: init?.method ?? (init?.body !== undefined || init?.raw ? "POST" : "GET"),
      headers: init?.headers ?? (init?.body !== undefined ? { "content-type": "application/json" } : {}),
      body: init?.raw ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as Record<string, unknown> };
  };

  let providerId = "";
  let modelId = "";

  await t.test("health and config", async () => {
    const health = await api("/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.data_dir, dir);
    const config = await api("/api/config");
    assert.equal(config.status, 200);
    assert.equal((config.body.limits as Record<string, unknown>).max_execute_turns_per_run, 72);
    assert.ok(Array.isArray(config.body.controller_locks));
  });

  await t.test("provider catalog roundtrip without leaking keys", async () => {
    const prv = await api("/api/providers", {
      body: {
        display_name: "Test Provider",
        protocol: "OPENAI_CHAT_COMPLETIONS",
        // Connection-refused on a dead local port fails in milliseconds. A name
        // like example.invalid hangs on a 10s connect timeout instead, and the
        // engine's model retries multiply that against this suite's budgets.
        base_url: "http://127.0.0.1:1/v1/chat/completions",
        api_key: "sk-secret-test",
      },
    });
    assert.equal(prv.status, 200);
    providerId = String(prv.body.id);
    assert.ok(providerId.startsWith("prv_"));
    assert.equal(JSON.stringify(prv.body).includes("sk-secret-test"), false);

    const mdl = await api("/api/models", { body: { provider_id: providerId, name: "deepseek-chat", context_window: 100000 } });
    assert.equal(mdl.status, 200);
    modelId = String(mdl.body.id);
    assert.ok(modelId.startsWith("mdl_"));

    const slot = await api("/api/slots", { body: { slot: "solver", ref: modelId } });
    assert.equal(slot.status, 200);

    const catalog = await api("/api/catalog");
    assert.equal(catalog.status, 200);
    const providers = catalog.body.providers as Record<string, unknown>[];
    assert.equal(providers.length, 1);
    assert.equal(providers[0]!.api_key_set, true);
    assert.equal(JSON.stringify(catalog.body).includes("sk-secret-test"), false);

    const renamed = await api(`/api/providers/${providerId}`, { method: "PATCH", body: { display_name: "Renamed" } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.display_name, "Renamed");
    assert.equal(renamed.body.api_key_set, true);

    const cleared = await api(`/api/providers/${providerId}/key`, { body: { clear: true } });
    assert.equal(cleared.status, 200);
    const after = await api("/api/catalog");
    assert.equal((after.body.providers as Record<string, unknown>[])[0]!.api_key_set, false);
    await api(`/api/providers/${providerId}/key`, { body: { api_key: "sk-secret-test-2" } });
  });

  await t.test("campaign create via url, inspect, duplicate handling", async () => {
    const created = await api("/api/campaigns", { body: { url: "http://authorized-target.example/" } });
    assert.equal(created.status, 200);
    assert.equal(created.body.created, true);
    assert.equal(created.body.started, false);
    const id = String(created.body.id);
    assert.ok(id.startsWith("camp_"));

    const list = await api("/api/campaigns");
    const row = (list.body.campaigns as Record<string, unknown>[]).find((c) => c.id === id)!;
    assert.ok(row);
    assert.equal(row.running, false);
    assert.equal((row.spec as Record<string, unknown>).mode, "goal_seeking");

    const view = await api(`/api/campaigns/${id}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.state, "created");
    assert.ok(view.body.budget);

    const dupe = await api("/api/campaigns", { body: { url: "http://authorized-target.example/" } });
    assert.equal(dupe.status, 409);
    assert.equal((dupe.body.error as Record<string, unknown>).code, "campaign_exists");

    const hint = await api(`/api/campaigns/${id}/hint`, { body: { text: "check the robots.txt" } });
    assert.equal(hint.status, 200);
    assert.equal(typeof hint.body.epoch, "number");

    const budget = await api(`/api/campaigns/${id}/budget`, { body: { max_calls: 42 } });
    assert.equal(budget.status, 200);

    const events = await api(`/api/campaigns/${id}/events`);
    assert.equal(events.status, 200);
    const rows = events.body.events as Record<string, unknown>[];
    assert.ok(rows.length >= 2);
    const seqs = rows.map((r) => Number(r.seq));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    const head = Number(events.body.head);
    const incremental = await api(`/api/campaigns/${id}/events?after=${head}`);
    assert.equal((incremental.body.events as unknown[]).length, 0);

    const bad = await api(`/api/campaigns/${id}/list/bogus_table`);
    assert.equal(bad.status, 400);

    const steps = await api(`/api/campaigns/${id}/list/steps`);
    assert.equal(steps.status, 200);
    assert.ok(Array.isArray(steps.body.rows));

    const report = await api(`/api/campaigns/${id}/report`);
    assert.equal(report.status, 200);
    assert.ok(report.body.report);
  });

  await t.test("start runs inside the ui process and cancel settles it", async () => {
    const spec = loadDemoSpec("camp_api_run");
    const created = await api("/api/campaigns", { body: { spec, start: true } });
    assert.equal(created.status, 200);
    assert.equal(created.body.started, true);
    assert.equal(ui.host.running("camp_api_run") !== undefined, true);

    const dupeStart = await api("/api/campaigns/camp_api_run/start", { body: {} });
    assert.equal(dupeStart.status, 409);
    assert.equal((dupeStart.body.error as Record<string, unknown>).code, "already_running");

    const cancel = await api("/api/campaigns/camp_api_run/cancel", { body: {} });
    assert.equal(cancel.status, 200);
    await waitFor(() => ui.host.running("camp_api_run") === undefined);
    const view = await api("/api/campaigns/camp_api_run");
    assert.equal(view.body.state, "cancelled");
  });

  await t.test("foreign live controller lock blocks start with owner in details", async () => {
    const spec = loadDemoSpec("camp_api_lock");
    await api("/api/campaigns", { body: { spec } });
    ui.host.control.storage.acquireControllerLock("camp_api_lock", "other-proc", 60_000);
    const res = await api("/api/campaigns/camp_api_lock/start", { body: {} });
    assert.equal(res.status, 409);
    const err = res.body.error as Record<string, unknown>;
    assert.equal(err.code, "controller_lock_held");
    assert.equal((err.details as Record<string, unknown>).owner, "other-proc");
    ui.host.control.storage.store.db.prepare("DELETE FROM controller_locks WHERE campaign_id = ?").run("camp_api_lock");
  });

  await t.test("upload, triage preview, then create input campaign with seed step", async () => {
    const up = await api("/api/uploads", {
      raw: elf64(),
      headers: { "x-file-name": "crackme.elf", "x-upload-label": "crackme" },
    });
    assert.equal(up.status, 200);
    const uploadId = String(up.body.upload_id);
    assert.equal(up.body.files, 1);

    const tri = await api("/api/triage", { body: { upload_id: uploadId, label: "crackme" } });
    assert.equal(tri.status, 200);
    assert.equal((tri.body.triage as Record<string, unknown>).kind, "reverse");
    const campId = String(tri.body.campaign_id);
    assert.ok(campId.startsWith("camp_crackme-"));

    const created = await api("/api/campaigns", { body: { upload_id: uploadId, id: campId } });
    assert.equal(created.status, 200);
    assert.equal(created.body.created, true);

    const steps = await api(`/api/campaigns/${campId}/list/steps`);
    assert.equal((steps.body.rows as unknown[]).length, 1);
    const view = await api(`/api/campaigns/${campId}`);
    assert.equal(((view.body.spec as Record<string, unknown>).challenge as Record<string, unknown>).kind, "reverse");

    const emptyTriage = await api("/api/triage", { body: {} });
    assert.equal(emptyTriage.status, 400);
  });

  await t.test("input campaign with web_url persists it and reports ctf+web capabilities", async () => {
    const up = await api("/api/uploads", {
      raw: elf64(),
      headers: { "x-file-name": "app.elf", "x-upload-label": "mixedapp" },
    });
    assert.equal(up.status, 200);
    const uploadId = String(up.body.upload_id);

    const created = await api("/api/campaigns", {
      body: { upload_id: uploadId, id: "camp_api_mixed", web_url: "http://web.example:8080/" },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.created, true);

    const view = await api("/api/campaigns/camp_api_mixed");
    const spec = view.body.spec as Record<string, unknown>;
    const challenge = spec.challenge as Record<string, unknown>;
    assert.equal(challenge.web_url, "http://web.example:8080/");
    assert.deepEqual(spec.capabilities, ["ctf", "web"]);

    const bad = await api("/api/campaigns", {
      body: { upload_id: uploadId, id: "camp_api_bad_mixed", web_url: "ftp://web.example/" },
    });
    assert.equal(bad.status, 400);
  });

  await t.test("uploads/fetch downloads a remote attachment, then triage and create work", async () => {
    const payload = elf64();
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(payload);
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      srv.close();
    });
    const port = (srv.address() as { port: number }).port;

    const got = await api("/api/uploads/fetch", {
      body: { url: `http://127.0.0.1:${port}/files/crackme.elf`, label: "crackme" },
    });
    assert.equal(got.status, 200);
    assert.equal(got.body.stored, "crackme.elf");
    assert.equal(got.body.bytes, payload.length);
    const uploadId = String(got.body.upload_id);

    const tri = await api("/api/triage", { body: { upload_id: uploadId, label: "crackme" } });
    assert.equal(tri.status, 200);
    assert.equal((tri.body.triage as Record<string, unknown>).kind, "reverse");

    const campId = String(tri.body.campaign_id);
    const created = await api("/api/campaigns", { body: { upload_id: uploadId, id: campId } });
    assert.equal(created.status, 200);
    assert.equal(created.body.created, true);

    const bad = await api("/api/uploads/fetch", { body: { url: "file:///etc/passwd" } });
    assert.equal(bad.status, 400);
    assert.equal((bad.body.error as Record<string, unknown>).code, "fetch_failed");

    const missing = await api("/api/uploads/fetch", { body: {} });
    assert.equal(missing.status, 400);
    assert.equal((missing.body.error as Record<string, unknown>).code, "missing_url");
  });

  await t.test("flag human review: reject writes reason, accept closes the campaign", async () => {
    const spec = loadDemoSpec("camp_api_goal");
    spec.root_goal = { ...spec.root_goal, success_predicate_ref: "flag_recovered" };
    await api("/api/campaigns", { body: { spec } });
    const e = ui.host.control;
    e.storage.setCampaignState("camp_api_goal", "active", { kind: "user", id: "t" });
    const run = e.storage.claimDecide("camp_api_goal", "t")!;
    const obs = e.storage.recordObservation({
      campaign_id: "camp_api_goal",
      producer_id: "p",
      submission_id: "o1",
      run_id: run.run_id,
      attempt_id: run.run_id,
      subject: "http-body",
      body: { text: "CTF2{fake}" },
      artifact_refs: [],
      conditions: {},
      env_rev: "env-1",
    });
    const submitFlag = (submission: string, flag: string): void => {
      e.storage.submitFact({
        campaign_id: "camp_api_goal",
        producer_id: "p",
        submission_id: submission,
        run_id: run.run_id,
        proposition: flag,
        fact_key: "flag_recovered",
        support_refs: [obs.canonical_ids.observation_id!],
        conditions: {},
        source_grade: "observed",
      });
    };
    submitFlag("f1", "CTF2{fake}");
    e.storage.finishRun("camp_api_goal", run.run_id, {
      run_id: run.run_id,
      step_id: null,
      mode: "decide",
      reason: "resolved",
      summary: "submitted candidate",
      observation_ids: [],
      fact_ids: [String(e.storage.list("facts", "camp_api_goal")[0]!.id)],
      finding_ids: [],
      blocked_on: null,
      reopen_rule: null,
      finish_requested: true,
      protocol_error: null,
    });
    await e.runLoop("camp_api_goal");
    assert.equal(e.storage.getCampaign("camp_api_goal").state, "awaiting_verify");

    const rejected = await api("/api/campaigns/camp_api_goal/verify", { body: { accept: false, text: "flag不正确" } });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.state, "active");

    submitFlag("f2", "CTF2{real}");
    await e.runLoop("camp_api_goal");
    const accepted = await api("/api/campaigns/camp_api_goal/verify", { body: { accept: true } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.state, "completed");

    const noClaim = await api("/api/campaigns/camp_api_goal/verify", { body: { accept: true } });
    assert.equal(noClaim.status, 400);
    assert.equal((noClaim.body.error as Record<string, unknown>).code, "no_goal_claim");
  });

  await t.test("artifact content, reconcile, backup, tasks, 404 shape", async () => {
    const art = await ui.host.control.storage.putArtifact("camp_api_goal", "hello artifact", "text/plain", "t");
    const content = await api(`/api/campaigns/camp_api_goal/artifacts/${art.id}/content`);
    assert.equal(content.status, 200);
    assert.equal(content.body.text, "hello artifact");
    assert.equal(content.body.has_more, false);

    const rec = await api("/api/campaigns/camp_api_goal/reconcile", { body: {} });
    assert.equal(rec.status, 200);
    assert.equal(typeof (rec.body as Record<string, unknown>).marked_uncertain, "number");

    const backup = await api("/api/backup", { body: {} });
    assert.equal(backup.status, 200);
    assert.ok(String(backup.body.dest_dir).includes("backups"));

    const tasks = await api("/api/tasks");
    assert.equal(tasks.status, 200);
    assert.ok(Array.isArray(tasks.body.tasks));

    const missing = await api("/api/definitely-not-a-route");
    assert.equal(missing.status, 404);
    assert.equal((missing.body.error as Record<string, unknown>).code, "not_found");
  });
});
