import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-profile-launch-safety-"));
const PROFILE = join(SANDBOX, "profile");
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_PROFILE = PROFILE;

const chrome = await import("../src/chrome.mjs");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "profile preparation refuses an unrecognized live lock owner before editing Preferences",
  { skip: process.platform === "win32" },
  async () => {
    const preferences = join(PROFILE, "Default", "Preferences");
    await mkdir(join(PROFILE, "Default"), { recursive: true });
    const original = JSON.stringify({
      partition: { default_zoom_level: 1.5 },
      profile: { exit_type: "Crashed", name: "Personal" },
    });
    await writeFile(preferences, original);
    const standin = join(SANDBOX, "foreign-owner.mjs");
    await writeFile(standin, "setTimeout(() => {}, 60_000);\n");
    const foreign = spawn(
      process.execPath,
      [standin, `--user-data-dir=${PROFILE}`],
      { stdio: "ignore" },
    );
    await new Promise((resolve, reject) => {
      foreign.once("spawn", resolve);
      foreign.once("error", reject);
    });
    await symlink(
      `${hostname()}-${foreign.pid}`,
      join(PROFILE, "SingletonLock"),
    );

    try {
      assert.equal(typeof chrome.prepareProfileForLaunch, "function");
      await assert.rejects(
        () => chrome.prepareProfileForLaunch(PROFILE),
        /not a managed Ego Lite browser/,
      );
      assert.equal(await readFile(preferences, "utf8"), original);
      assert.equal(alive(foreign.pid), true);
    } finally {
      foreign.kill("SIGKILL");
      await rm(SANDBOX, { recursive: true, force: true });
    }
  },
);
