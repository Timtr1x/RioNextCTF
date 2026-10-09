import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fetchAttachment, type FetchedAttachment } from "../domain/attachment-fetch.ts";
import { applyKindOverride, isChallengeKind, parseTcpEndpoint, type ChallengeKind } from "../domain/challenge-kind.ts";
import { classifyChallenge } from "../domain/challenge-triage.ts";
import { invalidInput } from "../domain/errors.ts";
import { MAX_INPUT_FILE_BYTES, MAX_INPUT_TOTAL_BYTES, originalRoot, stageInput } from "../domain/input-manifest.ts";
import { campaignIdForInput, parseTargetUrl } from "../domain/quick-spec.ts";
import { seedChallengeStep, specFromInput, specFromUrl, type RunSource } from "../cli/run-spec.ts";
import { resolveToolCapabilities } from "../tools/kali-profile.ts";
import type { CampaignSpec } from "../domain/types.ts";
import type { ApiContext, ApiHandler } from "./server.ts";
import type { EngineHost } from "./engine-host.ts";

type Add = (method: string, pattern: string, handler: ApiHandler) => void;

const ARTIFACT_READ_CAP = 256 * 1024;
const LIST_TABLES = new Set(["steps", "facts", "findings", "observations", "coverage_items", "task_runs", "invocations", "goals", "artifacts"]);

function specSummary(spec: CampaignSpec): Record<string, unknown> {
  const resolved = resolveToolCapabilities(spec);
  return {
    mode: spec.mode,
    statement: spec.root_goal?.statement ?? "",
    assets: spec.scope?.assets ?? [],
    challenge: spec.challenge ?? null,
    capabilities: resolved.capabilities,
    capabilities_reason: resolved.reason,
    budget: spec.budget ?? null,
    model: spec.model_policy ? { provider: spec.model_policy.provider, model: spec.model_policy.model } : null,
  };
}

function campaignView(host: EngineHost, id: string): Record<string, unknown> {
  const engine = host.control;
  const camp = engine.storage.getCampaign(id);
  const run = host.running(id);
  return {
    ...engine.status(id),
    running: run ? { instance_id: run.instanceId, started_at: run.startedAt } : null,
    spec: specSummary(camp.spec),
    created_at: camp.created_at,
    updated_at: camp.updated_at,
  };
}

interface CreateBody {
  url?: string;
  spec?: unknown;
  spec_path?: string;
  input_path?: string;
  upload_id?: string;
  label?: string;
  kind?: string;
  endpoint?: string;
  web_url?: string;
  hint?: string;
  id?: string;
  start?: boolean;
}

function uploadDir(dataDir: string, uploadId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uploadId)) throw invalidInput("invalid_upload_id", `bad upload id ${uploadId}`);
  return join(dataDir, "uploads", uploadId);
}

