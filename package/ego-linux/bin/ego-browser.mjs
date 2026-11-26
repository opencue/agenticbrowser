#!/usr/bin/env node
/**
 * ego-browser, stock-Chromium port for Linux and Windows.
 *
 * Same CLI shape as the macOS app's `ego-browser`: a heredoc of JS on stdin,
 * executed with every ego-browser helper preloaded. The difference is what backs
 * it — `globalThis.ego` is this port's CDP shim over a stock Chromium instead of
 * the app's native bindings. Everything above that line is the upstream harness,
 * unmodified.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";

import { agentIdentity } from "../src/agent-identity.mjs";
import { cleanupExpiredArtifacts } from "../src/artifact-retention.mjs";
import { acquireLaunchLock } from "../src/launch-lock.mjs";
import { availableMemoryMb, isLowMemory } from "../src/low-memory.mjs";
import {
  CHROME_CONFIG_CANDIDATES,
  PROFILE_DIR,
  SPACES_STATE_FILE,
  TASK_SPACE_FILE,
  STATE_DIR,
} from "../src/paths.mjs";
import { detachedSpawnOptions, terminateProcess } from "../src/platform.mjs";
import {
  ensurePrivateStateDir,
  writePrivateStateFile,
} from "../src/private-state.mjs";
import { runtimeBuildId } from "../src/runtime-version.mjs";
import {
  browserInstanceKey,
  pinRuntimeInstance,
} from "../src/runtime-instance.mjs";
import { stopSessionDevServers } from "../src/session-cleanup.mjs";

// Upstream's v2 page-model runtime, the only runtime.
const HARNESS_V2 = new URL(
  "../../ego-browser-v2/dist/out/index.js",
  import.meta.url,
);
const V2_EXTENSIONS = new URL(
  "../../ego-v2-ext/src/index.mjs",
  import.meta.url,
);
const SKILL_WORKSPACE = new URL("../../../skills/ego-browser", import.meta.url);
const SPACES_LAUNCH_LOCK = join(STATE_DIR, "spaces-launch.lock");

// Phase 1 is the default after its persistence, API, focus, and UI checks pass.
// Keep a local kill switch for diagnosis without maintaining a second build.
process.env.EGO_LINUX_COLLABORATION_INBOX ??= "1";

// A cold desktop launch delegates to the daemon. Only the process that
// actually talks to Chromium needs the CDP shim and its dependencies.
async function createEgoShim(options) {
  const { createEgoShim: createShim } = await import("../src/shim.mjs");
  return createShim(options);
}

const USAGE = `ego-browser (Linux and Windows port)

  ego-browser nodejs <<'JS'
  const task = await taskSpace('demo')
  const page = task.page('p1')
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS

  ego-browser nodejs -e '<code>'   the same, with the script as one argument
  ego-browser nodejs < task.mjs    the same, from a file

Scripts run on the v2 TaskSpace/Page runtime plus the port's extensions
(locators, fastObserve/fastAct, debug, requestUserAction, ...); see
\`ego-browser skill\`.

  skill                     print the ego-browser usage guide (SKILL.md)

Port commands:
  --doctor [--json]         inspect installation and runtime state without
                            starting or attaching to the browser
  --status                  show the backing browser's connection state
  --cleanup-session         close this agent session's spaces and stop its
                            recognised Next, Vite, and React dev servers
  --open                    open the shared agent browser window
  --spaces                  open the Spaces overview panel
  --prewarm-spaces          prepare Spaces without opening a window
  --launch [url|file ...]   open each page in a tab of the shared window and
                            raise it; with none, the Spaces overview. The
                            desktop entry uses it, so xdg-open works
  --prune-spaces            close spaces that hold nothing but about:blank
                            Two sweeps do this on their own. A space that never
                            loads a page is closed 120 seconds after it opens —
                            that is the ready anchor appearing and vanishing
                            when a run stops before navigating. A space that
                            did work is closed after 30 minutes without its
                            session coming back. Either closure is listed by
                            name for whoever asks for it again. Set
                            EGO_LINUX_SPACE_ABANDONED_SEC or
                            EGO_LINUX_SPACE_IDLE_MIN to change a window, or
                            0 to sweep only by hand
  --stop                    stop the backing browser
  --import-chrome-profile   copy your real Chrome profile in, to inherit logins
  --install-desktop-entry   add it to your app launcher, with an icon
  --headless                run the backing browser headless (first launch only)
                            EGO_LINUX_HEADLESS=1 makes that the default, so the
                            agent window never opens over your work; --open
                            still gives you a visible one when you want it
                            With EGO_LINUX_HEADLESS unset, a launch with less
                            than EGO_LINUX_LOW_MEMORY_MB (default 4096, 0 = off)
                            of available memory is headless and trimmed
`;

async function importChromeProfile() {
  const source = CHROME_CONFIG_CANDIDATES.find((candidate) =>
    existsSync(join(candidate, "Default")),
  );
  if (!source) {
    process.stderr.write("no Chrome/Chromium profile found to import\n");
    return 1;
  }
  const { browserStatus } = await import("../src/chrome.mjs");
  const status = await browserStatus();
  if (status.running) {
    process.stderr.write(
      "the backing browser is running; run --stop and close it before importing\n",
    );
    return 1;
  }
  process.stderr.write(
    `importing ${join(source, "Default")} -> ${PROFILE_DIR}/Default\n`,
  );
  await cp(join(source, "Default"), join(PROFILE_DIR, "Default"), {
    recursive: true,
    force: true,
  });
  process.stderr.write(
    "done — logins and cookies now carry into agent tasks\n",
  );
  return 0;
}

// The desktop launcher makes only short local requests. node:http avoids
// initializing fetch's HTTP stack on every click and doesn't follow redirects.
async function spacesRequest(state, path, method, timeoutMs) {
  const response = await new Promise((resolve, reject) => {
    const pending = request(
      {
        hostname: "127.0.0.1",
        port: state.port,
        path,
        method,
        headers: state.shutdownToken
          ? { "x-ego-daemon-token": state.shutdownToken }
          : {},
        signal: AbortSignal.timeout(timeoutMs),
      },
      resolve,
    );
    pending.on("error", reject);
    pending.end();
  });
  const status = response.statusCode;
  const body = await text(response);
  return { status, body, ok: status >= 200 && status < 300 };
}

/** Is a Spaces server already listening on the recorded port? */
async function liveSpacesServer(expectedBuildId = null) {
  try {
    const state = JSON.parse(await readFile(SPACES_STATE_FILE, "utf8"));
    if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535)
      return null;
    const response = await spacesRequest(state, "/api/health", "GET", 1500);
    if (!response.ok) return null;
    const health = JSON.parse(response.body);
    if (health?.ok !== true) return null;
    return {
      ...state,
      health,
      current: !expectedBuildId || health.buildId === expectedBuildId,
    };
  } catch {
    return null;
  }
}

