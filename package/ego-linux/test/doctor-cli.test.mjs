import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ego-browser.mjs");

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`doctor timed out\n${stdout}\n${stderr}`));
    }, 5000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("--doctor --json reports diagnostics without starting or attaching to Chrome", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ego-doctor-test-"));
  const stateRoot = join(sandbox, "state");
  const browserState = join(stateRoot, "ego-lite-linux", "browser.json");

  try {
    const result = await runCli(["--doctor", "--json"], {
      EGO_LINUX_CHROME: process.execPath,
      EGO_LINUX_CDP_URL: "ws://127.0.0.1:1/doctor-must-not-connect",
      EGO_LINUX_PROFILE: join(sandbox, "profile"),
      XDG_DATA_HOME: join(sandbox, "data"),
      XDG_STATE_HOME: stateRoot,
    });

    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.browser.binary, process.execPath);
    assert.equal(report.runtime.running, false);
    assert.equal(report.harness.built, true);
    await assert.rejects(access(browserState), { code: "ENOENT" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
