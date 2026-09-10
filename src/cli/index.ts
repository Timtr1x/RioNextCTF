#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyExecuteLimitFlags, applyFinalizationFlags, makeRuntimeConfig } from "../contracts/config.ts";
import { Engine, restoreEngineData } from "../controller/engine.ts";
import { DomainError } from "../domain/errors.ts";
import { runReactBaseline } from "../eval/baseline-react.ts";
import { HELP, flagString, parseArgs, resolveCampaignId } from "./args.ts";
import { loadCampaignSpec, seedChallengeStep } from "./run-spec.ts";
import { formatList, formatProgress, formatStatus, formatVerify } from "./format.ts";
import { KALI_HELP, handleKaliCommand } from "./kali.ts";
import { PROVIDER_HELP, handleProviderCommand } from "./providers.ts";

function dataDir(flags: Record<string, string | boolean>): string {
  if (typeof flags["data-dir"] === "string") return resolve(flags["data-dir"]);
  if (process.env.RIONEXT_DATA) return resolve(process.env.RIONEXT_DATA);
  return resolve(process.cwd(), ".rionext");
}

const DEFAULT_PROGRESS_MS = 300_000;

function progressMs(flags: Record<string, string | boolean>): number {
  if (flags["progress-ms"] === undefined) return DEFAULT_PROGRESS_MS;
  const n = Number(flags["progress-ms"]);
  return Number.isFinite(n) ? n : DEFAULT_PROGRESS_MS;
}