/** Stop only the daemon that answered the state file's verified health probe. */
async function stopSpacesDaemon(state) {
  if (state.shutdownToken) {
    const response = await spacesRequest(state, "/api/shutdown", "POST", 2000);
    if (!response.ok) {
      throw new Error(`Spaces daemon refused restart (${response.status})`);
    }
  } else if (Number.isInteger(state.pid) && state.pid > 1) {
    // One-time migration path for daemons started before the authenticated
    // shutdown route existed. A successful health probe tied this pid and port
    // to our state record before this function was called.
    if (!(await terminateProcess(state.pid))) {
      throw new Error("Legacy Spaces daemon could not be stopped");
    }
  } else {
    throw new Error("Spaces daemon has no safe shutdown handle");
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!(await liveSpacesServer())) return;
  }
  throw new Error("Spaces daemon did not stop within 5000ms");
}

function spacesPanelUrl(port, shutdownToken) {
  if (!shutdownToken) throw new Error("Spaces daemon has no access token");
  return (
    `http://127.0.0.1:${port}/` + `#token=${encodeURIComponent(shutdownToken)}`
  );
}

function panelDocumentUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function isSpacesTarget(target, url) {
  return (
    target.type === "page" &&
    panelDocumentUrl(target.url) === panelDocumentUrl(url)
  );
}

async function trackedTaskTargets() {
  try {
    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    return new Set(
      (state.spaces || []).flatMap((space) => space.targetIds || []),
    );
  } catch {
    return new Set();
  }
}

