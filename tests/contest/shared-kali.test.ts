import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildContainerSpec, containerName, type KaliStartOpts } from "../../src/tools/kali-runtime.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rn-shared-"));
}

function baseOpts(dir: string, over: Partial<KaliStartOpts> = {}): KaliStartOpts {
  return {
    campaignId: "camp_q_a1",
    workspaceHost: join(dir, "workspace", "camp_q_a1"),
    dbPath: join(dir, "rionext.sqlite"),
    secretsPath: join(dir, "provider-secrets.json"),
    artifactRoot: join(dir, "artifacts"),
    dataDir: dir,
    allowAssets: [],
    network: "none",
    ...over,
  };
}

test("default spec stays per-campaign (zero regression)", () => {
  const dir = tmp();
  const spec = buildContainerSpec(baseOpts(dir));
  assert.equal(spec.name, containerName("camp_q_a1"));
  assert.deepEqual(
    spec.mounts.map((m) => m.container),
    ["/workspace"],
  );
  const joined = spec.argv.join(" ");
  assert.ok(joined.includes("--workdir /workspace"), "default workdir unchanged");
  assert.ok(!joined.includes("--workdir /workspace/"), "no container-root prefix without shared mode");
  assert.ok(joined.includes("--memory 4g"), "default memory unchanged");
  assert.ok(joined.includes("--cpus 2"), "default cpus unchanged");
});

test("shared spec: one name, parent mount, per-campaign container root, scaled limits", () => {
  const dir = tmp();
  const spec = buildContainerSpec(
    baseOpts(dir, {
      shared: { name: "rionext-kali-contest", mountHost: join(dir, "workspace"), containerRoot: "/workspace/camp_q_a1" },
      limits: { memory: "16g", cpus: "8" },
    }),
  );
  assert.equal(spec.name, "rionext-kali-contest");
  const joined = spec.argv.join(" ");
  assert.ok(joined.includes("--workdir /workspace/camp_q_a1"), "exec root is the campaign subdir");
  assert.ok(joined.includes("--memory 16g"), "limits override applies");
  assert.ok(joined.includes("--cpus 8"));
  assert.equal(spec.env.RIONEXT_CAMPAIGN, "camp_q_a1");
  // the mount is the workspace PARENT, never db/secrets/artifacts
  assert.equal(joined.includes("rionext.sqlite"), false);
  assert.equal(joined.includes("provider-secrets"), false);
  const mountSrc = spec.mounts[0]!.host.replace(/\\/g, "/");
  assert.ok(mountSrc.endsWith("/workspace"), `parent mount, got ${mountSrc}`);
});

test("shared spec rejects a mount that collides with controller paths", () => {
  const dir = tmp();
  assert.throws(() =>
    buildContainerSpec(
      baseOpts(dir, {
        // dataDir itself as the mount source would expose the sqlite file
        shared: { name: "rionext-kali-contest", mountHost: dir, containerRoot: "/workspace" },
      }),
    ),
  );
});