function startProgressLog(engine: Engine, id: string, intervalMs: number): () => void {
  if (intervalMs <= 0) return () => {};
  const tick = (): void => {
    try {
      console.log(formatProgress(new Date().toISOString(), engine.status(id), engine.storage.recentInvocations(id, 6)));
    } catch {
      // campaign row may not exist yet
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function runCampaign(engine: Engine, id: string, flags: Record<string, string | boolean>, json: boolean): Promise<void> {
  const stop = json ? () => {} : startProgressLog(engine, id, progressMs(flags));
  try {
    await engine.start(id);
  } finally {
    stop();
  }
}

function printHelp(topic?: string): void {  if (topic === "provider" || topic === "providers") {
    console.log(PROVIDER_HELP);
    return;
  }
  if (topic === "kali") {
    console.log(KALI_HELP);
    return;
  }
  console.log(HELP);
}

function emit(obj: unknown, json: boolean, text?: string): void {
  if (json) {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }
  if (text) {
    console.log(text);
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v && typeof v === "object") console.log(`${k}: ${JSON.stringify(v)}`);
      else console.log(`${k}: ${v}`);
    }
    return;
  }
  console.log(String(obj));
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  let { cmd } = parsed;
  const { positional, flags } = parsed;
  const json = Boolean(flags.json);
  if (flags.help || cmd === "--help" || cmd === "-h") {
    printHelp(positional[0] ?? (cmd === "provider" || cmd === "providers" ? "provider" : cmd === "kali" ? "kali" : undefined));
    return;
  }
  if (cmd === "help" && typeof flags.url === "string") cmd = "run";
  if (cmd === "help") {
    printHelp(positional[0]);
    return;
  }
  const dir = dataDir(flags);
  if (cmd === "health") {
    const kali = handleKaliCommand(["status"]) as Record<string, unknown>;
    emit(
      {
        docker: kali.docker ?? false,
        kali_master: kali.master_present ?? false,
        kali_image: kali.image ?? null,
        data_dir: dir,
      },
      json,
      `docker ${kali.docker ? "ok" : "missing"}  kali ${kali.master_present ? "ok" : "missing"}  data ${dir}`,
    );
    return;
  }
  if (cmd === "kali") {
    if (flags.help || positional[0] === "help" || positional[0] === "?") {
      console.log(KALI_HELP);
      return;
    }
    try {
      const rest = process.argv.slice(2).filter((a) => a !== "kali" && a !== "campaign");
      const result = handleKaliCommand(rest);
      if (result && typeof result === "object" && "help" in result) {
        console.log(String((result as { help: string }).help));
        return;
      }
      emit(result, true);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "restore") {
    const from = flags.from;
    if (typeof from !== "string") throw new Error("--from is required");
    emit(restoreEngineData(resolve(from), dir), true);
    return;
  }
  if (cmd === "ui" || cmd === "web" || cmd === "serve") {
    const port = flags.port ? Number(flags.port) : 7780;
    const { startUiServer } = await import("../web/server.ts");
    const ui = await startUiServer({
      dataDir: dir,
      port,
      maxCycles: flags["max-cycles"] ? Number(flags["max-cycles"]) : 1000,
    });
    console.log(`rionext ui ${ui.url}  data ${dir}`);
    console.log("campaigns started here run inside this process; Ctrl+C stops the server, not the data");
    const shutdown = (): void => {
      void ui.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }
  if (cmd === "provider" || cmd === "providers") {
    if (flags.help || positional[0] === "help") {
      console.log(PROVIDER_HELP);
      return;
    }
    try {
      const result = await handleProviderCommand(process.argv.slice(3), flags, dir);
      if (result && typeof result === "object" && "help" in result) {
        console.log(String((result as { help: string }).help));
        return;
      }
      emit(result, json || true);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }
  let cfg;
  try {
    cfg = applyExecuteLimitFlags(applyFinalizationFlags(makeRuntimeConfig(dir), flags), flags);
  } catch (err) {
    if (err instanceof DomainError) {
      console.error(`${err.code}: ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }
  if (flags["lease-ms"]) cfg.lease_ttl_ms = Number(flags["lease-ms"]);
  const engine = new Engine(cfg, {
    maxCycles: flags["max-cycles"] ? Number(flags["max-cycles"]) : 1000,
  });
  const needsId = !["run", "create", "list", "backup", "baseline"].includes(cmd);
  try {
    if (cmd === "list") {
      const rows = engine.listCampaigns();
      emit(rows, json, formatList(rows));
      return;
    }
    if (cmd === "run") {
      const loaded = loadCampaignSpec(flags, positional, dir);
      const spec = loaded.spec as { campaign_id?: string };
      let created = false;
      try {
        engine.createCampaign(spec);
        created = true;
      } catch (err) {
        if (!(err instanceof DomainError && err.code === "campaign_exists")) throw err;
      }
      const id = typeof spec.campaign_id === "string" ? spec.campaign_id : "";
      if (!id) throw new Error("spec.campaign_id is required");
      if (created && loaded.seed) seedChallengeStep(engine.storage, id, loaded.seed);
      await runCampaign(engine, id, flags, json);
      const st = engine.status(id);
      emit({ created, id, ...st }, json, formatStatus(st));
      return;
    }
    if (cmd === "create") {
      const loaded = loadCampaignSpec(flags, positional, dir);
      const rec = engine.createCampaign(loaded.spec);
      if (loaded.seed) seedChallengeStep(engine.storage, rec.id, loaded.seed);
      emit({ created: rec.id, state: rec.state, started: false }, json, `created ${rec.id}  ${rec.state}`);
      return;
    }
    if (cmd === "baseline") {
      const specPath = flags.spec;
      if (typeof specPath !== "string") throw new Error("--spec is required");
      const spec = JSON.parse(readFileSync(resolve(specPath), "utf8")) as unknown;
      emit(await runReactBaseline(spec, dir), true);
      return;
    }
    if (cmd === "backup") {
      const out = flags.out;
      if (typeof out !== "string") throw new Error("--out is required");
      emit(await engine.backupTo(resolve(out)), true);
      return;
    }
    const id = needsId ? resolveCampaignId(flags, positional, engine.listCampaigns()) : "";
    switch (cmd) {
      case "start": {
        await runCampaign(engine, id, flags, json);
        const st = engine.status(id);
        emit(st, json, formatStatus(st));
        break;
      }
      case "status": {
        const st = engine.status(id);
        emit(st, json, formatStatus(st));
        break;
      }
      case "events":
        emit({ events: engine.storage.list("events", id) }, json);
        break;
      case "steps":
        emit({ steps: engine.storage.list("steps", id) }, json);
        break;
      case "facts":
        emit({ facts: engine.storage.list("facts", id) }, json);
        break;
      case "findings":
        emit({ findings: engine.storage.list("findings", id) }, json);
        break;
      case "report": {
        const existing = engine.storage.latestReport(id);
        const report = existing ?? engine.writeReport(id, engine.storage.getCampaign(id).state);
        emit(report, json);
        break;
      }
      case "cancel":
        emit({ cancel_epoch: engine.cancel(id), state: "cancelled" }, json, `cancelled ${id}`);
        break;
      case "pause":
        engine.pause(id);
        emit({ state: "paused" }, json, `paused ${id}`);
        break;
      case "resume":
        engine.resume(id);
        emit({ state: engine.storage.getCampaign(id).state }, json, `${id}  ${engine.storage.getCampaign(id).state}`);
        break;
      case "hint": {
        const text = flagString(flags, "text") ?? positional.slice(1).join(" ");
        if (!text) throw new Error("hint requires --text");
        const epoch = engine.hint(id, text);
        emit({ epoch, command: "hint" }, json, `hint recorded on ${id}`);
        break;
      }
      case "accept":
      case "reject":
      case "verify-goal": {
        const accept = cmd === "accept" || Boolean(flags.accept);
        const reject = cmd === "reject" || Boolean(flags.reject);
        if (accept === reject) throw new Error("use rionext accept [id] or rionext reject [id] --text <why>");
        const result = engine.verifyGoal(id, {
          accept,
          text: flagString(flags, "text") ?? "",
          factId: flagString(flags, "fact"),
        });
        emit(result, json, formatVerify(result, id, accept));
        if (!accept && flags.continue) {
          await runCampaign(engine, id, flags, json);
          const st = engine.status(id);
          emit(st, json, formatStatus(st));
        }
        break;
      }
      case "revise-budget":
        emit(
          {
            epoch: engine.reviseBudget(id, {
              max_calls: flags["max-calls"] ? Number(flags["max-calls"]) : undefined,
              max_tokens: flags["max-tokens"] ? Number(flags["max-tokens"]) : undefined,
              max_cost_micro: flags["max-cost-micro"] ? Number(flags["max-cost-micro"]) : undefined,
            }),
            command: "revise_budget",
          },
          json,
        );
        break;
      case "revise-scope":
        emit({ epoch: engine.reviseScope(id, String(flags["scope-version"] ?? "")), command: "revise_scope" }, json);
        break;
      case "explain-step":
        emit(engine.explainStep(id, String(flags.step ?? positional[1] ?? "")), json);
        break;
      case "operations":
        emit({ operations: engine.listOperations(id) }, json);
        break;
      case "observations":
        emit({ observations: engine.storage.list("observations", id) }, json);
        break;
      case "invocations":
        emit({ invocations: engine.storage.list("invocations", id) }, json);
        break;
      case "coverage":
        emit({ coverage: engine.storage.list("coverage_items", id) }, json);
        break;
      case "goals":
        emit({ goals: engine.storage.list("goals", id) }, json);
        break;
      case "artifacts":
        emit({ artifacts: engine.storage.list("artifacts", id) }, json);
        break;
      case "reconcile": {
        const inv = flagString(flags, "invocation");
        emit({ reconcile: await engine.reconcile(id, inv), invocation: inv ?? null }, json);
        break;
      }
      default:
        throw new Error(`unknown command ${cmd}\n${HELP}`);
    }
  } catch (err) {
    if (err instanceof DomainError) {
      console.error(`${err.code}: ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  } finally {
    engine.close();
  }
}

await main();
