import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fetchAttachment } from "../domain/attachment-fetch.ts";
import { applyKindOverride, isChallengeKind, parseTcpEndpoint, type ChallengeKind, type TcpEndpoint } from "../domain/challenge-kind.ts";
import { classifyChallenge } from "../domain/challenge-triage.ts";
import { invalidInput } from "../domain/errors.ts";
import { originalRoot, stageInput } from "../domain/input-manifest.ts";
import { buildInputFlagSpec, buildKaliFlagSpec, campaignIdForInput, looksLikeHttpUrl, parseTargetUrl } from "../domain/quick-spec.ts";
import type { CampaignSpec } from "../domain/types.ts";
import { ProviderCatalog } from "../provider/catalog.ts";
import { resolveSlot } from "../provider/router.ts";
import type { StorageService } from "../storage/service.ts";
import { flagString } from "./args.ts";

export interface SeedStepPlan {
  question: string;
  method_family: string;
  fingerprint: string;
}

export type RunSource =
  | { kind: "url"; url: string }
  | { kind: "spec"; path: string }
  | { kind: "input"; path: string; challengeKind?: ChallengeKind; endpoint?: TcpEndpoint; webUrl?: string; hint?: string }
  | { kind: "input-url"; url: string; challengeKind?: ChallengeKind; endpoint?: TcpEndpoint; webUrl?: string; hint?: string };

export interface LoadedRun {
  spec: unknown;
  /** Present for --input campaigns: a ready step pointing at the attachments. */
  seed?: SeedStepPlan;
}

export function pickRunSource(flags: Record<string, string | boolean>, positional: string[]): RunSource {
  const fromFlag = flagString(flags, "url");
  const fromPos = positional.find((p) => looksLikeHttpUrl(p));
  const url = fromFlag ?? fromPos;
  const specPath = flagString(flags, "spec");
  const inputPath = flagString(flags, "input");
  const inputUrl = flagString(flags, "input-url");
  const kindRaw = flagString(flags, "kind");
  const endpointRaw = flagString(flags, "endpoint");
  const webUrlRaw = flagString(flags, "web-url");
  const hint = flagString(flags, "hint");

  if (flags.input === true || inputPath === "true") {
    throw invalidInput("invalid_input", "--input requires a file or directory path");
  }
  if (flags["input-url"] === true || inputUrl === "true") {
    throw invalidInput("invalid_input_url", "--input-url requires an http(s) address");
  }
  const inputSources = [inputPath, inputUrl].filter((v) => v !== undefined);
  if (inputSources.length > 1 || (inputSources.length === 1 && (url || specPath))) {
    throw invalidInput("run_source_conflict", "--input/--input-url cannot be combined with each other, --url, or --spec");
  }
  if (url && specPath) {
    throw invalidInput("run_source_conflict", "--url and --spec cannot be used together");
  }

  if (inputPath || inputUrl) {
    let challengeKind: ChallengeKind | undefined;
    if (kindRaw) {
      if (!isChallengeKind(kindRaw)) {
        throw invalidInput("invalid_kind", `--kind must be one of auto|web|reverse|pwn|misc|crypto|generic, got ${kindRaw}`);
      }
      if (kindRaw === "web") {
        throw invalidInput("invalid_kind", "--kind web targets a live URL; use --url instead of --input");
      }
      if (kindRaw !== "auto") challengeKind = kindRaw;
    }
    let endpoint: TcpEndpoint | undefined;
    if (endpointRaw) endpoint = parseTcpEndpoint(endpointRaw);
    let webUrl: string | undefined;
    if (webUrlRaw) webUrl = parseTargetUrl(webUrlRaw).toString();
    if (inputPath) return { kind: "input", path: inputPath, challengeKind, endpoint, webUrl, hint };
    return { kind: "input-url", url: inputUrl!, challengeKind, endpoint, webUrl, hint };
  }

  if (kindRaw) throw invalidInput("kind_without_input", "--kind only applies to --input/--input-url runs");
  if (endpointRaw) throw invalidInput("endpoint_without_input", "--endpoint only applies to --input/--input-url runs");
  if (webUrlRaw) throw invalidInput("web_url_without_input", "--web-url only applies to --input/--input-url runs");
  if (hint) throw invalidInput("hint_without_input", "--hint only applies to --input/--input-url runs");

  if (url) {
    if (url === "true") throw invalidInput("invalid_url", "--url requires an http(s) address");
    return { kind: "url", url };
  }
  if (!specPath) {
    throw invalidInput("missing_run_source", "pass a URL, --input <path>, --input-url <url>, or --spec <file>");
  }
  return { kind: "spec", path: specPath };
}

function solverRoute(dataDir: string): { provider: string; model: string } {
  const catalog = new ProviderCatalog(dataDir);
  try {
    const route = resolveSlot(catalog, "solver");
    return { provider: route.provider.id, model: route.model.name };
  } catch (err) {
    throw invalidInput("solver_missing", err instanceof Error ? err.message : String(err));
  }
}

export function specFromUrl(url: string, dataDir: string, campaignId?: string): CampaignSpec {
  const route = solverRoute(dataDir);
  return buildKaliFlagSpec({
    url,
    provider: route.provider,
    model: route.model,
    campaign_id: campaignId,
  });
}

