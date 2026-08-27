import { spawn, spawnSync } from "node:child_process";
import { access, readFile, readdir, readlink, rm } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";

/**
 * The one place that knows what operating system this is running on.
 *
 * Everything else in this package speaks CDP, HTTP on loopback, or plain
 * `node:fs` — all of which behave the same everywhere. Only five things do not,
 * and they all live here:
 *
 *   1. where per-user data and runtime state belong,
 *   2. where a Chromium binary and a stock browser profile are found,
 *   3. how to read another process's argv and ancestry,
 *   4. how to ask a process to stop,
 *   5. what Chrome leaves behind to guard a profile against a second launch.
 *
 * Adding a platform means adding a branch to each of those, and nothing else.
 * `test/platform-isolation.test.mjs` enforces that: it fails the build if a
 * `/proc` read, a `which` call, an XDG variable or a POSIX signal reappears
 * anywhere outside this file.
 *
 * The platform and the environment are parameters rather than globals so the
 * Windows branch can be run — and proven right — from Linux CI. The module's
 * own exports are that factory bound to this machine, so every caller outside
 * the tests just imports the function it wants.
 */

const HOME = homedir();

/**
 * Keep headed agent Chrome activatable without allowing autonomous launches to
 * steal focus. Native Wayland requires a fresh compositor activation token;
 * short-lived agent processes do not own one, while XWayland lets the explicit
 * presentation gate activate the exact managed-browser PID.
 */
export function browserDisplayFlags({
  headless = false,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (headless || platform !== "linux") return [];
  const requested = (env.EGO_LINUX_WINDOW_BACKEND || "").toLowerCase();
  if (requested === "wayland") return ["--ozone-platform=wayland"];
  if (requested === "x11") return ["--ozone-platform=x11"];
  if (env.XDG_SESSION_TYPE === "wayland" && env.DISPLAY) {
    return ["--ozone-platform=x11"];
  }
  return [];
}

function runCapturedCommand(command, args, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, stderr, reason: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        stdout,
        stderr,
        reason: error.code || "spawn-error",
      });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, stdout, stderr, code });
    });
  });
}

/**
 * Activate the visible X11/XWayland window owned by one browser process.
 *
 * Wayland deliberately ignores CDP's Page.bringToFront for application-level
 * focus unless Chromium has a compositor activation token. Agent processes do
 * not have a fresh user-input token, so the managed browser is launched through
 * XWayland and this explicit, user-authorized path activates its exact PID.
 */
export async function activateWindowByClass(
  { wmClass, pid, env = process.env, platform = process.platform },
  {
    run = runCapturedCommand,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (platform !== "linux" || !env.DISPLAY) return false;
  if (!wmClass || !Number.isInteger(pid) || pid <= 0) return false;

  const search = await run("xdotool", [
    "search",
    "--onlyvisible",
    "--class",
    wmClass,
  ]);
  if (!search.ok) return false;

  const windowIds = search.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  let windowId = null;
  for (const candidate of windowIds) {
    const owner = await run("xdotool", ["getwindowpid", candidate]);
    if (owner.ok && Number(owner.stdout.trim()) === pid) {
      windowId = candidate;
      break;
    }
  }
  if (!windowId) return false;

  const activation = await run("xdotool", ["windowactivate", windowId]);
  if (!activation.ok) return false;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const active = await run("xdotool", ["getactivewindow"]);
    if (active.ok && active.stdout.trim()) {
      const owner = await run("xdotool", [
        "getwindowpid",
        active.stdout.trim(),
      ]);
      if (owner.ok && Number(owner.stdout.trim()) === pid) return true;
    }
    await sleep(50);
  }
  return false;
}

/**
 * Split a Windows command line the way CommandLineToArgvW does, near enough.
 *
 * Only double quotes matter for what reads this: Chrome switches are
 * `--flag=value`, and the one that can contain a space — `--user-data-dir` —
 * arrives quoted whole. Backslash-escaped quotes are not modelled because a
 * profile path never ends in a separator.
 */
