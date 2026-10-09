import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pickRunSource, seedChallengeStep, specFromInput } from "../../src/cli/run-spec.ts";
import { openEngine } from "../../src/controller/engine.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { campaignIdForInput } from "../../src/domain/quick-spec.ts";
import { validateCampaignSpec } from "../../src/domain/spec.ts";
import { ProviderCatalog } from "../../src/provider/catalog.ts";
import { resolveToolCapabilities } from "../../src/tools/kali-profile.ts";
import type { DockerExecResult, DockerRunOpts } from "../../src/tools/docker-cli.ts";
import { KaliRuntime } from "../../src/tools/kali-runtime.ts";

/** Minimal docker fake: every call succeeds, argv recorded. */
class RecordingDocker {
  calls: string[][] = [];
  run(argv: string[], _opts?: DockerRunOpts): DockerExecResult {
    this.calls.push(argv);
    if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) {
      return { code: 0, stdout: "true\n", stderr: "", timedOut: false };
    }
    if (argv[0] === "image") return { code: 0, stdout: "sha256:fake\n", stderr: "", timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-runinput-"));
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

function withSolver(dir: string): void {
  const cat = new ProviderCatalog(dir);
  const provider = cat.addProvider({
    display_name: "test",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    base_url: "https://example.invalid/v1/chat/completions",
    api_key: "sk-test",
  });
  const model = cat.addModel({ provider_id: provider.id, name: "deepseek-chat" });
  cat.assignSlot("solver", model.id);
}

test("pickRunSource validates --input/--kind/--endpoint combinations", () => {
  assert.deepEqual(pickRunSource({ input: "./chal" }, []), {
    kind: "input",
    path: "./chal",
    challengeKind: undefined,
    endpoint: undefined,
    webUrl: undefined,
    hint: undefined,
  });
  assert.throws(
    () => pickRunSource({ input: "./chal", url: "http://x.example/" }, []),
    (e: unknown) => e instanceof DomainError && e.code === "run_source_conflict",
  );
  assert.throws(
    () => pickRunSource({ input: "./chal", spec: "x.json" }, []),
    (e: unknown) => e instanceof DomainError && e.code === "run_source_conflict",
  );
  assert.throws(() => pickRunSource({ input: true }, []), (e: unknown) => e instanceof DomainError && e.code === "invalid_input");
  assert.throws(
    () => pickRunSource({ input: "./chal", kind: "bogus" }, []),
    (e: unknown) => e instanceof DomainError && e.code === "invalid_kind",
  );
  assert.throws(
    () => pickRunSource({ input: "./chal", kind: "web" }, []),
    (e: unknown) => e instanceof DomainError && e.code === "invalid_kind",
  );
  assert.throws(
    () => pickRunSource({ url: "http://x.example/", kind: "crypto" }, []),
    (e: unknown) => e instanceof DomainError && e.code === "kind_without_input",
  );
  assert.throws(
    () => pickRunSource({ url: "http://x.example/", endpoint: "tcp://h:1" }, []),
    (e: unknown) => e instanceof DomainError && e.code === "endpoint_without_input",
  );
  assert.throws(
    () => pickRunSource({ input: "./chal", endpoint: "http://h:80" }, []),
    (e: unknown) => e instanceof DomainError && e.code === "invalid_endpoint",
  );
  const pwn = pickRunSource({ input: "./chal", endpoint: "tcp://host.example:31337", kind: "pwn", hint: "bof" }, []);
  assert.equal(pwn.kind, "input");
  if (pwn.kind === "input") {
    assert.equal(pwn.challengeKind, "pwn");
    assert.deepEqual(pwn.endpoint, { host: "host.example", port: 31337 });
    assert.equal(pwn.hint, "bof");
  }
});

test("specFromInput stages the attachment, classifies, and plans the seed step", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "crackme");
  writeFileSync(src, elf64());
  const loaded = specFromInput({ kind: "input", path: src }, dir);
  const spec = loaded.spec as {
    campaign_id: string;
    execution_profile: string;
    challenge: { kind: string; seed_method_family: string; input: { files: number } };
    coverage_policy: { mandatory_ids: string[] };
    scope: { assets: string[] };
  };
  assert.equal(spec.execution_profile, "kali");
  assert.equal(spec.challenge.kind, "reverse");
  assert.equal(spec.challenge.seed_method_family, "reverse-native");
  assert.equal(spec.challenge.input.files, 1);
  assert.deepEqual(spec.coverage_policy.mandatory_ids, ["reverse-native"]);
  assert.deepEqual(spec.scope.assets, []);
  assert.equal(loaded.seed?.method_family, "reverse-native");
  // staged into the campaign workspace
  const id = spec.campaign_id;
  assert.ok(existsSync(join(dir, "workspace", id, "input", "original", "crackme")));
  assert.ok(existsSync(join(dir, "workspace", id, "input", "manifest.json")));
});

