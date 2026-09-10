import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleKaliCommand } from "../cli/kali.ts";
import { restoreEngineData } from "../controller/engine.ts";
import { invalidInput } from "../domain/errors.ts";
import type { ApiHandler } from "./server.ts";
import type { EngineHost } from "./engine-host.ts";
import type { TaskRegistry } from "./tasks.ts";

type Add = (method: string, pattern: string, handler: ApiHandler) => void;

export interface OpsContext {
  healthCache: { at: number; value: Record<string, unknown> | null };
}

const HEALTH_TTL_MS = 3_000;
const KALI_OPS = new Set(["pull", "build", "protect", "smoke"] as const);

const here = dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  for (const candidate of [join(here, "..", "..", "..", "package.json"), join(here, "..", "..", "package.json")]) {
    try {
      return String((JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version ?? "unknown");
    } catch {
      // try the next candidate
    }
  }
  return "unknown";
}

function computeHealth(host: EngineHost): Record<string, unknown> {
  let kali: Record<string, unknown> = {};
  try {
    kali = handleKaliCommand(["status"]) as Record<string, unknown>;
  } catch (err) {
    kali = { docker: false, error: err instanceof Error ? err.message : String(err) };
  }
  return {
    ok: true,
    at: new Date().toISOString(),
    docker: kali.docker === true,
    kali_master: kali.master_present === true,
    keeper: kali.keeper_status ?? null,
    data_dir: host.dataDir,
    version: packageVersion(),
    running: host.runningIds(),
  };
}

export function registerOpsRoutes(add: Add, host: EngineHost, tasks: TaskRegistry, ops: OpsContext): void {
  add("GET", "/api/health", () => {
    const now = Date.now();
    if (!ops.healthCache.value || now - ops.healthCache.at > HEALTH_TTL_MS) {
      ops.healthCache.value = computeHealth(host);
      ops.healthCache.at = now;
    }
    return ops.healthCache.value;
  });

  add("GET", "/api/kali/status", () => {
    try {
      return handleKaliCommand(["status"]);
    } catch (err) {
      return { docker: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  add("POST", "/api/kali/:op", (ctx) => {
    const op = ctx.params.op ?? "";
    if (!KALI_OPS.has(op as "pull")) throw invalidInput("unknown_kali_op", `kali op must be one of ${[...KALI_OPS].join(", ")}`);
    const running = tasks.list().find((t) => t.kind === `kali.${op}` && t.status === "running");
    if (running) return { task: tasks.view(running), already_running: true };
    const task = tasks.startKali(op as "pull" | "build" | "protect" | "smoke");
    return { task: tasks.view(task), already_running: false };
  });

  add("GET", "/api/tasks", () => ({ tasks: tasks.list().map((t) => tasks.view(t)) }));

  add("GET", "/api/tasks/:id", (ctx) => {
    const task = tasks.get(ctx.params.id ?? "");
    if (!task) throw invalidInput("task_missing", `no task ${ctx.params.id}`);
    return tasks.view(task);
  });

  add("POST", "/api/backup", async (ctx) => {
    const body = await ctx.json<{ dest_dir?: string }>();
    const dest =
      typeof body.dest_dir === "string" && body.dest_dir.trim() !== ""
        ? resolve(body.dest_dir)
        : join(host.dataDir, "backups", `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    return { dest_dir: dest, report: await host.control.backupTo(dest) };
  });

  add("POST", "/api/restore", async (ctx) => {
    const body = await ctx.json<{ from?: string }>();
    if (typeof body.from !== "string" || body.from.trim() === "") {
      throw invalidInput("missing_restore_source", "restore requires { from: <backup dir> }");
    }
    return { report: restoreEngineData(resolve(body.from), host.dataDir) };
  });

  add("GET", "/api/config", () => {
    const cfg = host.control.config;
    const locks = host.control.storage.store.db
      .prepare("SELECT campaign_id, owner, acquired_at, heartbeat_at, lease_until, generation FROM controller_locks ORDER BY campaign_id")
      .all() as Record<string, unknown>[];
    return {
      data_dir: cfg.data_dir,
      db_path: cfg.db_path,
      artifact_root: cfg.artifact_root,
      instance_id: cfg.instance_id,
      version: packageVersion(),
      limits: {
        max_decide_turns: cfg.max_decide_turns,
        max_execute_turns_per_run: cfg.max_execute_turns_per_run,
        max_tool_calls_per_run: cfg.max_tool_calls_per_run,
        max_transient_retries_per_invocation: cfg.max_transient_retries_per_invocation,
        lease_ttl_ms: cfg.lease_ttl_ms,
        heartbeat_ms: cfg.heartbeat_ms,
        tool_preview_limit: cfg.tool_preview_limit,
        finalization: cfg.finalization,
      },
      controller_locks: locks,
    };
  });
}
