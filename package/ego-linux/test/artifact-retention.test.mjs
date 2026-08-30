import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ARTIFACT_TTL_HOURS,
  artifactTtlMs,
  cleanupExpiredArtifacts,
} from "../src/artifact-retention.mjs";

const HOUR_MS = 60 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ego-browser.mjs");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderr}`));
    });
  });
}

test("artifact TTL defaults safely and zero disables cleanup", () => {
  assert.equal(artifactTtlMs({}), DEFAULT_ARTIFACT_TTL_HOURS * HOUR_MS);
  assert.equal(
    artifactTtlMs({ EGO_BROWSER_ARTIFACT_TTL_HOURS: "invalid" }),
    DEFAULT_ARTIFACT_TTL_HOURS * HOUR_MS,
  );
  assert.equal(artifactTtlMs({ EGO_BROWSER_ARTIFACT_TTL_HOURS: "0" }), 0);
  assert.equal(
    artifactTtlMs({ EGO_BROWSER_ARTIFACT_TTL_HOURS: "2.5" }),
    2.5 * HOUR_MS,
  );
});

test("cleanup deletes only expired Ego-generated temp artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-artifact-retention-"));
  const now = Date.parse("2026-08-27T22:00:00.000Z");
  const old = new Date(now - 25 * HOUR_MS);
  const recent = new Date(now - HOUR_MS);
  const paths = {
    oldShot: join(root, "ego-browser-shot-1-100-1.png"),
    recentShot: join(root, "ego-browser-shot-2-200-1.png"),
    oldFailure: join(root, "ego-browser-failure-3-300-1.json"),
    oldDownloads: join(root, "ego-browser-downloads-4-400-a1b2c3"),
    unrelated: join(root, "customer-screenshot.png"),
    similar: join(root, "ego-browser-shot-not-ours.png"),
  };

  try {
    await Promise.all([
      writeFile(paths.oldShot, "old"),
      writeFile(paths.recentShot, "recent"),
      writeFile(paths.oldFailure, "old"),
      writeFile(paths.unrelated, "keep"),
      writeFile(paths.similar, "keep"),
      mkdir(paths.oldDownloads),
    ]);
    await writeFile(join(paths.oldDownloads, "download.pdf"), "old");
    await Promise.all([
      utimes(paths.oldShot, old, old),
      utimes(paths.recentShot, recent, recent),
      utimes(paths.oldFailure, old, old),
      utimes(paths.oldDownloads, old, old),
      utimes(paths.unrelated, old, old),
      utimes(paths.similar, old, old),
    ]);

    const result = await cleanupExpiredArtifacts({ directory: root, now });
    assert.deepEqual(result, { deleted: 3 });
    assert.equal(await exists(paths.oldShot), false);
    assert.equal(await exists(paths.oldFailure), false);
    assert.equal(await exists(paths.oldDownloads), false);
    assert.equal(await exists(paths.recentShot), true);
    assert.equal(await exists(paths.unrelated), true);
    assert.equal(await exists(paths.similar), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled cleanup leaves expired artifacts in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-artifact-disabled-"));
  const shot = join(root, "ego-browser-shot-1-100-1.png");
  try {
    await writeFile(shot, "old");
    const result = await cleanupExpiredArtifacts({
      directory: root,
      env: { EGO_BROWSER_ARTIFACT_TTL_HOURS: "0" },
    });
    assert.deepEqual(result, { deleted: 0, disabled: true });
    assert.equal(await exists(shot), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every CLI invocation runs artifact cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-artifact-cli-"));
  const shot = join(root, "ego-browser-shot-9-900-1.png");
  try {
    await writeFile(shot, "old");
    const old = new Date(Date.now() - 25 * HOUR_MS);
    await utimes(shot, old, old);
    await runCli(["--status"], {
      ...process.env,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      XDG_STATE_HOME: join(root, "state"),
      EGO_LINUX_PROFILE: join(root, "profile"),
    });
    assert.equal(await exists(shot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
