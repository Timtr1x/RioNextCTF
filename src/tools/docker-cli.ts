import { spawn, spawnSync } from "node:child_process";
import { isProtectedImageRef, KALI_KEEPER_NAME } from "./kali-profile.ts";

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface DockerRunOpts {
  timeoutMs?: number;
  maxBytes?: number;
  input?: string;
  /** Abort the process group (worker cancellation). */
  signal?: AbortSignal;
}

export interface DockerCli {
  available(): boolean;
  run(argv: string[], opts?: DockerRunOpts): DockerExecResult;
  /** Async variant for worker paths: the event loop stays free while the tool runs. */
  runAsync(argv: string[], opts?: DockerRunOpts): Promise<DockerExecResult>;
}

function guardArgv(argv: string[]): DockerExecResult | null {
  if (argv[0] === "rmi" && argv.some((a) => isProtectedImageRef(a))) {
    return { stdout: "", stderr: "refusing to rmi master image rionext-kali", code: 1, timedOut: false };
  }
  if ((argv[0] === "rm" || argv[0] === "kill") && argv.includes(KALI_KEEPER_NAME)) {
    return { stdout: "", stderr: "refusing to remove master keeper rionext-master-keep", code: 1, timedOut: false };
  }
  return null;
}

export class ProcessDockerCli implements DockerCli {
  available(): boolean {
    const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 8_000 });
    return r.status === 0;
  }

  run(argv: string[], opts?: DockerRunOpts): DockerExecResult {
    const denied = guardArgv(argv);
    if (denied) return denied;
    const maxBytes = opts?.maxBytes ?? 1_000_000;
    const r = spawnSync("docker", argv, {
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 60_000,
      maxBuffer: maxBytes,
      windowsHide: true,
      input: opts?.input,
    });
    const timedOut = r.error?.name === "ETIMEDOUT" || /ETIMEDOUT/.test(String(r.error ?? ""));
    const stdout = String(r.stdout ?? "").slice(0, maxBytes);
    const stderr = String(r.stderr ?? "").slice(0, maxBytes);
    return { stdout, stderr, code: r.status ?? (timedOut ? 124 : 1), timedOut };
  }

  runAsync(argv: string[], opts?: DockerRunOpts): Promise<DockerExecResult> {
    const denied = guardArgv(argv);
    if (denied) return Promise.resolve(denied);
    const maxBytes = opts?.maxBytes ?? 1_000_000;
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn("docker", argv, { windowsHide: true });
      } catch {
        resolve({ stdout: "", stderr: "spawn failed", code: 1, timedOut: false });
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        resolve({
          stdout: stdout.slice(0, maxBytes),
          stderr: stderr.slice(0, maxBytes),
          code: code ?? (timedOut ? 124 : 1),
          timedOut,
        });
      };
      const onAbort = (): void => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, timeoutMs);
      timer.unref();
      child.stdout.on("data", (d) => {
        stdout += String(d);
        if (stdout.length > maxBytes) stdout = stdout.slice(0, maxBytes);
      });
      child.stderr.on("data", (d) => {
        stderr += String(d);
        if (stderr.length > maxBytes) stderr = stderr.slice(0, maxBytes);
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
      if (opts?.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        if (opts?.input !== undefined) child.stdin.write(opts.input);
        child.stdin.end();
      } catch {
        // stdin closed early; the close event settles
      }
    });
  }
}

export class FakeDockerCli implements DockerCli {
  readonly calls: string[][] = [];
  /** Test hook: hold async calls until released, to prove real overlap. */
  gate: Promise<void> | null = null;
  lastInput: string | undefined;
  next: DockerExecResult = { stdout: "", stderr: "", code: 0, timedOut: false };
  alive = new Set<string>();
  created = new Set<string>();
  /** Container name -> labels captured from --label args at run/create time. */
  labels = new Map<string, Record<string, string>>();
  images = new Set(["rionext-kali:rolling", "rionext-kali:master"]);

  available(): boolean {
    return true;
  }

  run(argv: string[], opts?: DockerRunOpts): DockerExecResult {
    this.calls.push([...argv]);
    this.lastInput = opts?.input;
    const maxBytes = opts?.maxBytes ?? 1_000_000;
    if (argv[0] === "image" && argv[1] === "inspect") {
      const ref = argv[argv.length - 1] ?? "";
      if (this.images.has(ref) || [...this.images].some((i) => argv.includes(i))) {
        return { stdout: "sha256:master", stderr: "", code: 0, timedOut: false };
      }
      return { stdout: "", stderr: "No such image", code: 1, timedOut: false };
    }
    if (argv[0] === "exec" && argv.includes("-d")) {
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "run" && argv.includes("-d")) {
      const name = nameFrom(argv);
      if (name) {
        // Real daemons reject a duplicate name; the fake must too (K01/K09).
        if (this.alive.has(name) || this.created.has(name)) {
          return {
            stdout: "",
            stderr: `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "abc123".`,
            code: 1,
            timedOut: false,
          };
        }
        this.alive.add(name);
        this.created.add(name);
        this.labels.set(name, labelsFrom(argv));
      }
      return { stdout: name ?? "cid", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "create") {
      const name = nameFrom(argv);
      if (name) {
        this.created.add(name);
        this.labels.set(name, labelsFrom(argv));
      }
      return { stdout: name ?? "cid", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "rmi") {
      return { stdout: "", stderr: "master image is retained", code: 1, timedOut: false };
    }
    if (argv[0] === "kill") {
      const name = argv[argv.length - 1];
      if (name === KALI_KEEPER_NAME) {
        return { stdout: "", stderr: "refusing to remove master keeper rionext-master-keep", code: 1, timedOut: false };
      }
      if (name) this.alive.delete(name);
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "rm") {
      const name = argv[argv.length - 1];
      if (name === KALI_KEEPER_NAME) {
        return { stdout: "", stderr: "refusing to remove master keeper rionext-master-keep", code: 1, timedOut: false };
      }
      if (name) {
        this.alive.delete(name);
        this.created.delete(name);
        this.labels.delete(name);
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "inspect") {
      const name = argv[argv.length - 1] ?? "";
      const exists = this.alive.has(name) || this.created.has(name);
      if (!exists) return { stdout: "", stderr: "No such object", code: 1, timedOut: false };
      if (argv.some((a) => a.includes("Config.Labels"))) {
        return { stdout: JSON.stringify(this.labels.get(name) ?? {}), stderr: "", code: 0, timedOut: false };
      }
      if (argv.some((a) => a.includes("{{.Id}}"))) {
        return { stdout: `cid-${name}`, stderr: "", code: 0, timedOut: false };
      }
      return { stdout: this.alive.has(name) ? "true" : "false", stderr: "", code: 0, timedOut: false };
    }
    return {
      stdout: this.next.stdout.slice(0, maxBytes),
      stderr: this.next.stderr.slice(0, maxBytes),
      code: this.next.code,
      timedOut: this.next.timedOut,
    };
  }

  async runAsync(argv: string[], opts?: DockerRunOpts): Promise<DockerExecResult> {
    if (this.gate) await this.gate;
    return this.run(argv, opts);
  }
}

function nameFrom(argv: string[]): string | null {
  const i = argv.indexOf("--name");
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return null;
}

function labelsFrom(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--label" && argv[i + 1]) {
      const eq = argv[i + 1]!.indexOf("=");
      if (eq > 0) out[argv[i + 1]!.slice(0, eq)] = argv[i + 1]!.slice(eq + 1);
    }
  }
  return out;
}
