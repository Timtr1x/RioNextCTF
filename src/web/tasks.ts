import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface UiTask {
  id: string;
  kind: string;
  label: string;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  log: string[];
  result: unknown | null;
}

const MAX_LOG_LINES = 500;
const MAX_TASKS = 50;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Registry for long-running host operations (kali pull/build/protect/smoke).
 * Work runs in a child CLI process so the ui event loop never blocks on
 * docker, and the log tail is poll-able from the frontend logbox.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, UiTask>();

  list(): UiTask[] {
    return [...this.tasks.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  get(id: string): UiTask | undefined {
    return this.tasks.get(id);
  }

  startKali(op: "pull" | "build" | "protect" | "smoke"): UiTask {
    const cli = join(here, "..", "cli", "index.js");
    return this.spawn(`kali.${op}`, `rionext kali ${op}`, [process.execPath, cli, "kali", op]);
  }

  private spawn(kind: string, label: string, argv: string[]): UiTask {
    const task: UiTask = {
      id: `task_${randomUUID().slice(0, 8)}`,
      kind,
      label,
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      log: [],
      result: null,
    };
    this.tasks.set(task.id, task);
    this.prune();
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("spawn argv is empty");
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let outTail = "";
    const onData = (buf: Buffer) => {
      const text = buf.toString("utf8");
      outTail = (outTail + text).slice(-64_000);
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        task.log.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
        if (task.log.length > MAX_LOG_LINES) task.log.splice(0, task.log.length - MAX_LOG_LINES);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      task.status = "error";
      task.finished_at = new Date().toISOString();
      task.log.push(`spawn failed: ${err.message}`);
    });
    child.on("close", (code) => {
      task.exit_code = code;
      task.status = code === 0 ? "done" : "error";
      task.finished_at = new Date().toISOString();
      try {
        task.result = JSON.parse(outTail.trim());
      } catch {
        task.result = null;
      }
    });
    return task;
  }

  private prune(): void {
    const done = this.list().filter((t) => t.status !== "running");
    while (this.tasks.size >= MAX_TASKS && done.length > 0) {
      const victim = done.pop();
      if (!victim) break;
      this.tasks.delete(victim.id);
    }
  }

  /** JSON-facing view: log as one string for cheap rendering. */
  view(task: UiTask): Record<string, unknown> {
    return { ...task, log: task.log.join("\n") };
  }
}