function uploadLabel(dataDir: string, uploadId: string): string | null {
  try {
    const text = readFileSync(join(uploadDir(dataDir, uploadId), "label.txt"), "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function resolveInputSource(ctx: ApiContext, body: CreateBody): Extract<RunSource, { kind: "input" }> & { id?: string } {
  const kindRaw = typeof body.kind === "string" && body.kind !== "" ? body.kind : undefined;
  let challengeKind: ChallengeKind | undefined;
  if (kindRaw) {
    if (!isChallengeKind(kindRaw)) {
      throw invalidInput("invalid_kind", `--kind must be one of auto|web|reverse|pwn|misc|crypto|generic, got ${kindRaw}`);
    }
    if (kindRaw === "web") throw invalidInput("invalid_kind", "kind web targets a live URL; use the url entry instead");
    if (kindRaw !== "auto") challengeKind = kindRaw;
  }
  const endpoint = body.endpoint ? parseTcpEndpoint(body.endpoint) : undefined;
  const webUrl = body.web_url && body.web_url.trim() ? parseTargetUrl(body.web_url).toString() : undefined;
  let path = typeof body.input_path === "string" && body.input_path !== "" ? body.input_path : "";
  if (body.upload_id) {
    path = join(uploadDir(ctx.dataDir, body.upload_id), "files");
  }
  if (!path) throw invalidInput("missing_input", "input_path or upload_id is required");
  return { kind: "input", path, challengeKind, endpoint, webUrl, hint: body.hint, id: body.id };
}

async function createCampaign(ctx: ApiContext): Promise<unknown> {
  const body = await ctx.json<CreateBody>();
  const entries = [body.url, body.spec, body.spec_path, body.input_path ?? body.upload_id].filter(
    (v) => v !== undefined && v !== "" && v !== null,
  );
  if (entries.length !== 1) {
    throw invalidInput("run_source_conflict", "pass exactly one of url | spec | spec_path | input_path|upload_id");
  }
  const engine = host(ctx).control;
  let loaded: { spec: unknown; seed?: { question: string; method_family: string; fingerprint: string } };
  if (typeof body.url === "string" && body.url !== "") {
    loaded = { spec: specFromUrl(body.url, ctx.dataDir, body.id) };
  } else if (body.spec !== undefined && body.spec !== null) {
    loaded = { spec: body.spec };
  } else if (typeof body.spec_path === "string" && body.spec_path !== "") {
    loaded = { spec: JSON.parse(readFileSync(resolve(body.spec_path), "utf8")) as unknown };
  } else {
    const source = resolveInputSource(ctx, body);
    loaded = specFromInput(source, ctx.dataDir, body.id);
  }

  const spec = loaded.spec as { campaign_id?: string };
  let created = false;
  try {
    engine.createCampaign(loaded.spec);
    created = true;
  } catch (err) {
    // `run` semantics: re-running the same target resumes the same campaign.
    const isExists = err instanceof Error && "code" in err && (err as { code?: string }).code === "campaign_exists";
    if (!(isExists && body.start === true)) throw err;
  }
  const id = typeof spec.campaign_id === "string" ? spec.campaign_id : "";
  if (!id) throw invalidInput("missing_campaign_id", "spec.campaign_id is required");
  if (created && loaded.seed) seedChallengeStep(engine.storage, id, loaded.seed);
  let started = false;
  if (body.start === true) {
    host(ctx).start(id);
    started = true;
  }
  return { id, created, state: engine.storage.getCampaign(id).state, started };
}

function host(ctx: ApiContext): EngineHost {
  return ctx.host;
}

function idOf(ctx: ApiContext): string {
  const id = ctx.params.id ?? "";
  if (!id) throw invalidInput("missing_campaign_id", "campaign id is required");
  return id;
}

async function uploadBody(ctx: ApiContext): Promise<unknown> {
  const name = ctx.headers["x-file-path"] ?? ctx.headers["x-file-name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw invalidInput("missing_file_name", "x-file-name (or x-file-path for nested entries) header is required");
  }
  const uploadIdRaw = ctx.headers["x-upload-id"];
  const uploadId =
    typeof uploadIdRaw === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(uploadIdRaw)
      ? uploadIdRaw
      : `up_${Math.random().toString(36).slice(2, 10)}`;
  const labelHeader = ctx.headers["x-upload-label"];
  const dir = uploadDir(ctx.dataDir, uploadId);
  const filesDir = join(dir, "files");
  // Strip drive letters, leading slashes and dot-dot from the entry name.
  const rel = name
    .replace(/^[a-zA-Z]:/, "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..")
    .join("/");
  if (!rel) throw invalidInput("invalid_file_name", `unusable file name ${name}`);
  const dest = join(filesDir, rel);
  if (!resolve(dest).startsWith(resolve(filesDir))) {
    throw invalidInput("invalid_file_name", `path escapes upload dir: ${name}`);
  }
  const body = await ctx.raw();
  if (body.length > MAX_INPUT_FILE_BYTES) {
    throw invalidInput("input_too_large", `${rel} is ${body.length} bytes (max ${MAX_INPUT_FILE_BYTES})`);
  }
  let total = body.length;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  try {
    walk(filesDir);
  } catch {
    // first upload into this id
  }
  if (total > MAX_INPUT_TOTAL_BYTES) {
    throw invalidInput("input_too_large", `upload exceeds total cap of ${MAX_INPUT_TOTAL_BYTES} bytes`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  if (typeof labelHeader === "string" && labelHeader.trim() !== "") {
    writeFileSync(join(dir, "label.txt"), labelHeader.trim().slice(0, 80), "utf8");
  }
  let files = 0;
  const count = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) count(p);
      else files += 1;
    }
  };
  count(filesDir);
  return { upload_id: uploadId, stored: rel, files, total_bytes: total };
}

/**
 * Download a remote attachment into an upload batch, so the wizard can take a
 * challenge link instead of a local file. Lands in the same uploads/<id>/files
 * layout as a browser upload, so triage and campaign creation run unchanged.
 */
async function fetchUploadBody(ctx: ApiContext): Promise<unknown> {
  const body = await ctx.json<{ url?: string; upload_id?: string; label?: string }>();
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) throw invalidInput("missing_url", "url is required");
  const uploadId =
    typeof body.upload_id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.upload_id)
      ? body.upload_id
      : `up_${Math.random().toString(36).slice(2, 10)}`;
  const dir = uploadDir(ctx.dataDir, uploadId);
  const filesDir = join(dir, "files");
  let got: FetchedAttachment;
  try {
    got = await fetchAttachment(url, filesDir, { maxBytes: MAX_INPUT_FILE_BYTES });
  } catch (err) {
    throw invalidInput("fetch_failed", err instanceof Error ? err.message : String(err));
  }
  let total = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  try {
    walk(filesDir);
  } catch {
    // first fetch into this id
  }
  if (total > MAX_INPUT_TOTAL_BYTES) {
    rmSync(got.path, { force: true });
    throw invalidInput("input_too_large", `upload exceeds total cap of ${MAX_INPUT_TOTAL_BYTES} bytes`);
  }
  if (typeof body.label === "string" && body.label.trim() !== "") {
    writeFileSync(join(dir, "label.txt"), body.label.trim().slice(0, 80), "utf8");
  }
  let files = 0;
  const count = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) count(p);
      else files += 1;
    }
  };
  count(filesDir);
  return { upload_id: uploadId, stored: got.name, files, total_bytes: total, bytes: got.bytes, sha256: got.sha256 };
}

