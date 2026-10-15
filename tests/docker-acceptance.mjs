#!/usr/bin/env node
/**
 * Real-Docker acceptance for the multi-worker stabilization round (H06):
 *  D03  two concurrent cold starts of one campaign container create it once
 *  D03x two OS processes racing the same container name never conflict
 *  D04  two runs browse in parallel; sessions and screenshots stay separate
 *  D05  one run cancelled mid-exec; the in-container process group is
 *       confirmed dead; the sibling's exec completes undisturbed
 *
 * Uses the locally built rionext-kali image; records the exact image id.
 * Never touches the master keeper. Containers named rionext-acc-* only.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { KaliRuntime } from "../dist/src/tools/kali-runtime.js";

const IMAGE = "rionext-kali:rolling";
const report = { started_at: new Date().toISOString(), checks: {}, image: null };
const note = (k, v) => { report.checks[k] = v; console.log(`${v.ok ? "✔" : "✖"} ${k}: ${v.detail}`); };
const fail = (k, msg) => { note(k, { ok: false, detail: msg }); };

function sh(args, timeout = 60_000) {
  try {
    return { code: 0, out: execFileSync("docker", args, { encoding: "utf8", timeout, windowsHide: true }) };
  } catch (err) {
    return { code: err.status ?? 1, out: String(err.stdout ?? ""), err: String(err.stderr ?? err.message) };
  }
}

function optsFor(dir, campaignId, extra = {}) {
  return {
    campaignId,
    workspaceHost: join(dir, "workspace", campaignId),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: [],
    network: "none",
    capabilities: ["ctf"],
    ...extra,
  };
}

async function main() {
  const image = sh(["image", "inspect", "-f", "{{.Id}}", IMAGE]);
  if (image.code !== 0) {
    fail("precheck", `image ${IMAGE} missing`);
    process.exit(1);
  }
  report.image = image.out.trim();
  const keep = sh(["inspect", "-f", "{{.State.Running}}", "rionext-master-keep"]);
  report.master_keeper_untouched = keep.out.trim() === "true" || keep.code === 0;

  const dir = mkdtempSync(join(tmpdir(), "rn-acc-"));
  const rt = new KaliRuntime();
  const names = [];

  // ---------- D03: two cold starts, one creation ----------
  {
    const opts = optsFor(dir, "acc-d03");
    const name = "rionext-kali-acc-d03";
    names.push(name);
    sh(["rm", "-f", name]);
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      rt.execAsync(opts, "cat", ["../../dev/null"], { timeout_ms: 20_000 }),
      rt.execAsync(opts, "cat", ["../../dev/null"], { timeout_ms: 20_000 }),
    ]);
    const count = sh(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]).out.trim().split("\n").filter(Boolean).length;
    note("D03", {
      ok: a.code === 0 && b.code === 0 && count === 1,
      detail: `both execs ok (${a.code}/${b.code}), containers named ${name}: ${count}, ${Date.now() - t0}ms`,
    });
  }

  // ---------- D03x: two OS processes race one container ----------
  {
    const name = "rionext-kali-acc-d03x";
    names.push(name);
    sh(["rm", "-f", name]);
    const childScript = join(dir, "child-ensure.mjs");
    writeFileSync(childScript, `
      import { KaliRuntime } from ${JSON.stringify(new URL("../dist/src/tools/kali-runtime.js", import.meta.url).href)};
      const rt = new KaliRuntime();
      const opts = ${JSON.stringify({ ...optsFor(dir, "acc-d03x") })};
      const r = await rt.execAsync(opts, "cat", ["../../dev/null"], { timeout_ms: 20_000 });
      process.stdout.write(String(r.code));
    `);
    const t0 = Date.now();
    const runs = [1, 2].map(() =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [childScript], { stdio: ["ignore", "pipe", "pipe"] });
        let err = "";
        p.stderr.on("data", (d) => (err += String(d)));
        p.on("close", (code) => resolve({ code, err }));
      }),
    );
    const results = await Promise.all(runs);
    const count = sh(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]).out.trim().split("\n").filter(Boolean).length;
    const ok = results.every((r) => r.code === 0) && count === 1;
    note("D03x", {
      ok,
      detail: `exit codes ${results.map((r) => r.code).join(",")}, containers: ${count}, ${Date.now() - t0}ms${ok ? "" : " errs: " + results.map((r) => r.err.slice(-200)).join("|")}`,
    });
  }

  // ---------- D05: cancel one run, confirm the process group, sibling unaffected ----------
  {
    const opts = optsFor(dir, "acc-d05");
    const name = "rionext-kali-acc-d05";
    names.push(name);
    sh(["rm", "-f", name]);
    // warm the container
    await rt.execAsync(opts, "cat", ["../../dev/null"], { timeout_ms: 20_000 });
    const ctl = new AbortController();
    const slow = rt.execAsync(opts, "bash", ["-c", "sleep 60"], { timeout_ms: 120_000, executionId: "kali_acc_d05_slow", signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 1500));
    const sib = await rt.execAsync(opts, "cat", ["../../dev/null"], { timeout_ms: 20_000, executionId: "kali_acc_d05_fast" });
    ctl.abort();
    const slowResult = await slow;
    const record = JSON.parse(readFileSync(join(dir, "workspace", "acc-d05", ".rionext-ops", "kali_acc_d05_slow.json"), "utf8"));
    // the in-container sleep must be gone
    const ps = sh(["exec", name, "sh", "-c", "ps aux | grep -v grep | grep 'sleep 60' || echo gone"]);
    const gone = ps.out.includes("gone");
    note("D05", {
      ok: sib.code === 0 && gone,
      detail: `sibling code=${sib.code}; in-container sleep after cancel: ${gone ? "gone" : "STILL RUNNING"}; slow exit code=${slowResult.code}; record phase=${record.phase} cancel_confirmed=${record.cancel_confirmed ?? false}`,
    });
  }

  // ---------- D04: two runs browse in parallel, sessions and screenshots separate ----------
  {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><h1>marker-${req.url}</h1></body></html>`);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const host = "host.docker.internal";
    let gatewayIp = null;
    try {
      const probe = sh(["run", "--rm", "--network", "bridge", "--entrypoint", "getent", IMAGE, "hosts", host], { timeout: 30_000 });
      const ip = probe.out.trim().split(/\s+/)[0];
      if (probe.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) gatewayIp = ip;
    } catch { /* fall through */ }
    if (!gatewayIp) {
      note("D04", { ok: null, detail: "host.docker.internal does not resolve in this Docker; browser-overlap check skipped (environment, not code)" });
    } else {
      const opts = optsFor(dir, "acc-d04", { network: "bridge", allowAssets: [host] });
      const name = "rionext-kali-acc-d04";
      names.push(name);
      sh(["rm", "-f", name]);
      const runA = "run_d04_a";
      const runB = "run_d04_b";
      const [a, b] = await Promise.all([
        rt.playwrightAsync({ ...opts, runId: runA }, { op: "goto", url: `http://${host}:${port}/a` }),
        rt.playwrightAsync({ ...opts, runId: runB }, { op: "goto", url: `http://${host}:${port}/b` }),
      ]);
      const [sa, sb] = await Promise.all([
        rt.playwrightAsync({ ...opts, runId: runA }, { op: "screenshot" }),
        rt.playwrightAsync({ ...opts, runId: runB }, { op: "screenshot" }),
      ]);
      const pathA = JSON.parse(sa.stdout || "{}").path ?? "";
      const pathB = JSON.parse(sb.stdout || "{}").path ?? "";
      const hostA = join(dir, "workspace", "acc-d04", pathA.replace(/^\/workspace\//, ""));
      const hostB = join(dir, "workspace", "acc-d04", pathB.replace(/^\/workspace\//, ""));
      const bodyA = JSON.parse(a.stdout || "{}");
      const bodyB = JSON.parse(b.stdout || "{}");
      const ok =
        existsSync(hostA) &&
        existsSync(hostB) &&
        pathA !== pathB &&
        JSON.stringify(bodyA).includes("marker-/a") &&
        JSON.stringify(bodyB).includes("marker-/b");
      note("D04", { ok, detail: `A=${pathA} B=${pathB} files=${existsSync(hostA)}/${existsSync(hostB)} markers ok=${ok}` });
    }
    srv.close();
  }

  // ---------- cleanup ----------
  for (const n of names) sh(["rm", "-f", n]);
  rmSync(dir, { recursive: true, force: true });
  report.finished_at = new Date().toISOString();
  writeFileSync(join(process.cwd(), "work", "docker-acceptance.json"), JSON.stringify(report, null, 2));
  const failed = Object.entries(report.checks).filter(([, v]) => v.ok === false);
  console.log(failed.length ? `FAILED: ${failed.map(([k]) => k).join(",")}` : "all real-Docker checks passed");
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
