import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { BROWSER_STATE_FILE, PROFILE_DIR, STATE_DIR } from "./paths.mjs";
import { acquireDirectoryLock } from "./launch-lock.mjs";
import {
  clearSingletonArtifacts,
  detachedSpawnOptions,
  listProcesses,
  processArgv,
  processIsAlive,
  readSingletonOwner,
  resolveBrowserBinary,
  terminateProcess,
} from "./platform.mjs";

// Chrome writes the negotiated port here once the DevTools endpoint is live.
const PORT_FILE = "DevToolsActivePort";
const BROWSER_LAUNCH_LOCK = join(STATE_DIR, "browser-launch.lock");

// Shared by the launch args and the orphan reaper that reads them back out of
// the process table — if the two spellings drifted, the reaper would match
// nothing.
const PROFILE_FLAG = "--user-data-dir=";

/**
 * Window class shared with the desktop entry's StartupWMClass.
 *
 * On Windows `--class` has no effect on the window — but Chrome still carries
 * it in its command line, and that is the other half of what this constant is
 * for: it is the marker that tells our browsers apart from the user's, which
 * the reaper and the profile-lock check both match on. So it is passed on both
 * platforms deliberately.
 */
export const WM_CLASS = "ego-lite-linux";

/** Shown in Chrome's profile chip so the agent window is identifiable. */
const PROFILE_LABEL = "ego lite — agent";

const LAUNCH_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  // Node's WebSocket sends no Origin; without this Chrome rejects the upgrade.
  "--remote-allow-origins=*",
  // Big enough that a page laid out for a desktop viewport fits. The default
  // headless window is ~800x600, which pushes lower page content out of view;
  // input dispatched at those coordinates hit-tests to nothing and
  // Input.dispatchMouseEvent can hang waiting for a frame that never comes.
  "--window-size=1280,900",
  // Without this the desktop's HiDPI scaling (1.5x here) shrinks the CSS
  // viewport — a 1280px window lays out as 853px — so page content the agent
  // expects on screen falls below the fold.
  "--force-device-scale-factor=1",
  // "Chrome didn't shut down correctly — Restore pages?". Two things keep it
  // away, covering different halves: the graceful Browser.close in stopBrowser()
  // stops the profile *earning* the mark, and clearStaleCrashMark() clears a
  // mark it already carries, which a clean exit alone never does. This flag is
  // the backstop for what neither covers — a browser killed by something outside
  // this launcher, between one launch's clear and the next.
  "--hide-crash-restore-bubble",
  // Give the agent browser its own window class. Without it the window carries
  // Chrome's, so the desktop groups it under the ordinary Chrome icon: it never
  // appears as its own running app and the launcher icon cannot raise it.
  // Paired with StartupWMClass in the desktop entry. On Windows it is inert as
  // a window hint and serves only as the ownership marker described on WM_CLASS.
  `--class=${WM_CLASS}`,
];

/**
 * Is this directory *provably* absent?
 *
 * A plain "could I stat it" collapses every failure into false — fine for
 * picking a browser binary (platform.mjs does exactly that), dangerous for
 * deciding whether to terminate a process. A transient ESTALE on NFS, an EIO,
 * or a FUSE timeout would read as
 * "profile deleted" and take a live browser down with it. Only ENOENT is
 * evidence of absence; every other error means "assume it is there".
 */