/** Open or raise the one Spaces tab in the shared agent browser window. */
async function openPanelTab(url, shim, { recreate = false } = {}) {
  async function targets() {
    const { targetInfos = [] } = await shim.cdp.call("Target.getTargets");
    return targetInfos;
  }

  let targetInfos = await targets();
  let target = recreate
    ? null
    : targetInfos.find((candidate) => isSpacesTarget(candidate, url));
  for (const candidate of targetInfos) {
    if (!isSpacesTarget(candidate, url)) continue;
    if (candidate.targetId === target?.targetId) continue;
    await shim.cdp
      .call("Target.closeTarget", { targetId: candidate.targetId })
      .catch(() => {});
  }

  if (!target) {
    const { targetId } = await shim.cdp.call("Target.createTarget", { url });
    target = { targetId, type: "page", url };
  }

  const targetId = target.targetId;
  await shim.cdp.call("Target.activateTarget", { targetId }).catch(() => {});
  try {
    const { windowId } = await shim.cdp.call("Browser.getWindowForTarget", {
      targetId,
    });
    const { bounds } = await shim.cdp.call("Browser.getWindowBounds", {
      windowId,
    });
    if (bounds?.windowState === "minimized") {
      await shim.cdp.call("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
    }
  } catch {
    // Raising is best-effort on compositors that reject window bounds changes.
  }

  let sessionId;
  try {
    ({ sessionId } = await shim.cdp.call("Target.attachToTarget", {
      targetId,
      flatten: true,
    }));
    await shim.cdp.call("Page.bringToFront", {}, sessionId).catch(() => {});
  } finally {
    if (sessionId) {
      await shim.cdp
        .call("Target.detachFromTarget", { sessionId })
        .catch(() => {});
    }
  }

  // The browser needs one page at startup, but the Spaces tab now fulfils that
  // role. Remove only untracked blank tabs; task-space blank anchors stay put.
  const tracked = await trackedTaskTargets();
  targetInfos = await targets();
  for (const candidate of targetInfos) {
    if (
      candidate.type !== "page" ||
      candidate.url !== "about:blank" ||
      tracked.has(candidate.targetId)
    ) {
      continue;
    }
    await shim.cdp
      .call("Target.closeTarget", { targetId: candidate.targetId })
      .catch(() => {});
  }
  return targetId;
}

/**
 * Serve the Spaces panel until the browser goes away.
 *
 * Runs detached, because the panel's backend must outlive the command that
 * opened it. Tying the server to a foreground CLI process meant that closing
 * the terminal — or any timeout around it — left the panel showing
 * "cannot reach the browser".
 */
async function runSpacesDaemon({ prewarm = false } = {}) {
  const { startSpacesServer } = await import("../src/spaces-server.mjs");
  // Spaces created from the panel are the user's, not the profile that happened
  // to launch this daemon (see agent-identity.mjs).
  process.env.EGO_LINUX_PANEL = "1";
  const buildId = await runtimeBuildId();
  const shutdownToken = randomBytes(24).toString("hex");
  let requestShutdown;
  const shutdown = new Promise((resolve) => {
    requestShutdown = () => resolve("upgrade");
  });
  const shim = await createEgoShim({ headless: false });
  let url;
  let opening;
  const spaces = await startSpacesServer(shim, {
    buildId,
    shutdownToken,
    onOpen: () =>
      (opening ??= openPanelTab(url, shim).finally(() => {
        opening = null;
      })),
    onShutdown: requestShutdown,
  });
  url = spacesPanelUrl(spaces.port, shutdownToken);

  // An ordinary launch opens its panel before publishing, while an opt-in
  // prewarm publishes a ready server with no visible browser window.
  const targetId = prewarm
    ? null
    : await openPanelTab(url, shim, { recreate: true });
  await writePrivateStateFile(
    SPACES_STATE_FILE,
    JSON.stringify(
      {
        port: spaces.port,
        pid: process.pid,
        targetId,
        buildId,
        shutdownToken,
        prewarm,
      },
      null,
      2,
    ),
  );

  const signal = new Promise((resolve) => {
    process.once("SIGINT", () => resolve("signal"));
    process.once("SIGTERM", () => resolve("signal"));
  });

  let timer;
  const browserOrPanel = new Promise((resolve) => {
    // Give Chrome a moment to register the window before deciding it is absent.
    let seenPanel = false;
    const started = Date.now();

    timer = setInterval(async () => {
      let targets;
      try {
        ({ targetInfos: targets = [] } = await shim.cdp.call(
          "Target.getTargets",
          {},
          undefined,
          { timeoutMs: 3000 },
        ));
      } catch {
        // The browser went away, taking every window with it.
        clearInterval(timer);
        resolve("browser-gone");
        return;
      }

      // ego.listTabs() is scoped to the agent's selected task space. Once an
      // agent selects one, that list intentionally hides this overview page and
      // made the daemon mistake a live panel for a closed one.
      const open = targets.some((target) => isSpacesTarget(target, url));
      if (open) {
        seenPanel = true;
        return;
      }
      if (prewarm) return;
      // Closing the panel while the browser keeps running is deliberate: stop
      // serving rather than reopening a window the user just dismissed.
      if (seenPanel || Date.now() - started > 20000) {
        clearInterval(timer);
        resolve("panel-closed");
      }
    }, 2500);
  });
  const outcome = await Promise.race([shutdown, signal, browserOrPanel]);
  clearInterval(timer);

  spaces.close();
  shim.close();
  // A replaced daemon can outlive its successor long enough to reach cleanup.
  // Remove only our own record; never erase a newer daemon's published state.
  try {
    const state = JSON.parse(await readFile(SPACES_STATE_FILE, "utf8"));
    if (state.pid === process.pid) {
      await rm(SPACES_STATE_FILE, { force: true });
    }
  } catch {
    // Missing or malformed state already means there is nothing of ours to
    // clean up.
  }

  // Keep the existing recovery for a normal panel. An opt-in warm daemon
  // must not restart Chrome behind the user's back after a full browser quit.
  if (outcome === "browser-gone" && !prewarm) {
    spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--spaces-daemon"],
      detachedSpawnOptions(),
    ).unref();
  }
  return 0;
}

