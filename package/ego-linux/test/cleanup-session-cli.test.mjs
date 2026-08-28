import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_DIR } from "../src/platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ego-browser.mjs");

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("--cleanup-session is a safe no-op without an agent session", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ego-cleanup-cli-"));
  const stateRoot = join(sandbox, "state");
  const browserState = join(stateRoot, APP_DIR, "browser.json");
  const env = { ...process.env };
  for (const name of [
    "EGO_BROWSER_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "OMX_SESSION_ID",
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    EGO_LINUX_CDP_URL: "ws://127.0.0.1:1/cleanup-must-not-connect",
    EGO_LINUX_PROFILE: join(sandbox, "profile"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_STATE_HOME: stateRoot,
  });

  try {
    const result = await runCli(["--cleanup-session"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      session: null,
      spacesClosed: 0,
      spacesSkipped: 0,
      serversMatched: 0,
      serversSignaled: 0,
      serversStopped: 0,
      serverPids: [],
      serversRemaining: [],
      skipped: "no-session",
    });
    await assert.rejects(access(browserState), { code: "ENOENT" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("--cleanup-session stops an exact-session Next development server", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ego-cleanup-server-cli-"));
  const standIn = join(sandbox, "standin.mjs");
  const marker = `cleanup-cli-${process.pid}-${Date.now()}`;
  await writeFile(standIn, "setTimeout(() => {}, 60_000);\n");
  const env = {
    ...process.env,
    CODEX_THREAD_ID: marker,
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_STATE_HOME: join(sandbox, "state"),
    EGO_LINUX_PROFILE: join(sandbox, "profile"),
  };
  const server = spawn(
    process.execPath,
    [standIn, join(sandbox, "node_modules/next/dist/bin/next"), "dev"],
    { env, stdio: "ignore" },
  );
  await new Promise((resolve, reject) => {
    server.once("spawn", resolve);
    server.once("error", reject);
  });

  try {
    const result = await runCli(["--cleanup-session"], env);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.serversMatched, 1);
    assert.equal(receipt.serversSignaled, 1);
    assert.equal(receipt.serversStopped, 1);
    assert.deepEqual(receipt.serverPids, [server.pid]);
    assert.deepEqual(receipt.serversRemaining, []);
    await new Promise((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) resolve();
      else server.once("exit", resolve);
    });
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});