async function triageBody(ctx: ApiContext): Promise<unknown> {
  const body = await ctx.json<{ upload_id?: string; input_path?: string; label?: string; kind?: string; endpoint?: string; web_url?: string; hint?: string }>();
  const source = resolveInputSource(ctx, body);
  const abs = resolve(source.path);
  const label = body.label?.trim() || (body.upload_id ? uploadLabel(ctx.dataDir, body.upload_id) : null) || basename(abs);
  const campaignId = body.upload_id && !body.input_path ? campaignIdForInput(label, abs) : campaignIdForInput(basename(abs), abs);
  const workspaceHost = join(ctx.dataDir, "workspace", campaignId);
  const manifest = stageInput(abs, workspaceHost);
  const detected = classifyChallenge({
    manifest,
    originalDir: originalRoot(workspaceHost),
    endpoint: source.endpoint,
    hint: source.hint,
  });
  const triage = applyKindOverride(detected, source.challengeKind);
  return {
    campaign_id: campaignId,
    source_name: manifest.source_name,
    files: manifest.entries.length,
    total_bytes: manifest.total_bytes,
    sha256: manifest.sha256,
    detected: detected.kind,
    triage,
    // the same capability resolution the runtime uses; attachments give ctf,
    // a live web_url adds web on top
    capabilities: resolveToolCapabilities({
      execution_profile: "kali",
      challenge: { kind: triage.kind, ...(source.webUrl ? { web_url: source.webUrl } : {}) },
      scope: {
        entries: [
          ...(source.endpoint ? [`tcp://${source.endpoint.host}:${source.endpoint.port}`] : []),
          ...(source.webUrl ? [source.webUrl] : []),
        ],
      },
    }).capabilities,
  };
}