/**
 * Open the Spaces overview.
 *
 * Spaces is a normal tab in the shared agent browser. Reusing one browser window
 * avoids a blank backing window plus a separate overview window.
 */
async function openSpacesUnlocked(prewarm) {
  const [buildId, running] = await Promise.all([
    runtimeBuildId(),
    liveSpacesServer(),
  ]);

  // A running daemon already owns the panel; reconnect and raise its tab.
  if (running?.health.buildId === buildId) {
    if (prewarm) return 0;
    const response = await spacesRequest(running, "/api/open", "POST", 5000);
    if (!response.ok) {
      throw new Error(
        `Spaces daemon refused to open the panel (${response.status})`,
      );
    }
    process.stderr.write(`Spaces panel: http://127.0.0.1:${running.port}/\n`);
    return 0;
  }

  if (running) {
    process.stderr.write("updating the Spaces daemon to the current build\n");
    await stopSpacesDaemon(running);
  }

  spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--spaces-daemon",
      ...(prewarm ? ["--prewarm-spaces"] : []),
    ],
    detachedSpawnOptions(),
  ).unref();

  let current = null;
  const deadline = Date.now() + 30000;
  while (!current && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const candidate = await liveSpacesServer(buildId);
    if (candidate?.current) current = candidate;
  }
  if (!current) {
    process.stderr.write("the Spaces server did not come up\n");
    return 1;
  }

  if (!prewarm) {
    process.stderr.write(`Spaces panel: http://127.0.0.1:${current.port}/\n`);
  }
  return 0;
}

async function withSpacesLaunchLock(action) {
  await ensurePrivateStateDir();
  const release = await acquireLaunchLock(SPACES_LAUNCH_LOCK);
  try {
    return await action();
  } finally {
    await release();
  }
}

/**
 * Sweep spaces that hold nothing but about:blank.
 *
 * The automatic sweep in reconcile only touches spaces stamped with a creation
 * time, so it cannot reach the drift left behind before that existed — and a
 * user staring at twenty empty windows wants them gone now, not in two minutes.
 * Explicitly invoked, so it ignores age and asks no questions.
 */