export function splitCommandLine(line) {
  const argv = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (ch === " " || ch === "\t")) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

/** Whether a pid is running. Signal 0 tests for existence on Windows too. */
export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Spawn options for a child that must outlive the process starting it.
 *
 * `windowsHide` is the Windows half of `stdio: "ignore"`: without it every
 * detached child flashes a console window on screen, which for the Spaces
 * daemon means a black rectangle appearing on the user's desktop each time an
 * agent runs a heredoc. It is ignored on POSIX, so there is one shape for both.
 */
export function detachedSpawnOptions(extra = {}) {
  return { detached: true, stdio: "ignore", windowsHide: true, ...extra };
}

const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
];

/**
 * Run a PowerShell script for its effect, and say whether it succeeded.
 *
 * Values the script needs are passed as environment variables rather than
 * interpolated into it: a Windows path is full of backslashes and may contain
 * quotes and spaces, and `$env:NAME` sidesteps every one of those quoting rules
 * at once.
 */
export function runPowerShell(script, { env = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [...POWERSHELL_ARGS, script], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** Run PowerShell and parse the JSON it prints, or return [] if anything fails. */
function powerShellJson(script, { sync = false, timeoutMs = 6000 } = {}) {
  const parse = (stdout) => {
    // ConvertTo-Json emits a bare object for a single row and nothing at all
    // for none, so neither shape can be assumed to be an array.
    if (!stdout?.trim()) return [];
    try {
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  };

  if (sync) {
    const result = spawnSync("powershell.exe", [...POWERSHELL_ARGS, script], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parse(result.stdout);
  }

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [...POWERSHELL_ARGS, script], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parse(out));
    });
  });
}