/**
 * Stage the attachment, classify it deterministically, build the spec, and
 * plan the seed step. Everything happens before campaign creation so a bad
 * input fails before any campaign row exists.
 */
export function specFromInput(
  source: Extract<RunSource, { kind: "input" }>,
  dataDir: string,
  campaignId?: string,
  opts?: { containerRoot?: string },
): LoadedRun {
  const abs = resolve(source.path);
  const route = solverRoute(dataDir);
  const id = campaignId?.trim() || campaignIdForInput(basename(abs), abs);
  const workspaceHost = join(dataDir, "workspace", id);
  const manifest = stageInput(abs, workspaceHost);
  const detected = classifyChallenge({
    manifest,
    originalDir: originalRoot(workspaceHost),
    endpoint: source.endpoint,
    hint: source.hint,
  });
  const triage = applyKindOverride(detected, source.challengeKind);
  const root = opts?.containerRoot ?? "/workspace";
  const spec = buildInputFlagSpec({
    provider: route.provider,
    model: route.model,
    campaign_id: id,
    triage,
    detected_kind: detected.kind !== triage.kind ? detected.kind : undefined,
    input: {
      source_name: manifest.source_name,
      files: manifest.entries.length,
      total_bytes: manifest.total_bytes,
      sha256: manifest.sha256,
    },
    endpoint: source.endpoint,
    web_url: source.webUrl,
    container_root: opts?.containerRoot,
  });
  const overlayText = triage.overlay ? `/${triage.overlay}` : "";
  const endpointText = source.endpoint ? ` 远程服务 tcp://${source.endpoint.host}:${source.endpoint.port}（容器内可达，pwntools remote() 或 nc）。` : "";
  const webText = source.webUrl ? ` 本题还有 live web 靶机 ${source.webUrl}（容器内可达），附件是它的源码/配套材料；源码和靶机都是证据来源，按价值决定先审源码还是直接探测。` : "";
  const question =
    `挑战附件已就位：${root}/input/original（${manifest.entries.length} 个文件，SHA-256 清单见 ${root}/input/manifest.json）。` +
    `题型判定 ${triage.kind}${overlayText}（置信度 ${triage.confidence}），只作参考，分类错了可以跨题型用工具。` +
    `user_payload.skill_pack 是该题型可参考的方法（不是固定流程，允许跳步）；input/original 只读，中间产物写 ${root}/work，证据写 ${root}/artifacts。` +
    endpointText +
    webText +
    `恢复 flag 后调用 submit_fact，fact_key=flag_recovered，proposition 为 flag 原文。`;
  const seed: SeedStepPlan = {
    question,
    method_family: triage.seed_method_family,
    fingerprint: createHash("sha256").update(`seed|${id}|${triage.seed_method_family}`).digest("hex").slice(0, 32),
  };
  return { spec, seed };
}

/**
 * Download a remote attachment into a stable per-URL directory, so a repeated
 * --input-url run stages the same path and resumes the same campaign id.
 */
async function downloadInputUrl(url: string, dataDir: string): Promise<string> {
  const key = createHash("sha256").update(url).digest("hex").slice(0, 12);
  const dir = join(dataDir, "downloads", `dl_${key}`);
  rmSync(dir, { recursive: true, force: true });
  const got = await fetchAttachment(url, dir);
  process.stderr.write(`downloaded ${got.name} (${got.bytes}b, sha256 ${got.sha256.slice(0, 16)}...)\n`);
  return dir;
}

export async function loadCampaignSpec(flags: Record<string, string | boolean>, positional: string[], dataDir: string): Promise<LoadedRun> {
  const source = pickRunSource(flags, positional);
  if (source.kind === "spec") {
    return { spec: JSON.parse(readFileSync(resolve(source.path), "utf8")) as unknown };
  }
  if (source.kind === "input-url") {
    const dir = await downloadInputUrl(source.url, dataDir);
    const staged: Extract<RunSource, { kind: "input" }> = {
      kind: "input",
      path: dir,
      challengeKind: source.challengeKind,
      endpoint: source.endpoint,
      webUrl: source.webUrl,
      hint: source.hint,
    };
    return specFromInput(staged, dataDir, flagString(flags, "id"));
  }
  if (source.kind === "input") {
    return specFromInput(source, dataDir, flagString(flags, "id"));
  }
  return { spec: specFromUrl(source.url, dataDir, flagString(flags, "id")) };
}

/**
 * Seed one ready step for --input campaigns so the first Execute lands on the
 * attachments instead of letting Decide guess a plan from an empty frontier.
 * Deterministic fingerprint: re-seeding an existing campaign is a no-op.
 */
export function seedChallengeStep(storage: StorageService, campaignId: string, seed: SeedStepPlan): void {
  const root = storage.store.db
    .prepare("SELECT id FROM goals WHERE campaign_id = ? AND is_root = 1")
    .get(campaignId) as { id: string } | undefined;
  storage.proposeStepDirect({
    campaign_id: campaignId,
    producer_id: "cli",
    submission_id: `seed-${campaignId}`,
    question: seed.question,
    kind: "explore",
    goal_refs: root ? [root.id] : [],
    preconditions: { op: "all", of: [] },
    method_family: seed.method_family,
    expected_observations: ["triage", "analysis"],
    completion_criteria: "flag_recovered fact submitted",
    fingerprint: seed.fingerprint,
    reopen_rule: { kind: "always" },
    priority: 10,
  });
}