async function pruneSpaces() {
  // Maintenance must never be the thing that opens a browser. Forcing a headed
  // launch here meant running the sweep on a quiet machine started a visible
  // window — producing exactly the empty windows it exists to clear.
  const { browserStatus } = await import("../src/chrome.mjs");
  const status = await browserStatus();
  if (!status.running) {
    process.stdout.write("no backing browser is running; nothing to prune\n");
    return 0;
  }
  const shim = await createEgoShim({ headless: status.headless === true });
  try {
    const { taskSpaces = [] } = await shim.ego.listTaskSpaces();
    // The selected space is the one an agent is working in right now, and its
    // tab is about:blank for a moment on every navigation. Closing it would
    // take the agent's context out from under it mid-task.
    let selectedId = null;
    try {
      ({ selectedId = null } = JSON.parse(
        await readFile(TASK_SPACE_FILE, "utf8"),
      ));
    } catch {
      // No state file means no selection to protect.
    }
    const { targetInfos = [] } = await shim.cdp.call("Target.getTargets");
    const byTarget = new Map(
      targetInfos.map((target) => [target.targetId, target]),
    );

    let closed = 0;
    for (const space of taskSpaces) {
      const tabs = (space.targetIds || [])
        .map((id) => byTarget.get(id))
        .filter(Boolean);
      if (tabs.length === 0) continue;
      if (space.id === selectedId) continue;
      if (space.lastContentAt) continue;
      if (!tabs.every((target) => target.url === "about:blank")) continue;
      await shim.ego.closeTaskSpace(space.id).then(
        () => {
          closed += 1;
        },
        () => {},
      );
    }
    process.stdout.write(
      closed === 0
        ? "no empty spaces to close\n"
        : `closed ${closed} empty ${closed === 1 ? "space" : "spaces"}\n`,
    );
  } finally {
    shim.close();
  }
  return 0;
}

/**
 * Show the shared agent window, opening `urls` in new tabs first (--open,
 * --launch <url>). Launched from a desktop icon or xdg-open there is no
 * terminal to read an error in, so this has to succeed rather than explain.
 */