async function definitelyGone(path) {
  try {
    await access(path, constants.F_OK);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

/** Ask a running DevTools endpoint for its browser-level WebSocket URL. */
async function probe(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const info = await response.json();
    return info.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

async function readBrowserState() {
  try {
    return JSON.parse(await readFile(BROWSER_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeBrowserState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(BROWSER_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Poll for a DevTools endpoint that answers.
 *
 * The port file appears a beat after the process starts, and Chrome does not
 * necessarily write it once: a launch that loses the ProcessSingleton race is
 * restarted internally, and the process that survives publishes a different
 * port. Probing whatever the file said first therefore names a port that never
 * listens — so re-read it on every attempt and keep probing until one answers.
 */
export async function waitForEndpoint(profileDir, { timeoutMs = 20000 } = {}) {
  const path = join(profileDir, PORT_FILE);
  const deadline = Date.now() + timeoutMs;
  let lastPort = null;
  while (Date.now() < deadline) {
    let port = null;
    try {
      const [line] = (await readFile(path, "utf8")).split("\n");
      port = Number(line.trim()) || null;
    } catch {
      // not written yet
    }
    if (port) {
      lastPort = port;
      const wsUrl = await probe(port);
      if (wsUrl) return { port, wsUrl };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    lastPort
      ? `Chrome came up on port ${lastPort} but exposed no WebSocket URL within ${timeoutMs}ms`
      : `Chrome did not expose a DevTools port within ${timeoutMs}ms`,
  );
}

/**
 * Reset page zoom in the agent profile.
 *
 * --import-chrome-profile copies real Chrome preferences, which include the
 * user's zoom level. A 150% zoom lays a 1280px window out as 853 CSS px, so
 * content the page expects on screen falls below the fold — element coordinates
 * then hit-test to nothing and pointer input silently does nothing. This profile
 * exists only to drive agents, so zoom is pinned to 100%.
 */
async function neutralizeZoom(profileDir) {
  const path = join(profileDir, "Default", "Preferences");
  try {
    const prefs = JSON.parse(await readFile(path, "utf8"));
    let changed = false;
    for (const scope of ["partition", "profile"]) {
      for (const key of ["default_zoom_level", "per_host_zoom_levels"]) {
        if (prefs[scope]?.[key] && Object.keys(prefs[scope][key]).length > 0) {
          prefs[scope][key] = {};
          changed = true;
        }
      }
    }
    // --import-chrome-profile clones the user's real profile, so the agent
    // browser ends up looking exactly like their everyday Chrome — same
    // bookmarks, same theme, no way to tell which window an agent is driving.
    // Naming the profile puts a label in Chrome's own toolbar chip.
    if (prefs.profile?.name !== PROFILE_LABEL) {
      prefs.profile = { ...prefs.profile, name: PROFILE_LABEL };
      changed = true;
    }
    if (changed) await writeFile(path, JSON.stringify(prefs));
    return changed;
  } catch {
    // A fresh profile has no Preferences file yet; nothing to reset.
    return false;
  }
}

/**
 * Clear a stale crash mark before launching.
 *
 * Chrome stamps `profile.exit_type` "Crashed" while it runs and rewrites it to
 * "Normal" on a graceful exit — but only if it did not *start* out marked. Once
 * a profile carries the mark, Chrome keeps it until someone answers the
 * "Restore pages?" prompt, and in an agent browser nobody ever does. So a single
 * ungraceful kill marks a profile permanently: every later launch opens with the
 * prompt, and even a clean Browser.close leaves the mark exactly where it was.
 *
 * Established by bisecting a marked profile's Preferences against a fresh one,
 * top-level keys first and then within `profile`, down to this single key: seed
 * "Crashed" and the next clean stop still reads "Crashed"; seed anything else
 * and it reads "Normal".
 *
 * The mark exists to protect a human's tabs. This profile has none worth
 * restoring — the agent opens what it needs — so clearing it costs nothing.
 */
export async function clearStaleCrashMark(profileDir) {
  const path = join(profileDir, "Default", "Preferences");
  try {
    const prefs = JSON.parse(await readFile(path, "utf8"));
    if (!prefs.profile || prefs.profile.exit_type === "Normal") return false;
    prefs.profile = { ...prefs.profile, exit_type: "Normal" };
    await writeFile(path, JSON.stringify(prefs));
    return true;
  } catch {
    // A fresh profile has no Preferences file yet; nothing to clear.
    return false;
  }
}

/** Whether a pid is a browser running against our own profile directory. */
async function ownsOurProfile(pid, profileDir) {
  const argv = await processArgv(pid);
  return argv?.some((arg) => arg === `${PROFILE_FLAG}${profileDir}`) ?? false;
}

/**
 * Terminate ego browsers whose profile directory no longer exists.
 *
 * A harness that points EGO_LINUX_PROFILE (or XDG_DATA_HOME) at a scratch tree
 * gets a browser of its own, and browsers are spawned detached so they outlive
 * whatever started them. A harness that deletes its scratch tree without
 * stopping its browser first leaves that browser running against a profile
 * nobody can reach: ensureBrowser() tracks one browser per state file, so the
 * orphan is invisible to it and simply accumulates — hundreds of MB per stale
 * run, for as long as the machine stays up.
 *
 * A missing profile directory is the unambiguous signal. Chrome cannot function
 * without it, so such a browser is already dead weight rather than someone's
 * live session. Our own profile is created before this runs, which keeps the
 * browser we are about to launch — and any other live one — out of scope.
 *
 * @returns {Promise<number>} How many orphans were signalled.
 */
export async function reapOrphanedBrowsers() {
  const running = await listProcesses({ contains: `--class=${WM_CLASS}` });

  let reaped = 0;
  await Promise.all(
    running.map(async ({ pid, argv }) => {
      // Renderers and helpers inherit --user-data-dir but carry --type=;
      // signalling the browser process takes its children with it anyway.
      if (!argv.includes(`--class=${WM_CLASS}`)) return;
      if (argv.some((arg) => arg.startsWith("--type="))) return;

      const flag = argv.find((arg) => arg.startsWith(PROFILE_FLAG));
      if (!flag) return;
      const profileDir = flag.slice(PROFILE_FLAG.length);
      if (profileDir === PROFILE_DIR) return;
      if (!(await definitelyGone(profileDir))) return;

      if (await terminateProcess(pid)) reaped += 1;
    }),
  );
  return reaped;
}

/**
 * Clear the profile lock before launching.
 *
 * A browser that dies without exiting cleanly leaves its single-instance guard
 * behind, and the next launch refuses to start ("Failed to create a
 * ProcessSingleton ... Aborting now"). What that guard *is* differs by platform
 * — a symlink on POSIX, kernel objects on Windows — so finding its owner and
 * clearing its leftovers both live in platform.mjs.
 *
 * launch() only runs after ensureBrowser() has confirmed no DevTools endpoint
 * answers, so a lock owner that is still alive is an unreachable orphan of ours
 * — a browser we can no longer drive. Since this profile is single-purpose,
 * that orphan is terminated rather than left to block every future run.
 */
async function clearProfileLock(profileDir) {
  const pid = await readSingletonOwner(profileDir, {
    marker: `--class=${WM_CLASS}`,
  });
  if (pid === null) {
    // Nothing claims the profile. Clearing artifacts anyway is a no-op on a
    // clean profile and the fix on one holding a stale file.
    await clearSingletonArtifacts(profileDir);
    return false;
  }

  if (await ownsOurProfile(pid, profileDir)) {
    if (await terminateProcess(pid)) {
      // Give it a moment to release the lock on its own.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  await clearSingletonArtifacts(profileDir);
  return true;
}

async function launch({ headless }) {
  const binary = await resolveBrowserBinary();
  await mkdir(PROFILE_DIR, { recursive: true });
  // Ours now exists, so it cannot be mistaken for an orphan below.
  await reapOrphanedBrowsers();
  await neutralizeZoom(PROFILE_DIR);
  await clearStaleCrashMark(PROFILE_DIR);
  await clearProfileLock(PROFILE_DIR);
  // A stale port file would be read as this launch's port.
  await rm(join(PROFILE_DIR, PORT_FILE), { force: true });

  const args = [
    ...LAUNCH_FLAGS,
    `${PROFILE_FLAG}${PROFILE_DIR}`,
    "--remote-debugging-port=0",
    ...(headless ? ["--headless=new"] : []),
    // The harness attaches its CDP session to the active tab and fails with
    // "no active tab to attach session" when there is none, so the browser has
    // to come up holding one. --no-startup-window was tried here and breaks
    // every page operation for that reason.
    "about:blank",
  ];
  const child = spawn(binary, args, detachedSpawnOptions());
  child.unref();

  const { port, wsUrl } = await waitForEndpoint(PROFILE_DIR);
  await writeBrowserState({
    port,
    wsUrl,
    pid: child.pid,
    binary,
    headless,
    profileDir: PROFILE_DIR,
  });
  return { port, wsUrl, launched: true };
}

/**
 * Return a live browser-level CDP endpoint, reusing the browser this machine
 * already has open when possible. Each heredoc runs in its own short-lived Node
 * process, so the browser — not this process — is what has to persist.
 */
export async function ensureBrowser({ headless = false } = {}) {
  if (process.env.EGO_LINUX_CDP_URL) {
    return { wsUrl: process.env.EGO_LINUX_CDP_URL, launched: false };
  }

  async function runningBrowser() {
    const state = await readBrowserState();
    if (!state?.port) return null;
    const wsUrl = await probe(state.port);
    return wsUrl ? { port: state.port, wsUrl, launched: false } : null;
  }

  const existing = await runningBrowser();
  if (existing) return existing;

  // Several agents commonly start together. Without serializing this gap, each
  // process observes no published state and invokes Chrome; ProcessSingleton
  // folds those invocations into one profile but still opens their about:blank
  // requests as extra windows/tabs. Re-check after acquiring the kernel-owned
  // lock so only its owner launches and every waiter reuses the published CDP.
  const release = await acquireDirectoryLock(BROWSER_LAUNCH_LOCK);
  try {
    const winner = await runningBrowser();
    if (winner) return winner;
    return await launch({ headless });
  } finally {
    await release();
  }
}

/**
 * Ask the browser to close itself, over CDP.
 *
 * Termination by pid is recorded by Chrome as a crash: the profile keeps `exit_type:
 * "Crashed"`, and every later launch greets the user with "Chrome didn't shut
 * down correctly — Restore pages?". Browser.close is the graceful path, so the
 * profile records a clean exit and there is nothing left to restore.
 */
async function closeBrowserGracefully(port, timeoutMs = 5000) {
  const wsUrl = await probe(port);
  if (!wsUrl) return false;

  return new Promise((resolve) => {
    let socket = null;
    let sent = false;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closing
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      socket = new WebSocket(wsUrl);
    } catch {
      finish(false);
      return;
    }
    socket.onopen = () => {
      sent = true;
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    };
    // Chrome answers and then drops the socket as it goes away; whichever lands
    // first means the request was taken. A close *before* the request went out
    // is a failed connection, not a shutdown.
    socket.onmessage = () => finish(true);
    socket.onclose = () => finish(sent);
    socket.onerror = () => finish(false);
  });
}

/** Wait for a pid to disappear — a browser still exiting still holds the profile lock. */
async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Terminate the backing browser and forget it. */
export async function stopBrowser() {
  const state = await readBrowserState();
  let stopped = false;

  if (state?.port) stopped = await closeBrowserGracefully(state.port);
  // Answering the request is not the same as acting on it. A browser that
  // stayed up has to be signalled anyway — otherwise --stop removes the state
  // file that is the only handle on it and leaves it running, unreachable.
  if (stopped && state?.pid && !(await waitForProcessExit(state.pid)))
    stopped = false;

  // The blunt instrument, only when the browser did not take the polite request.
  if (!stopped && state?.pid) stopped = await terminateProcess(state.pid);

  await rm(BROWSER_STATE_FILE, { force: true });
  // A force-terminated Chrome does not always release its profile lock, which
  // would block the next launch. After a graceful close there is nothing left
  // to clear, and this is a no-op.
  await clearProfileLock(PROFILE_DIR);
  return stopped;
}

export async function browserStatus() {
  const state = await readBrowserState();
  if (!state?.port) return { running: false };
  const wsUrl = await probe(state.port);
  return wsUrl
    ? { running: true, ...state, wsUrl }
    : { running: false, ...state };
}