test("--kind override wins and detected kind is recorded", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "crackme");
  writeFileSync(src, elf64());
  const loaded = specFromInput({ kind: "input", path: src, challengeKind: "crypto" }, dir);
  const spec = loaded.spec as { challenge: { kind: string; detected_kind?: string; seed_method_family: string } };
  assert.equal(spec.challenge.kind, "crypto");
  assert.equal(spec.challenge.detected_kind, "reverse");
  assert.equal(spec.challenge.seed_method_family, "ctf-crypto");
  assert.equal(loaded.seed?.method_family, "ctf-crypto");
});

test("endpoint lands in scope assets and the seed question", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "chall");
  writeFileSync(src, elf64());
  const loaded = specFromInput({ kind: "input", path: src, endpoint: { host: "pwn.example", port: 31337 } }, dir);
  const spec = loaded.spec as {
    challenge: { kind: string; endpoint?: string };
    scope: { assets: string[] };
    root_goal: { statement: string };
  };
  assert.equal(spec.challenge.kind, "pwn");
  assert.equal(spec.challenge.endpoint, "tcp://pwn.example:31337");
  assert.deepEqual(spec.scope.assets, ["pwn.example:31337"]);
  assert.match(spec.root_goal.statement, /tcp:\/\/pwn\.example:31337/);
  assert.match(loaded.seed?.question ?? "", /tcp:\/\/pwn\.example:31337/);
});

test("web-url lands in challenge, scope, statement and the seed question", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "websrc");
  writeFileSync(src, "<?php echo 1; ?>");
  const loaded = specFromInput({ kind: "input", path: src, webUrl: "http://web.example:8080/" }, dir);
  const spec = loaded.spec as {
    challenge: { web_url?: string; endpoint?: string };
    scope: { assets: string[]; entries: string[] };
    root_goal: { statement: string };
  };
  assert.equal(spec.challenge.web_url, "http://web.example:8080/");
  assert.equal(spec.challenge.endpoint, undefined);
  assert.deepEqual(spec.scope.assets, ["web.example", "http://web.example:8080/"]);
  assert.deepEqual(spec.scope.entries, ["http://web.example:8080/"]);
  assert.match(spec.root_goal.statement, /http:\/\/web\.example:8080\//);
  assert.match(spec.root_goal.statement, /source code/);
  assert.match(loaded.seed?.question ?? "", /web\.example:8080/);
});

test("web-url and endpoint compose in one spec", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "chall");
  writeFileSync(src, elf64());
  const loaded = specFromInput(
    { kind: "input", path: src, endpoint: { host: "pwn.example", port: 31337 }, webUrl: "http://panel.example/" },
    dir,
  );
  const spec = loaded.spec as {
    challenge: { endpoint?: string; web_url?: string };
    scope: { assets: string[]; entries: string[] };
  };
  assert.equal(spec.challenge.endpoint, "tcp://pwn.example:31337");
  assert.equal(spec.challenge.web_url, "http://panel.example/");
  assert.deepEqual(spec.scope.assets, ["pwn.example:31337", "panel.example", "http://panel.example/"]);
  assert.deepEqual(spec.scope.entries, ["tcp://pwn.example:31337", "http://panel.example/"]);
});

test("seeded step is ready and survives campaign creation", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "crackme");
  writeFileSync(src, elf64());
  const loaded = specFromInput({ kind: "input", path: src }, dir);
  const spec = loaded.spec as Parameters<ReturnType<typeof openEngine>["createCampaign"]>[0];
  const e = openEngine(dir, { silent: true, maxCycles: 1 });
  try {
    const rec = e.createCampaign(spec);
    seedChallengeStep(e.storage, rec.id, loaded.seed!);
    const steps = e.storage.list("steps", rec.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.status, "ready");
    assert.equal(steps[0]!.method_family, "reverse-native");
    assert.equal(steps[0]!.priority, 10);
    // deterministic fingerprint: seeding again merges instead of duplicating
    seedChallengeStep(e.storage, rec.id, loaded.seed!);
    assert.equal(e.storage.list("steps", rec.id).length, 1);
  } finally {
    e.close();
  }
});

test("campaign id case-folds the path only on case-insensitive platforms", () => {
  const lower = campaignIdForInput("crackme", "/work/CTF/Crackme.elf");
  const upper = campaignIdForInput("crackme", "/work/ctf/crackme.elf");
  if (process.platform === "win32" || process.platform === "darwin") {
    assert.equal(lower, upper);
  } else {
    assert.notEqual(lower, upper);
  }
});