async function openPages(urls) {
  // Launched from a desktop icon there is no terminal to read an error in, so
  // this has to succeed rather than explain. A headless browser has no window
  // to show, so trade it for a visible one.
  const { browserStatus, stopBrowser } = await import("../src/chrome.mjs");
  const status = await browserStatus();
  if (status.running && status.headless) {
    process.stderr.write("replacing the headless browser with a visible one\n");
    await stopBrowser();
  }
  const shim = await createEgoShim({ headless: false });
  try {
    // Each page asked for gets its own plain tab, the last one raised. Not
    // ego.createTab: that files the tab into the agents' selected task space
    // and does nothing while a person has taken that space over.
    let targetId;
    for (const url of urls) {
      ({ targetId } = await shim.cdp.call("Target.createTarget", { url }));
    }
    const { tabs } = await shim.ego.listTabs();
    // A browser with no page target shows no window; give it one.
    targetId ??= tabs.find((tab) => tab.active)?.targetId ?? tabs[0]?.targetId;
    if (!targetId) {
      ({ targetId } = await shim.ego.createTab("about:blank"));
      // This exact creator-stamped blank may be removed after the first real
      // agent tab appears. The browser process stays alive; only its idle
      // window disappears, and a future target maps it again automatically.
      await shim.rememberWindowAnchor(targetId);
    }

    // The window usually already exists — it is just behind everything else.
    // Clicking a launcher icon has to raise it, not quietly confirm it is
    // running, which looks identical to nothing happening.
    await shim.cdp.call("Target.activateTarget", { targetId }).catch(() => {});
    const { sessionId } = await shim.cdp.call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await shim.cdp.call("Page.bringToFront", {}, sessionId).catch(() => {});
  } finally {
    shim.close();
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);

  // The skill documents `ego-browser nodejs <<'EOF'`; accept it as a no-op prefix.
  if (argv[0] === "nodejs") argv.shift();

  if (argv[0] === "--spaces-daemon") {
    return runSpacesDaemon({ prewarm: argv[1] === "--prewarm-spaces" });
  }
  let launchUrls = null;
  if (argv[0] === "--launch") {
    launchUrls = [];
    if (argv.length > 1) {
      const { launchTargets } = await import("../src/desktop.mjs");
      launchUrls = launchTargets(argv.slice(1));
    }
  }
  if (argv[0] === "--prewarm-spaces") {
    return withSpacesLaunchLock(() => openSpacesUnlocked(true)).finally(() =>
      cleanupExpiredArtifacts().catch(() => {}),
    );
  }
  // Even a sweep after creating the window competes with its first render.
  if (argv[0] === "--spaces" || launchUrls?.length === 0) {
    return withSpacesLaunchLock(() => openSpacesUnlocked(false));
  }
  if (launchUrls) return openPages(launchUrls);

  // CLI use is an opportunity to reap old screenshots, failure reports,
  // and completed download directories without a resident cleanup process.
  await cleanupExpiredArtifacts().catch(() => {});

  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === "skill" && argv.length === 1) {
    process.stdout.write(await readSkillGuide());
    return 0;
  }
  const { browserStatus, stopBrowser } = await import("../src/chrome.mjs");
  if (argv[0] === "--status") {
    process.stdout.write(`${JSON.stringify(await browserStatus(), null, 2)}\n`);
    return 0;
  }
  if (argv[0] === "--cleanup-session") {
    const session = agentIdentity().session;
    if (!session) {
      process.stdout.write(
        `${JSON.stringify({
          session: null,
          spacesClosed: 0,
          spacesSkipped: 0,
          serversMatched: 0,
          serversSignaled: 0,
          serversStopped: 0,
          serverPids: [],
          serversRemaining: [],
          skipped: "no-session",
        })}\n`,
      );
      return 0;
    }

    let spaces = { closed: 0, skipped: 0 };
    let spaceError = null;
    try {
      const status = await browserStatus();
      if (status.running) {
        const shim = await createEgoShim({
          headless: status.headless === true,
        });
        try {
          spaces = await shim.cleanupAgentSessionSpaces(session);
        } finally {
          shim.close();
        }
      }
    } catch (error) {
      spaceError = String(error?.message || error);
    }
    const servers = await stopSessionDevServers(session);
    process.stdout.write(
      `${JSON.stringify({
        session,
        spacesClosed: spaces.closed,
        spacesSkipped: spaces.skipped,
        serversMatched: servers.matched,
        serversSignaled: servers.signaled,
        serversStopped: servers.stopped,
        serverPids: servers.pids,
        serversRemaining: servers.remaining,
        ...(spaceError ? { spaceError } : {}),
      })}\n`,
    );
    return !spaceError && servers.remaining.length === 0 ? 0 : 1;
  }
  if (argv[0] === "--doctor") {
    const { runDoctor } = await import("../src/doctor.mjs");
    return runDoctor({
      json: argv.includes("--json") || argv.includes("-j"),
      harnessPath: fileURLToPath(HARNESS_V2),
    });
  }
  if (argv[0] === "--stop") {
    const stopped = await withSpacesLaunchLock(async () => {
      const spaces = await liveSpacesServer();
      if (spaces?.prewarm) await stopSpacesDaemon(spaces);
      return stopBrowser();
    });
    process.stdout.write(
      stopped
        ? "backing browser stopped; the next run launches a fresh one\n"
        : "no backing browser was running; profile lock cleared\n",
    );
    return 0;
  }
  if (argv[0] === "--import-chrome-profile") {
    return importChromeProfile();
  }
  if (argv[0] === "--prune-spaces") {
    return pruneSpaces();
  }
  if (argv[0] === "--install-desktop-entry") {
    const { installDesktopEntry } = await import("../src/desktop.mjs");
    const { entryPath, iconPath } = await installDesktopEntry();
    process.stdout.write(
      iconPath
        ? `installed ${entryPath}\n         ${iconPath}\n`
        : `installed ${entryPath}\n`,
    );
    return 0;
  }
  if (argv[0] === "--open") {
    return openPages([]);
  }

  // EGO_LINUX_HEADLESS is for a machine whose owner does not want the agent
  // window in front of their work. The harness needs a page target to attach to,
  // so a visible browser always shows a window — headless is the only way to be
  // driven without one. --headless still works per run, and --open still trades
  // a headless browser for a visible one on demand.
  const envHeadless = !["", "0", "false", "no"].includes(
    (process.env.EGO_LINUX_HEADLESS ?? "").toLowerCase(),
  );
  // Short on memory, a visible window is the first thing to give up: the browser
  // starts headless and trimmed instead of being killed mid-task. An explicit
  // EGO_LINUX_HEADLESS (either way) is the owner's answer and is left alone.
  // A browser that is already running keeps the mode it was started in.
  const lowMemory =
    process.env.EGO_LINUX_HEADLESS === undefined &&
    isLowMemory(await availableMemoryMb()) &&
    !(await browserStatus()).running;
  const headless = argv.includes("--headless") || envHeadless || lowMemory;
  if (lowMemory) {
    process.stderr.write(
      "ego-browser: low on memory, starting the browser headless; " +
        "run `ego-browser --open` for a visible one\n",
    );
  }
  const rest = argv.filter((arg) => arg !== "--headless");

  // `--sdk-path <file>` selects which harness bundle to run. Upstream's real
  // browser e2e runner passes it to test a local build; here the local build is
  // the only harness there is, so honour the path it names.
  let harness = HARNESS_V2.href;
  const sdkFlag = rest.indexOf("--sdk-path");
  if (sdkFlag !== -1) {
    const path = rest[sdkFlag + 1];
    if (!path) {
      process.stderr.write("--sdk-path requires a path\n");
      return 2;
    }
    harness = pathToFileURL(path).href;
    rest.splice(sdkFlag, 2);
  }

  // Site skills and learnings live in the repo's skill directory.
  process.env.EGO_BROWSER_AGENT_WORKSPACE ||= SKILL_WORKSPACE.pathname;

  // A plain script run (no harness flags, no --sdk-path) is read here and
  // handed to the harness as text, so the port's extension prelude can be
  // added. `-e '<code>'` is the same script passed as one argument, for shells
  // and sandboxes without heredoc input.
  let stdinText;
  if (rest[0] === "-e" && rest.length === 2 && sdkFlag === -1) {
    stdinText = rest[1];
    rest.length = 0;
  } else if (rest.length === 0 && sdkFlag === -1) {
    stdinText = await readStdin();
  }
  const shim = await createEgoShim({
    headless,
    lowMemory,
    // v2 waits for a new space's default tab (see README "Runtime").
    defaultSpaceTab: true,
  });
  globalThis.ego = shim.ego;

  // v2 scopes Page labels by process.ppid; pin it to the backing browser so
  // labels survive between rounds (see src/runtime-instance.mjs).
  if (
    !pinRuntimeInstance(browserInstanceKey(shim.wsUrl)) &&
    harness === HARNESS_V2.href
  ) {
    process.stderr.write(
      `ego-browser: cannot tell which browser ${shim.wsUrl} is (no /devtools/browser/<id> in it); ` +
        "Page labels will not carry over to the next round\n",
    );
  }

  const { runMain } = await import(harness);
  try {
    // v2 gets the port's extensions (locators, fastObserve/fastAct, debug,
    // requestUserAction) without touching the upstream mirror; see
    // package/ego-v2-ext/src/index.mjs.
    if (harness === HARNESS_V2.href && stdinText !== undefined) {
      const { withExtensions } = await import(V2_EXTENSIONS.href);
      return await runMain({
        argv: rest,
        stdinText: withExtensions(stdinText),
      });
    }
    return await runMain({ argv: rest, stdinText });
  } finally {
    // A script that creates a Task Space but returns or throws before its first
    // navigation must not strand its targetless state record.
    // This is creator-scoped inside the shim, so other agents' spaces and every
    // space that loaded content or moved to user control remain untouched.
    await shim.cleanupCreatedEmptySpaces().catch(() => {});
    shim.close();
  }
}

// The Skill's own SKILL.md without its frontmatter, so `ego-browser skill`
// prints the same guide an agent loads from the skill directory.
async function readSkillGuide() {
  const source = await readFile(
    new URL("SKILL.md", `${SKILL_WORKSPACE.href}/`),
    "utf8",
  );
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)+/, "");
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
