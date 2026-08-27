import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "fixture", "browser-launch-worker.mjs");
const BIN = join(HERE, "..", "bin", "ego-browser.mjs");

const {
  browserLaunchEnvironment,
  browserStartupFlags,
  unsafeBrowserLaunchFlags,
} = await import("../src/chrome.mjs");
const { APP_DIR, browserDisplayFlags } = await import("../src/platform.mjs");

it("does not inherit desktop activation into the managed browser", () => {
  const env = browserLaunchEnvironment({
    KEEP: "yes",
    DESKTOP_STARTUP_ID: "gnome-shell/kitty/example",
    XDG_ACTIVATION_TOKEN: "token",
  });
  assert.deepEqual(env, { KEEP: "yes" });
});

it("rejects network and web-security weakening flags on a profile browser", () => {
  assert.deepEqual(
    unsafeBrowserLaunchFlags([
      "/opt/google/chrome/chrome",
      "--class=ego-lite-linux",
      "--host-resolver-rules=MAP analytics.google.com 216.239.36.181",
    ]),
    ["--host-resolver-rules"],
  );
  assert.deepEqual(
    unsafeBrowserLaunchFlags([
      "/opt/google/chrome/chrome --class=ego-lite-linux " +
        "--ignore-certificate-errors --disable-web-security about:blank",
    ]),
    ["--ignore-certificate-errors", "--disable-web-security"],
  );
  assert.deepEqual(
    unsafeBrowserLaunchFlags([
      "/opt/google/chrome/chrome",
      "--class=ego-lite-linux",
      "--remote-debugging-address=127.0.0.1",
    ]),
    [],
  );
  assert.deepEqual(
    unsafeBrowserLaunchFlags([
      "/opt/google/chrome/chrome",
      "--remote-debugging-address=0.0.0.0",
    ]),
    ["--remote-debugging-address"],
  );
});

it("starts headed Chrome without mapping a focus-stealing bootstrap window", () => {
  assert.deepEqual(browserStartupFlags(), ["--no-startup-window"]);
  assert.deepEqual(browserStartupFlags({ headless: true }), [
    "--headless=new",
    "about:blank",
  ]);
});

it("uses XWayland for a headed browser on a Wayland desktop", () => {
  assert.deepEqual(
    browserDisplayFlags({
      env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":1" },
      platform: "linux",
    }),
    ["--ozone-platform=x11"],
  );
  assert.deepEqual(
    browserDisplayFlags({
      headless: true,
      env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":1" },
      platform: "linux",
    }),
    [],
  );
});

it("allows an explicit native Wayland override", () => {
  assert.deepEqual(
    browserDisplayFlags({
      env: {
        XDG_SESSION_TYPE: "wayland",
        DISPLAY: ":1",
        EGO_LINUX_WINDOW_BACKEND: "wayland",
      },
      platform: "linux",
    }),
    ["--ozone-platform=wayland"],
  );
});

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
      assert.ok(
        endpoints.every((endpoint) => endpoint.port > 0),
        "the browser uses a non-zero debugging port",
      );
      if (process.platform !== "win32") {
        const stateDir = join(env.XDG_STATE_HOME, APP_DIR);
        assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
        assert.equal(
          (await stat(join(stateDir, "browser.json"))).mode & 0o777,
          0o600,
        );
      }
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

it(
  "agents with different state roots still reuse one shared profile browser",
  { timeout: 60_000 },
  async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ego-browser-cross-state-"));
    const common = {
      ...process.env,
      EGO_LINUX_HEADLESS: "1",
      EGO_LINUX_PROFILE: join(sandbox, "profile"),
      XDG_DATA_HOME: join(sandbox, "data"),
    };
    delete common.EGO_LINUX_CDP_URL;
    const firstEnv = {
      ...common,
      XDG_STATE_HOME: join(sandbox, "state-a"),
    };
    const secondEnv = {
      ...common,
      XDG_STATE_HOME: join(sandbox, "state-b"),
    };

    try {
      const first = JSON.parse(await runNode(WORKER, [], firstEnv));
      const second = JSON.parse(await runNode(WORKER, [], secondEnv));
      assert.equal(first.launched, true);
      assert.equal(
        second.launched,
        false,
        "a second state root must discover the browser already owning the profile",
      );
      assert.equal(second.port, first.port);
      assert.equal(second.pid, first.pid);
    } finally {
      await runNode(BIN, ["--stop"], secondEnv).catch(() => {});
      await runNode(BIN, ["--stop"], firstEnv).catch(() => {});
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