export function registerCampaignRoutes(add: Add, engineHost: EngineHost): void {
  add("GET", "/api/campaigns", () => ({
    campaigns: engineHost.control.listCampaigns().map((row) => {
      const camp = engineHost.control.storage.getCampaign(row.id);
      return {
        ...row,
        running: engineHost.running(row.id) ? true : false,
        budget: engineHost.control.budget.snapshot(row.id),
        spec: specSummary(camp.spec),
      };
    }),
  }));

  add("POST", "/api/campaigns", createCampaign);

  add("GET", "/api/campaigns/:id", (ctx) => campaignView(engineHost, idOf(ctx)));

  add("POST", "/api/campaigns/:id/start", (ctx) => {
    const id = idOf(ctx);
    const entry = engineHost.start(id);
    return { started: true, id, instance_id: entry.instanceId };
  });

  add("POST", "/api/campaigns/:id/pause", (ctx) => {
    const id = idOf(ctx);
    engineHost.control.pause(id);
    return { id, state: engineHost.control.storage.getCampaign(id).state, running: engineHost.running(id) != null };
  });

  add("POST", "/api/campaigns/:id/resume", (ctx) => {
    const id = idOf(ctx);
    engineHost.control.resume(id);
    let started = false;
    if (!engineHost.running(id)) {
      engineHost.start(id);
      started = true;
    }
    return { id, state: engineHost.control.storage.getCampaign(id).state, started };
  });

  add("POST", "/api/campaigns/:id/cancel", (ctx) => {
    const id = idOf(ctx);
    const epoch = engineHost.control.cancel(id);
    return { id, cancel_epoch: epoch, state: "cancelled" };
  });

  add("POST", "/api/campaigns/:id/hint", async (ctx) => {
    const id = idOf(ctx);
    const body = await ctx.json<{ text?: string }>();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw invalidInput("missing_hint", "hint requires text");
    return { id, epoch: engineHost.control.hint(id, text) };
  });

  add("POST", "/api/campaigns/:id/verify", async (ctx) => {
    const id = idOf(ctx);
    const body = await ctx.json<{ accept?: boolean; text?: string; fact_id?: string; continue?: boolean }>();
    if (typeof body.accept !== "boolean") throw invalidInput("missing_verdict", "verify requires accept: boolean");
    const result = engineHost.control.verifyGoal(id, { accept: body.accept, text: body.text ?? "", factId: body.fact_id });
    let continued = false;
    if (!body.accept && body.continue === true) {
      engineHost.start(id);
      continued = true;
    }
    return { ...result, id, continued };
  });

  add("POST", "/api/campaigns/:id/budget", async (ctx) => {
    const id = idOf(ctx);
    const body = await ctx.json<{ max_calls?: number; max_tokens?: number; max_cost_micro?: number }>();
    const epoch = engineHost.control.reviseBudget(id, {
      max_calls: typeof body.max_calls === "number" ? body.max_calls : undefined,
      max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
      max_cost_micro: typeof body.max_cost_micro === "number" ? body.max_cost_micro : undefined,
    });
    return { id, epoch };
  });

  add("POST", "/api/campaigns/:id/reconcile", async (ctx) => {
    const id = idOf(ctx);
    const body = await ctx.json<{ invocation_id?: string }>();
    const result = await engineHost.control.reconcile(id, body.invocation_id);
    return { id, ...result };
  });

  add("GET", "/api/campaigns/:id/explain-step", (ctx) => {
    const step = ctx.query.get("step") ?? "";
    if (!step) throw invalidInput("missing_step", "explain-step requires ?step=step_...");
    return engineHost.control.explainStep(idOf(ctx), step);
  });

  add("GET", "/api/campaigns/:id/list/:table", (ctx) => {
    const table = ctx.params.table ?? "";
    if (!LIST_TABLES.has(table)) throw invalidInput("table_not_allowed", `table must be one of ${[...LIST_TABLES].join(", ")}`);
    const id = idOf(ctx);
    engineHost.control.storage.getCampaign(id);
    return { table, rows: engineHost.control.storage.list(table, id) };
  });

  add("GET", "/api/campaigns/:id/events", (ctx) => {
    const id = idOf(ctx);
    engineHost.control.storage.getCampaign(id);
    const after = Number(ctx.query.get("after") ?? "0") || 0;
    const limit = Math.min(Math.max(Number(ctx.query.get("limit") ?? "200") || 200, 1), 1000);
    const rows = engineHost.control.storage.store.db
      .prepare("SELECT * FROM events WHERE campaign_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(id, after, limit) as Record<string, unknown>[];
    const head = engineHost.control.storage.store.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM events WHERE campaign_id = ?")
      .get(id) as { head: number };
    return { events: rows, after, head: Number(head.head) };
  });

  add("GET", "/api/campaigns/:id/report", (ctx) => {
    const id = idOf(ctx);
    const engine = engineHost.control;
    const existing = engine.storage.latestReport(id);
    return { id, report: existing ?? engine.writeReport(id, engine.storage.getCampaign(id).state), generated: !existing };
  });

  add("POST", "/api/campaigns/:id/report", (ctx) => {
    const id = idOf(ctx);
    const engine = engineHost.control;
    return { id, report: engine.writeReport(id, engine.storage.getCampaign(id).state), generated: true };
  });

  add("GET", "/api/campaigns/:id/operations", (ctx) => ({ operations: engineHost.control.listOperations(idOf(ctx)) }));

  add("GET", "/api/campaigns/:id/artifacts/:aid/content", (ctx) => {
    const id = idOf(ctx);
    const aid = ctx.params.aid ?? "";
    const row = engineHost.control.storage.listArtifacts(id).find((a) => String(a.id) === aid);
    if (!row) throw invalidInput("artifact_missing", `no artifact ${aid} in ${id}`);
    const offset = Math.max(Number(ctx.query.get("offset") ?? "0") || 0, 0);
    const length = Math.min(Math.max(Number(ctx.query.get("length") ?? String(ARTIFACT_READ_CAP)) || ARTIFACT_READ_CAP, 1), ARTIFACT_READ_CAP);
    const buf = readFileSync(String(row.path));
    const slice = buf.subarray(Math.min(offset, buf.length), Math.min(offset + length, buf.length));
    return {
      id: aid,
      mime: row.mime ?? "application/octet-stream",
      size: Number(row.size ?? buf.length),
      offset,
      length: slice.length,
      truncated_file: row.truncated === 1 || row.truncated === true,
      has_more: offset + slice.length < buf.length,
      text: slice.toString("utf8"),
    };
  });

  add("POST", "/api/uploads", uploadBody);
  add("POST", "/api/uploads/fetch", fetchUploadBody);
  add("POST", "/api/triage", triageBody);
}
