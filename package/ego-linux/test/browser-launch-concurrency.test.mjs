import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "fixture", "browser-launch-worker.mjs");
const BIN = join(HERE, "..", "bin", "ego-browser.mjs");

function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`exit ${code}\n${stdout}\n${stderr}`));
    });
  });
}

it(
  "concurrent agents launch one shared browser",
  { timeout: 60_000 },
  async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ego-browser-launch-"));
    const env = {
      ...process.env,
      EGO_LINUX_HEADLESS: "1",
      EGO_LINUX_PROFILE: join(sandbox, "profile"),
      XDG_DATA_HOME: join(sandbox, "data"),
      XDG_STATE_HOME: join(sandbox, "state"),
    };
    delete env.EGO_LINUX_CDP_URL;

    try {
      const outputs = await Promise.all(
        Array.from({ length: 8 }, () => runNode(WORKER, [], env)),
      );
      const endpoints = outputs.map((output) => JSON.parse(output));
      assert.equal(
        endpoints.filter((endpoint) => endpoint.launched).length,
        1,
        "only the lock owner launches Chrome",
      );
      assert.equal(
        new Set(endpoints.map((endpoint) => endpoint.port)).size,
        1,
        "every agent reuses the same DevTools endpoint",
      );
    } finally {
      await runNode(BIN, ["--stop"], env).catch(() => {});
      // Chrome helpers can still be flushing profile files after Browser.close.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rm(sandbox, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      }).catch(() => {});
    }
  },
);
