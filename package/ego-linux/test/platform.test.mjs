import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activateWindowByClass,
  activateWindowById,
  captureDesktopFocus,
  createPlatform,
  getActiveWindow,
  restoreDesktopFocus,
} from "../src/platform.mjs";

/**
 * A process that sits still and carries the argv a case wants to read back.
 *
 * It has to be a script file, not `node -e`: node parses a trailing
 * `--class=...` as one of its own options and exits with "bad option", so the
 * marker never reaches the process table and the case measures nothing.
 */
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-platform-standin-"));
const STANDIN = join(SANDBOX, "standin.mjs");
await writeFile(STANDIN, "setTimeout(() => {}, 60_000);\n");
after(() => rm(SANDBOX, { recursive: true, force: true }));

async function standInWith({ args = [], env = process.env } = {}) {
  const child = spawn(process.execPath, [STANDIN, ...args], {
    env,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

async function standIn(...args) {
  return standInWith({ args });
}

/** Wait for a child to be gone, without hanging if it already is. */
function reaped(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise((resolve) => child.once("exit", resolve));
}

/**
 * The Windows branch, exercised from Linux.
 *
 * createPlatform() takes the platform and the environment as arguments, so the
 * branch this machine cannot run is reachable without touching a global. That
 * is how a Linux CI job proves the Windows paths are right; running them
 * against a real browser still needs Windows, which the README says plainly.
 */
const WINDOWS_ENV = {
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
  APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
  PROGRAMFILES: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
};

const windows = (env = {}) =>
  createPlatform({ platform: "win32", env: { ...WINDOWS_ENV, ...env } });
const linux = (env = {}) => createPlatform({ platform: "linux", env });
/** This machine, for the cases that talk to real processes and real files. */
const here = () => createPlatform();

describe("platform: state and data roots", () => {
  it("puts Windows state under %LOCALAPPDATA%", () => {
    const platform = windows();
    assert.equal(platform.IS_WINDOWS, true);
    assert.equal(platform.dataRoot(), "C:\\Users\\dev\\AppData\\Local");
    assert.equal(platform.stateRoot(), "C:\\Users\\dev\\AppData\\Local");
  });

  it("keeps the Linux directory name so existing profiles are not orphaned", () => {
    assert.equal(
      linux().APP_DIR,
      "ego-lite-linux",
      "renaming this would strand every installed profile and its logins",
    );
    assert.equal(
      windows().APP_DIR,
      "ego-lite",
      "Windows has no such history and gets the honest name",
    );
  });

  it("splits data from state on Linux the way XDG does", () => {
    const platform = linux();
    assert.match(platform.dataRoot(), /\.local\/share$/);
    assert.match(platform.stateRoot(), /\.local\/state$/);
  });

  it("lets XDG variables redirect both platforms, which is what the suites rely on", () => {
    const redirect = { XDG_STATE_HOME: "/sb/state", XDG_DATA_HOME: "/sb/data" };
    for (const platform of [windows(redirect), linux(redirect)]) {
      assert.equal(platform.stateRoot(), "/sb/state");
      assert.equal(platform.dataRoot(), "/sb/data");
    }
  });

  it("reads the environment live, so a harness can redirect state after import", () => {
    // paths.mjs resolves at import time and every suite in test/ assigns
    // XDG_STATE_HOME just before importing it. A snapshot taken here instead
    // would silently point those suites at the developer's real profile.
    const env = {};
    const platform = createPlatform({ platform: "linux", env });
    env.XDG_STATE_HOME = "/sandbox/state";
    assert.equal(platform.stateRoot(), "/sandbox/state");
  });
});

describe("platform: finding a browser", () => {
  const CHROME_EXE =
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

  it("looks where Windows actually installs Chrome and Edge", () => {
    const candidates = windows().browserBinaryCandidates();
    assert.ok(
      candidates.includes(CHROME_EXE),
      `the default Chrome install path is tried; got ${JSON.stringify(candidates)}`,
    );
    assert.ok(
      candidates.some((c) => c.endsWith("msedge.exe")),
      "Edge is the one browser guaranteed to be present on Windows",
    );
    assert.ok(
      candidates.indexOf(CHROME_EXE) <
        candidates.findIndex((c) => c.endsWith("msedge.exe")),
      "Chrome is preferred over Edge, matching the Linux order",
    );
  });

  it("honours EGO_LINUX_CHROME first on both platforms", () => {
    assert.equal(
      windows({
        EGO_LINUX_CHROME: "D:\\portable\\chrome.exe",
      }).browserBinaryCandidates()[0],
      "D:\\portable\\chrome.exe",
    );
    assert.equal(
      linux({
        EGO_LINUX_CHROME: "/opt/chrome/chrome",
      }).browserBinaryCandidates()[0],
      "/opt/chrome/chrome",
    );
  });

  it("resolves an absolute candidate that exists, and skips one that does not", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ego-platform-"));
    const real = join(sandbox, "chrome");
    await writeFile(real, "");
    try {
      // This machine's platform, not a faked one: the path comes from the real
      // filesystem, and asking the POSIX branch to recognise `C:\...` as
      // absolute is a question about the test, not about the code.
      const platform = createPlatform({ env: { EGO_LINUX_CHROME: real } });
      assert.equal(await platform.resolveBrowserBinary(), real);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("names what it tried when there is no browser at all", async () => {
    // Absolute and non-existent, so no PATH lookup can rescue it.
    const nowhere = createPlatform({
      platform: "win32",
      env: {
        LOCALAPPDATA: "Z:\\nowhere",
        PROGRAMFILES: "Z:\\nowhere",
        "PROGRAMFILES(X86)": "Z:\\nowhere",
      },
    });
    await assert.rejects(
      () => nowhere.resolveBrowserBinary(),
      (error) => {
        assert.match(error.message, /no Chrome\/Chromium binary found/);
        assert.match(error.message, /EGO_LINUX_CHROME/);
        return true;
      },
    );
  });

  it("points at the Windows profile directories logins can be imported from", () => {
    const dirs = windows().stockBrowserProfileDirs();
    assert.ok(
      dirs.includes(
        "C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\User Data",
      ),
      // The importer copies `<dir>/Default`, which only exists under
      // `User Data` — pointing one level off would silently import nothing.
      `Chrome's Windows profile root; got ${JSON.stringify(dirs)}`,
    );
    assert.ok(dirs.some((d) => d.includes("Microsoft\\Edge")));
  });
});

describe("platform: reading a Windows command line", () => {
  const { splitCommandLine } = windows();

  it("keeps a quoted path with spaces in one argument", () => {
    assert.deepEqual(
      splitCommandLine(
        '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ' +
          '--user-data-dir="C:\\Users\\dev\\AppData\\Local\\ego lite\\profile" ' +
          "--class=ego-lite-linux --remote-debugging-port=0",
      ),
      [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "--user-data-dir=C:\\Users\\dev\\AppData\\Local\\ego lite\\profile",
        "--class=ego-lite-linux",
        "--remote-debugging-port=0",
      ],
    );
  });

  it("produces the exact strings the reaper matches on", () => {
    const argv = splitCommandLine(
      "chrome.exe --type=renderer --user-data-dir=C:\\p --class=ego-lite-linux",
    );
    // These three predicates are chrome.mjs's reaper, verbatim. A trailing \r
    // or a merged token would fail every one of them.
    assert.ok(argv.includes("--class=ego-lite-linux"));
    assert.ok(argv.some((arg) => arg.startsWith("--type=")));
    assert.equal(
      argv
        .find((arg) => arg.startsWith("--user-data-dir="))
        ?.slice("--user-data-dir=".length),
      "C:\\p",
    );
  });

  it("collapses runs of whitespace rather than emitting empty arguments", () => {
    assert.deepEqual(splitCommandLine("  a   b\tc  "), ["a", "b", "c"]);
    assert.deepEqual(splitCommandLine(""), []);
  });

  it("keeps an empty quoted argument, which is not the same as no argument", () => {
    assert.deepEqual(splitCommandLine('a "" b'), ["a", "", "b"]);
  });
});

describe("platform: process control", () => {
  it("reports this process as alive and a reserved pid as not", () => {
    const platform = here();
    assert.equal(platform.processIsAlive(process.pid), true);
    assert.equal(platform.processIsAlive(0), false);
    assert.equal(platform.processIsAlive(-1), false);
    assert.equal(platform.processIsAlive(Number.NaN), false);
  });

  it("refuses to signal a pid that is not one", async () => {
    // Guards the taskkill path: `taskkill /PID NaN` would be a real command
    // running against an unpredictable argument.
    const platform = windows();
    assert.equal(await platform.terminateProcess(0), false);
    assert.equal(await platform.terminateProcess(-5), false);
    assert.equal(await platform.terminateProcess(1.5), false);
  });

  it(
    "finds only processes carrying an exact session environment value",
    { skip: process.platform === "win32" && "procfs ownership proof is POSIX-only" },
    async () => {
      const marker = `ego-session-${process.pid}-${Date.now()}`;
      const child = await standInWith({
        args: ["--ego-session-owned"],
        env: { ...process.env, CODEX_THREAD_ID: marker },
      });

      try {
        const found = await here().listProcessesByEnvironment({
          names: ["CODEX_THREAD_ID", "OMX_SESSION_ID"],
          value: marker,
        });
        assert.deepEqual(
          found.map((entry) => entry.pid),
          [child.pid],
        );
        assert.ok(found[0].argv.includes("--ego-session-owned"));
      } finally {
        child.kill("SIGKILL");
        await reaped(child);
      }
    },
  );

  it("terminates a real process and reports it, on whatever this machine is", async () => {
    const platform = here();
    const child = await standIn();

    assert.equal(await platform.terminateProcess(child.pid), true);
    await reaped(child);
    assert.equal(platform.processIsAlive(child.pid), false);
  });
});

describe("platform: the profile's single-instance guard", () => {
  it(
    "reads the owner out of the POSIX SingletonLock symlink",
    {
      // Creating a symlink on Windows needs Developer Mode or an elevated shell,
      // and this case is about the branch Windows never takes anyway.
      skip:
        process.platform === "win32" &&
        "POSIX-only: Windows Chrome guards the profile with a mutex, not a link",
    },
    async () => {
      const sandbox = await mkdtemp(join(tmpdir(), "ego-singleton-"));
      await symlink("somehost-4242", join(sandbox, "SingletonLock"));
      try {
        assert.equal(await linux().readSingletonOwner(sandbox), 4242);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    },
  );

  it("reports no owner when there is no lock", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ego-singleton-"));
    try {
      assert.equal(await linux().readSingletonOwner(sandbox), null);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("clears the artifacts each platform actually leaves behind", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ego-singleton-"));
    for (const name of [
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
      "lockfile",
    ]) {
      await writeFile(join(sandbox, name), "");
    }

    try {
      await linux().clearSingletonArtifacts(sandbox);
      assert.deepEqual(
        await readdir(sandbox),
        ["lockfile"],
        "POSIX clears the three Singleton links and nothing else",
      );

      await windows().clearSingletonArtifacts(sandbox);
      assert.deepEqual(
        await readdir(sandbox),
        [],
        "Windows keeps its singleton in kernel objects; only lockfile is on disk",
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("platform: detached spawn options", () => {
  it("hides the console window Windows would otherwise flash on screen", () => {
    const options = windows().detachedSpawnOptions();
    assert.equal(options.detached, true);
    assert.equal(options.stdio, "ignore");
    assert.equal(
      options.windowsHide,
      true,
      "without this every heredoc pops a black rectangle on the user's desktop",
    );
  });

  it("lets a caller add to the options without losing them", () => {
    const options = linux().detachedSpawnOptions({ cwd: "/tmp" });
    assert.equal(options.cwd, "/tmp");
    assert.equal(options.detached, true);
  });
});

describe("platform: explicit X11 window activation", () => {
  it("reads the active X11 window and its owning pid", async () => {
    const calls = [];
    const run = async (_command, args) => {
      calls.push(args);
      if (args[0] === "getactivewindow") {
        return { ok: true, stdout: "77\n", stderr: "" };
      }
      return { ok: true, stdout: "4242\n", stderr: "" };
    };

    assert.deepEqual(
      await getActiveWindow(
        { env: { DISPLAY: ":1" }, platform: "linux" },
        { run },
      ),
      { windowId: "77", pid: 4242 },
    );
    assert.deepEqual(calls, [["getactivewindow"], ["getwindowpid", "77"]]);
  });

  it("restores one exact X11 window without searching by class", async () => {
    const calls = [];
    const run = async (_command, args) => {
      calls.push(args);
      return { ok: true, stdout: "", stderr: "" };
    };

    assert.equal(
      await activateWindowById(
        { windowId: "77", env: { DISPLAY: ":1" }, platform: "linux" },
        { run },
      ),
      true,
    );
    assert.deepEqual(calls, [["windowactivate", "--sync", "77"]]);
  });

  it("captures native Wayland focus as compositor history", async () => {
    const run = async () => ({ ok: false, stdout: "", stderr: "no X window" });

    assert.deepEqual(
      await captureDesktopFocus(
        {
          env: { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-0" },
          platform: "linux",
        },
        { run },
      ),
      { kind: "wayland-history", windowId: null, pid: null },
    );
  });

  it("uses one compositor-level previous-window shortcut for native Wayland", async () => {
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      return { ok: true, stdout: "", stderr: "" };
    };

    assert.equal(
      await restoreDesktopFocus(
        { kind: "wayland-history", windowId: null, pid: null },
        {
          env: { WAYLAND_DISPLAY: "wayland-0" },
          platform: "linux",
        },
        { run },
      ),
      true,
    );
    assert.deepEqual(calls, [["ydotool", "key", "alt+tab"]]);
  });

  it("activates only a visible window owned by the requested browser pid", async () => {
    const calls = [];
    const run = async (_command, args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key === "search --onlyvisible --class ego-lite-linux") {
        return { ok: true, stdout: "11\n22\n", stderr: "" };
      }
      if (key === "getwindowpid 11") {
        return { ok: true, stdout: "999\n", stderr: "" };
      }
      if (key === "getwindowpid 22") {
        return { ok: true, stdout: "4242\n", stderr: "" };
      }
      if (key === "windowactivate 22") {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (key === "getactivewindow") {
        return { ok: true, stdout: "33\n", stderr: "" };
      }
      if (key === "getwindowpid 33") {
        return { ok: true, stdout: "4242\n", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unexpected" };
    };

    assert.equal(
      await activateWindowByClass(
        {
          wmClass: "ego-lite-linux",
          pid: 4242,
          env: { DISPLAY: ":1" },
          platform: "linux",
        },
        { run, sleep: async () => {} },
      ),
      true,
    );
    assert.ok(calls.some((args) => args.join(" ") === "windowactivate 22"));
    assert.ok(!calls.some((args) => args.join(" ") === "windowactivate 11"));
  });

  it("does nothing without an X11 display", async () => {
    let called = false;
    assert.equal(
      await activateWindowByClass(
        { wmClass: "ego-lite-linux", pid: 4242, env: {}, platform: "linux" },
        {
          run: async () => {
            called = true;
            return { ok: true, stdout: "" };
          },
        },
      ),
      false,
    );
    assert.equal(called, false);
  });
});

describe("platform: reading the process table", () => {
  it("finds this process's own argv, on whatever this machine is", async () => {
    const argv = await here().processArgv(process.pid);
    assert.ok(Array.isArray(argv), "the current process is readable");
    assert.ok(
      argv.some((arg) => arg.includes("node")),
      `expected the node binary in ${JSON.stringify(argv)}`,
    );
  });

  it("returns null for a process that is not there", async () => {
    // Above every default pid_max, so it cannot be a live process.
    assert.equal(await here().processArgv(4_194_304), null);
  });

  it("matches only processes carrying the marker", async () => {
    assert.deepEqual(
      await here().listProcesses({
        contains: "ego-platform-marker-that-matches-nothing",
      }),
      [],
    );
  });

  it("finds a process by a string in its argv and splits that argv", async () => {
    const platform = here();
    const marker = `--class=ego-platform-probe-${process.pid}`;
    const child = await standIn(marker);

    try {
      const found = await platform.listProcesses({ contains: marker });
      const mine = found.find((entry) => entry.pid === child.pid);
      assert.ok(
        mine,
        `expected pid ${child.pid} among ${JSON.stringify(found)}`,
      );
      assert.ok(
        mine.argv.includes(marker),
        "the argv is split into the exact tokens the reaper compares against",
      );
    } finally {
      child.kill("SIGKILL");
      await reaped(child);
    }
  });
});

describe("platform: process ancestry", () => {
  it("names this process's own chain, nearest first", () => {
    const names = here().processAncestry();
    assert.ok(Array.isArray(names));
    assert.ok(names.length > 0, "at least this process is in its own ancestry");
    assert.ok(
      names.every((name) => typeof name === "string" && name.length > 0),
      `expected plain names, got ${JSON.stringify(names)}`,
    );
    assert.ok(
      names.every((name) => !/\.(exe|com|bat|cmd)$/i.test(name)),
      "extensions are stripped so one harness table serves both platforms",
    );
  });

  it("honours the depth limit", () => {
    const platform = here();
    assert.ok(platform.processAncestry(1).length <= 1);
    assert.ok(platform.processAncestry(2).length <= 2);
  });
});