/** WQL string literals escape the backslash and the quote, and nothing else. */
function wqlLiteral(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

async function exists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything that differs between operating systems, for one operating system.
 *
 * @param {object} [options]
 * @param {string} [options.platform] A `process.platform` value.
 * @param {object} [options.env] Read live, so later assignments are seen.
 */
export function createPlatform({
  platform = process.platform,
  env = process.env,
} = {}) {
  const isWindows = platform === "win32";

  /**
   * Path rules for the platform being *described*, not the one running.
   *
   * The conventional locations below — `%LOCALAPPDATA%`, `C:\Program Files` —
   * are Windows facts, and building them with the host's `path.join` would
   * spell them with the host's separator. On Windows this is the same function;
   * off Windows it is what lets the tests check the Windows branch produces
   * real Windows paths.
   *
   * Only path *construction* uses this. Anything that touches the filesystem
   * with a path a caller handed us keeps the plain `join`, because those are
   * real paths on the real machine either way.
   */
  const conventions = isWindows ? path.win32 : path.posix;

  /**
   * The directory name this app owns under the per-user roots.
   *
   * Linux keeps `ego-lite-linux` because that is where every existing install
   * already has its profile and its logins; renaming it would silently orphan
   * them. Windows has no such history, so it gets the name that is true there.
   */
  const APP_DIR = isWindows ? "ego-lite" : "ego-lite-linux";

  /** `%LOCALAPPDATA%`, with the documented default when the variable is unset. */
  const localAppData = () =>
    env.LOCALAPPDATA || conventions.join(HOME, "AppData", "Local");

  /**
   * XDG variables win on every platform when they are set.
   *
   * They are the Linux answer, but honouring them on Windows too is what lets a
   * test — or a harness pointing the browser at a scratch tree — redirect state
   * with one assignment, identically on both. Every suite in `test/` relies on
   * that, so this is the reason they run unchanged on Windows.
   */
  function dataRoot() {
    if (env.XDG_DATA_HOME) return env.XDG_DATA_HOME;
    return isWindows
      ? localAppData()
      : conventions.join(HOME, ".local", "share");
  }

  function stateRoot() {
    if (env.XDG_STATE_HOME) return env.XDG_STATE_HOME;
    // Windows has no data/state split; both conventionally live under
    // %LOCALAPPDATA%, so the profile and the state files share one directory.
    return isWindows
      ? localAppData()
      : conventions.join(HOME, ".local", "state");
  }

  /**
   * The Start Menu folder a launcher shortcut belongs in, or null off Windows.
   *
   * Roaming, not Local: a Start Menu entry follows the user to another machine
   * on a domain profile, which is where Windows puts every other installed
   * app's shortcut.
   */
  function startMenuProgramsDir() {
    if (!isWindows) return null;
    const roaming = env.APPDATA || conventions.join(HOME, "AppData", "Roaming");
    return conventions.join(
      roaming,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
    );
  }

  /** Where a stock browser keeps the profile we can import logins from. */
  function stockBrowserProfileDirs() {
    if (isWindows) {
      const local = localAppData();
      return [
        conventions.join(local, "Google", "Chrome", "User Data"),
        conventions.join(local, "Chromium", "User Data"),
        conventions.join(local, "Microsoft", "Edge", "User Data"),
        conventions.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
      ];
    }
    return [
      conventions.join(HOME, ".config", "google-chrome"),
      conventions.join(HOME, ".config", "chromium"),
      conventions.join(HOME, ".config", "microsoft-edge"),
      conventions.join(HOME, ".config", "BraveSoftware", "Brave-Browser"),
    ];
  }

  /**
   * Browser binaries to try, best first.
   *
   * Linux resolves bare names through the PATH; Windows installs browsers at
   * fixed locations and rarely puts them on the PATH at all, so the absolute
   * paths come first there and the bare names are only a backstop for a
   * PATH-registered install.
   */
  function browserBinaryCandidates() {
    const configured = env.EGO_LINUX_CHROME;
    if (isWindows) {
      const local = localAppData();
      const programFiles = env.PROGRAMFILES || "C:\\Program Files";
      const programFilesX86 =
        env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
      const app = (root, ...vendor) =>
        conventions.join(root, ...vendor, "Application");
      return [
        configured,
        conventions.join(app(programFiles, "Google", "Chrome"), "chrome.exe"),
        conventions.join(
          app(programFilesX86, "Google", "Chrome"),
          "chrome.exe",
        ),
        conventions.join(app(local, "Google", "Chrome"), "chrome.exe"),
        conventions.join(app(local, "Chromium"), "chrome.exe"),
        conventions.join(
          app(programFiles, "BraveSoftware", "Brave-Browser"),
          "brave.exe",
        ),
        conventions.join(
          app(programFilesX86, "Microsoft", "Edge"),
          "msedge.exe",
        ),
        conventions.join(app(programFiles, "Microsoft", "Edge"), "msedge.exe"),
        "chrome",
        "msedge",
      ].filter(Boolean);
    }
    return [
      configured,
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "brave-browser",
      "microsoft-edge",
    ].filter(Boolean);
  }

  /** Resolve a bare command name through the PATH. */
  function lookUpOnPath(name) {
    return new Promise((resolve) => {
      const child = spawn(isWindows ? "where.exe" : "which", [name], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        // where.exe prints every match, one per line; the first is the one the
        // shell would have run.
        const [first] = out.split(/\r?\n/);
        resolve(code === 0 && first?.trim() ? first.trim() : null);
      });
    });
  }

  /** The first Chromium we can launch, or a message naming everything tried. */
  async function resolveBrowserBinary() {
    const candidates = browserBinaryCandidates();
    for (const candidate of candidates) {
      if (
        conventions.isAbsolute(candidate) ||
        candidate.includes(conventions.sep) ||
        candidate.includes("/")
      ) {
        if (await exists(candidate)) return candidate;
        continue;
      }
      const found = await lookUpOnPath(candidate);
      if (found) return found;
    }
    throw new Error(
      `no Chrome/Chromium binary found (tried: ${candidates.join(", ")}). ` +
        `Set EGO_LINUX_CHROME to an absolute path.`,
    );
  }

  /**
   * Every process on this machine whose argv contains `contains`, with its argv.
   *
   * `contains` is not an optimisation on Windows, it is the query: WMI can
   * filter on the command line server-side, and asking for all ~300 processes
   * with their command lines instead is both slower and larger. The match is
   * re-checked here either way, because WQL LIKE treats `_` as a wildcard.
   *
   * A process that exits mid-scan is skipped, not an error — that is the normal
   * case for a reaper.
   */
  async function listProcesses({ contains }) {
    if (isWindows) {
      const rows = await powerShellJson(
        `@(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${wqlLiteral(
          contains,
        )}%'" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress`,
      );
      return rows
        .filter((row) => row?.CommandLine?.includes(contains))
        .map((row) => ({
          pid: Number(row.ProcessId),
          argv: splitCommandLine(row.CommandLine),
        }))
        .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
    }

    let entries;
    try {
      entries = await readdir("/proc");
    } catch {
      return []; // no procfs to walk
    }
    const found = await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (pid) => {
          let raw;
          try {
            raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
          } catch {
            return null; // exited under us, or another user's process
          }
          if (!raw.includes(contains)) return null;
          return { pid: Number(pid), argv: raw.split("\0") };
        }),
    );
    return found.filter(Boolean);
  }

  /** One process's argv, or null if it is gone or not ours to read. */
  async function processArgv(pid) {
    if (isWindows) {
      const [row] = await powerShellJson(
        `@(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(
          pid,
        )}" | Select-Object CommandLine) | ConvertTo-Json -Compress`,
      );
      return row?.CommandLine ? splitCommandLine(row.CommandLine) : null;
    }
    try {
      return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    } catch {
      return null;
    }
  }

  /**
   * Process names from this process up to the root, nearest first.
   *
   * Synchronous because its one caller labels the on-screen cursor while
   * building it, and threading a promise through that would put an await in
   * front of every drawn frame. On Windows that means one blocking PowerShell
   * call, so the answer is cached: a process's own ancestry does not change.
   */
  let cachedWindowsAncestry = null;

  function processAncestry(limit = 12) {
    if (isWindows) return windowsAncestry(limit);

    const names = [];
    let pid = "self";
    for (let depth = 0; depth < limit; depth += 1) {
      let comm;
      let status;
      try {
        comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        status = readFileSync(`/proc/${pid}/status`, "utf8");
      } catch {
        // The process exited under us, or this is not Linux. Either way the
        // walk is over and what we have is what we know.
        break;
      }
      if (comm) names.push(comm);
      const parent = /^PPid:\s*(\d+)/m.exec(status)?.[1];
      if (!parent || parent === "0") break;
      pid = parent;
    }
    return names;
  }

  function windowsAncestry(limit) {
    if (!cachedWindowsAncestry) {
      const rows = powerShellJson(
        "@(Get-CimInstance Win32_Process |" +
          " Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress",
        { sync: true, timeoutMs: 8000 },
      );
      const byPid = new Map(
        rows.map((row) => [
          Number(row.ProcessId),
          { name: row.Name, parent: Number(row.ParentProcessId) },
        ]),
      );

      const names = [];
      const seen = new Set();
      let pid = process.pid;
      // Windows reuses pids, so a stale parent link can point back into the
      // chain; `seen` is what stops that becoming an endless walk.
      while (byPid.has(pid) && !seen.has(pid)) {
        seen.add(pid);
        const entry = byPid.get(pid);
        // `claude.exe` is the same harness as Linux's `claude`, and one table
        // matches both, so the extension comes off here.
        if (entry.name) {
          names.push(entry.name.replace(/\.(exe|com|bat|cmd)$/i, ""));
        }
        if (!entry.parent || entry.parent === 0) break;
        pid = entry.parent;
      }
      cachedWindowsAncestry = names;
    }
    return cachedWindowsAncestry.slice(0, limit);
  }

  /**
   * Ask a process to stop, and say whether the request was taken.
   *
   * POSIX gets SIGTERM. Windows has no signal meaning "please exit" for a GUI
   * process reached by pid, so it gets `taskkill /T /F`, which also takes the
   * renderer children with it. Both are recorded by Chrome as an unclean exit,
   * which is exactly why `clearStaleCrashMark()` exists — so the two platforms
   * need no different handling downstream.
   */
  async function terminateProcess(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (isWindows) {
      return new Promise((resolve) => {
        const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      });
    }
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false; // already gone, or not ours to signal
    }
  }

  /**
   * The pid holding a profile's single-instance guard, if it can be identified.
   *
   * POSIX Chrome writes `SingletonLock` as a symlink named `<host>-<pid>`, so
   * the owner is readable straight off the filesystem. Windows Chrome guards
   * the profile with a named mutex and a message window instead — nothing on
   * disk names the owner — so the process list answers it: the browser we
   * launched against this profile is the one whose argv carries it.
   */
  async function readSingletonOwner(profileDir, { marker } = {}) {
    if (isWindows) {
      const running = await listProcesses({ contains: marker });
      const owner = running.find(
        (entry) =>
          entry.argv.includes(`--user-data-dir=${profileDir}`) &&
          !entry.argv.some((arg) => arg.startsWith("--type=")),
      );
      return owner?.pid ?? null;
    }

    let target;
    try {
      target = await readlink(join(profileDir, "SingletonLock"));
    } catch {
      return null; // no lock at all
    }
    const pid = Number(target.slice(target.lastIndexOf("-") + 1));
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }

  /**
   * Remove whatever a dead browser left behind that would block the next
   * launch. Windows keeps its singleton in kernel objects that die with the
   * process, so only LevelDB's `lockfile` is on disk; POSIX has the three
   * Singleton* links.
   */
  async function clearSingletonArtifacts(profileDir) {
    const names = isWindows
      ? ["lockfile"]
      : ["SingletonLock", "SingletonSocket", "SingletonCookie"];
    await Promise.all(
      names.map((name) => rm(join(profileDir, name), { force: true })),
    );
  }

  return {
    IS_WINDOWS: isWindows,
    APP_DIR,
    dataRoot,
    stateRoot,
    startMenuProgramsDir,
    stockBrowserProfileDirs,
    browserBinaryCandidates,
    resolveBrowserBinary,
    listProcesses,
    processArgv,
    processAncestry,
    terminateProcess,
    readSingletonOwner,
    clearSingletonArtifacts,
    // Carried through so a caller holding a platform object needs nothing else.
    splitCommandLine,
    processIsAlive,
    detachedSpawnOptions,
    runPowerShell,
  };
}

/** This machine, which is what every caller outside the tests wants. */
const native = createPlatform();

export const IS_WINDOWS = native.IS_WINDOWS;
export const APP_DIR = native.APP_DIR;
export const dataRoot = native.dataRoot;
export const stateRoot = native.stateRoot;
export const startMenuProgramsDir = native.startMenuProgramsDir;
export const stockBrowserProfileDirs = native.stockBrowserProfileDirs;
export const browserBinaryCandidates = native.browserBinaryCandidates;
export const resolveBrowserBinary = native.resolveBrowserBinary;
export const listProcesses = native.listProcesses;
export const processArgv = native.processArgv;
export const processAncestry = native.processAncestry;
export const terminateProcess = native.terminateProcess;
export const readSingletonOwner = native.readSingletonOwner;
export const clearSingletonArtifacts = native.clearSingletonArtifacts;