test("input campaign without endpoint runs networkless", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "crackme");
  writeFileSync(src, elf64());
  const loaded = specFromInput({ kind: "input", path: src }, dir);
  const e = openEngine(dir, { silent: true, maxCycles: 1 });
  try {
    const spec = loaded.spec as Parameters<typeof e.createCampaign>[0];
    const rec = e.createCampaign(spec);
    const opts = e.kaliOpts(rec.id);
    assert.equal(opts.network, "none");
    assert.deepEqual(opts.capabilities, ["ctf"]);
  } finally {
    e.close();
  }
});

test("challenge.web_url survives validate → create → getCampaign → engine reopen", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "websrc");
  writeFileSync(src, "<?php echo 1; ?>");
  const loaded = specFromInput({ kind: "input", path: src, webUrl: "http://web.example:8080/" }, dir);
  const spec = loaded.spec as { campaign_id: string };
  const e = openEngine(dir, { silent: true, maxCycles: 1 });
  try {
    const rec = e.createCampaign(loaded.spec as Parameters<typeof e.createCampaign>[0]);
    const camp = e.storage.getCampaign(rec.id);
    assert.equal(camp.spec.challenge?.web_url, "http://web.example:8080/");
    assert.deepEqual(resolveToolCapabilities(camp.spec).capabilities, ["ctf", "web"]);
    assert.deepEqual(e.kaliOpts(rec.id).capabilities, ["ctf", "web"]);
  } finally {
    e.close();
  }
  const reopened = openEngine(dir, { silent: true, maxCycles: 1 });
  try {
    const camp = reopened.storage.getCampaign(spec.campaign_id);
    assert.equal(camp.spec.challenge?.web_url, "http://web.example:8080/");
    assert.deepEqual(reopened.kaliOpts(spec.campaign_id).capabilities, ["ctf", "web"]);
  } finally {
    reopened.close();
  }
});

test("challenge.web_url rejects non-http(s), blank, and scope-mismatched values", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "websrc");
  writeFileSync(src, "<?php echo 1; ?>");
  const loaded = specFromInput({ kind: "input", path: src, webUrl: "http://web.example:8080/" }, dir);
  const spec = loaded.spec as Record<string, unknown>;
  const challenge = spec.challenge as Record<string, unknown>;

  const isInvalidChallenge = (e: unknown) => e instanceof DomainError && e.code === "invalid_challenge";
  assert.throws(() => validateCampaignSpec({ ...spec, challenge: { ...challenge, web_url: "ftp://web.example/" } }), isInvalidChallenge);
  assert.throws(() => validateCampaignSpec({ ...spec, challenge: { ...challenge, web_url: "javascript:alert(1)" } }), isInvalidChallenge);
  assert.throws(() => validateCampaignSpec({ ...spec, challenge: { ...challenge, web_url: "   " } }), isInvalidChallenge);
  // a declared web target the scope does not carry: explicit error, never silent widening
  assert.throws(() => validateCampaignSpec({ ...spec, challenge: { ...challenge, web_url: "http://other.example/" } }), isInvalidChallenge);
  // and the well-formed spec passes
  assert.doesNotThrow(() => validateCampaignSpec(spec));
});

test("mixed source+web campaign admits nmap/sqlmap/nuclei through the real exec path", () => {
  const dir = tmp();
  withSolver(dir);
  const src = join(dir, "websrc");
  writeFileSync(src, "<?php echo 1; ?>");
  const loaded = specFromInput({ kind: "input", path: src, webUrl: "http://web.example:8080/" }, dir);
  const e = openEngine(dir, { silent: true, maxCycles: 1 });
  try {
    const rec = e.createCampaign(loaded.spec as Parameters<typeof e.createCampaign>[0]);
    const opts = e.kaliOpts(rec.id);
    assert.deepEqual(opts.capabilities, ["ctf", "web"]);
    const docker = new RecordingDocker();
    const rt = new KaliRuntime(docker as never);
    opts.resolve = (h: string) => (h === "web.example" ? ["10.1.2.3"] : []);
    for (const bin of ["nmap", "sqlmap", "nuclei"]) {
      const r = rt.exec(opts, bin, ["web.example"]);
      assert.equal(r.code, 0, `${bin} must pass argv admission for a mixed campaign`);
    }
    // the ctf half is there too: misclassification no longer blocks gdb
    assert.equal(rt.exec(opts, "gdb", ["--version"]).code, 0);
    // egress is still enforced for out-of-scope hosts
    assert.throws(
      () => rt.exec(opts, "nmap", ["other.example"]),
      (err: unknown) => err instanceof DomainError && err.code === "egress_denied",
    );
  } finally {
    e.close();
  }
});
