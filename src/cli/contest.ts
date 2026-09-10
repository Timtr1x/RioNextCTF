/**
 * `rionext contest` — supervisor command for the 春秋 AI 解题赛 platform.
 * run: poll the board, fill slots with campaigns, submit/verify flags.
 * status/stop/reset: inspect or interrupt a running supervisor.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContestApi } from "../contest/api.ts";
import { hasManagerSlot, managerReaction, type ManagerInput } from "../contest/manager.ts";
import { EngineRunnerFactory } from "../contest/runner.ts";
import { SharedKali } from "../contest/shared-kali.ts";
import { ContestSupervisor, type SlotInfo } from "../contest/supervisor.ts";
import { ProviderCatalog } from "../provider/catalog.ts";
import { resolveSlot } from "../provider/router.ts";
import { flagString } from "./args.ts";

export const CONTEST_HELP = `RioNext contest mode (春秋 AI 智能体解题赛)

  rionext contest run --mode test|official --token-file ./token.txt [--slots 4]
  rionext contest status
  rionext contest stop
  rionext contest reset <question_id> --token-file ./token.txt

Token comes from --token-file or RIONEXT_CONTEST_TOKEN, never from argv.
State lives in <data-dir>/contest/ (own sqlite, downloads, workspaces).
All slot campaigns share ONE Kali container (rionext-kali-contest).

  --mode test       mock/测试 questions are accepted (drill the full loop)
  --mode official   mock/测试 questions are filtered out
  --slots 4         max parallel campaigns (1-8)
  --max-cycles 1000 controller cycles per campaign

Flag flow: a campaign flag claim is submitted to the platform automatically.
Accepted → campaign closes, slot frees, next question starts. Rejected → the
campaign is told what the platform said and resumes (same value never
resubmitted; 3 wrong attempts pauses the question). A manager-slot model, when
assigned, adds one diagnostic hint after each rejection.
`;

const SHARED_CONTAINER_NAME = "rionext-kali-contest";

function contestPaths(baseDir: string): { dir: string; stateFile: string; stopFile: string } {
  const dir = join(baseDir, "contest");
  return { dir, stateFile: join(dir, "contest-state.json"), stopFile: join(dir, "STOP") };
}

function readToken(flags: Record<string, string | boolean>): string {
  const file = flagString(flags, "token-file");
  if (file) {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  }
  const env = process.env.RIONEXT_CONTEST_TOKEN?.trim();
  if (env) return env;
  throw new Error("contest token missing: pass --token-file <path> or set RIONEXT_CONTEST_TOKEN");
}

function syncProviders(baseDir: string, contestDir: string, log: (l: string) => void): void {
  for (const f of ["providers.json", "provider-secrets.json"]) {
    const src = join(baseDir, f);
    const dst = join(contestDir, f);
    if (existsSync(src) && !existsSync(dst)) {
      copyFileSync(src, dst);
      log(`copied ${f} into contest dir`);
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatSlot(s: SlotInfo): string {
  const note = s.note ? `  ${s.note}` : "";
  return `  ${s.qid}  ${s.category}  ${s.phase}  attempts=${s.attempts} crashes=${s.crashes}${note}`;
}

export async function handleContestCommand(
  positional: string[],
  flags: Record<string, string | boolean>,
  baseDir: string,
): Promise<void> {
  const sub = positional[0] ?? "run";
  const { dir, stateFile, stopFile } = contestPaths(baseDir);
  const log = (line: string): void => console.log(`[${new Date().toISOString()}] ${line}`);

  if (sub === "status") {
    if (!existsSync(stateFile)) {
      console.log(`no contest state in ${dir} — not running?`);
      return;
    }
    const st = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    const alive = typeof st.pid === "number" && pidAlive(st.pid);
    console.log(`mode ${st.mode}  pid ${st.pid} (${alive ? "alive" : "gone"})  ticks ${st.ticks}`);
    console.log(`started ${st.started_at}  last update ${st.updated_at}  questions seen ${st.questions_seen}`);
    const solved = Array.isArray(st.solved) ? st.solved : [];
    console.log(`solved here: ${solved.length ? solved.join(", ") : "none"}`);
    const active = Array.isArray(st.active) ? (st.active as SlotInfo[]) : [];
    console.log(`active slots (${active.length}):`);
    for (const s of active) console.log(formatSlot(s));
    const quarantined = (st.quarantined ?? {}) as Record<string, string>;
    const qk = Object.keys(quarantined);
    if (qk.length) {
      console.log(`quarantined (${qk.length}):`);
      for (const k of qk) console.log(`  ${k}  ${quarantined[k]}`);
    }
    return;
  }

  if (sub === "stop") {
    writeFileSync(stopFile, String(Date.now()), "utf8");
    const factory = new EngineRunnerFactory(dir, {});
    const cancelled = factory.control().cancelAll();
    factory.dispose();
    try {
      // In case the supervisor died without cleanup:
      new SharedKali({ name: SHARED_CONTAINER_NAME, mountHost: join(dir, "workspace"), dataDir: dir }).kill();
    } catch {
      // no shared container is fine
    }
    console.log(cancelled.length ? `stop requested; cancelled: ${cancelled.join(", ")}` : "stop requested; no live campaigns");
    return;
  }

  if (sub === "reset") {
    const qid = positional[1] ?? flagString(flags, "question");
    if (!qid) throw new Error("reset requires a question_id");
    const api = new ContestApi({ token: readToken(flags) });
    const r = await api.resetQuestion(qid);
    console.log(r.ok ? `reset ok: ${r.message || "操作成功"}` : `reset failed: ${r.message}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (sub !== "run") throw new Error(`unknown contest subcommand ${sub}\n${CONTEST_HELP}`);

  const mode = flagString(flags, "mode");
  if (mode !== "test" && mode !== "official") throw new Error("--mode test|official is required");
  const token = readToken(flags);
  const slots = Math.max(1, Math.min(8, Number(flags.slots ?? 4) || 4));
  mkdirSync(dir, { recursive: true });
  syncProviders(baseDir, dir, log);
  if (!existsSync(join(dir, "providers.json"))) {
    throw new Error(`no provider catalog in ${baseDir} — run rionext provider add first`);
  }
  const catalog = new ProviderCatalog(dir);
  try {
    resolveSlot(catalog, "solver");
  } catch (err) {
    throw new Error(`solver slot unusable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (existsSync(stateFile)) {
    let st: { pid?: number } | null = null;
    try {
      st = JSON.parse(readFileSync(stateFile, "utf8")) as { pid?: number };
    } catch {
      // unreadable state file: stale, ignore
    }
    if (st?.pid && st.pid !== process.pid && pidAlive(st.pid)) {
      throw new Error(`contest supervisor already running (pid ${st.pid}); stop it first: rionext contest stop`);
    }
  }

  const api = new ContestApi({ token, onLog: log });
  const shared = { name: SHARED_CONTAINER_NAME, mountHost: join(dir, "workspace") };
  const factory = new EngineRunnerFactory(dir, {
    maxCycles: Number(flags["max-cycles"] ?? 1000) || 1000,
    shared,
    onLog: log,
  });
  const sharedKali = new SharedKali({ name: shared.name, mountHost: shared.mountHost, dataDir: dir, onLog: log });
  const manager = hasManagerSlot(catalog) ? (input: ManagerInput) => managerReaction(catalog, input) : undefined;
  if (!manager) log("manager slot empty; wrong-answer resumes use the deterministic reject hint only");

  const sup = new ContestSupervisor({
    dir,
    mode,
    slots,
    api,
    factory,
    manager,
    sharedKali,
    stateFile,
    stopFile,
    onLog: log,
  });
  const onSignal = (): void => {
    log("signal received; stopping after the current step");
    sup.requestStop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await sup.run();
  } finally {
    factory.dispose();
  }
}
