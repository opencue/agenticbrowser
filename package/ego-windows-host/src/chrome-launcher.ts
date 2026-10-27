import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const READY_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 250;

type EndpointInfo = {
  webSocketDebuggerUrl: string;
  Browser?: string;
};

type EnsureBrowserOptions = {
  port: number;
  userDataDir: string;
  /** Lazy so the browser is only located when a launch is actually needed. */
  browserPath: () => string;
  headless?: boolean;
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

/**
 * Probe the DevTools HTTP endpoint on the loopback interface. Resolves with
 * the version info (including the browser-level websocket URL) when a
 * CDP-capable browser answers, or null when nothing (or something else)
 * listens on the port.
 */
export async function browserEndpoint(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<EndpointInfo | null> {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) {
      return null;
    }
    const info = await response.json();
    return typeof info?.webSocketDebuggerUrl === "string" ? info : null;
  } catch {
    return null;
  }
}

/**
 * Reuse the browser already serving CDP on the port, or launch one detached
 * so it outlives this process. The browser itself is the persistent state
 * holder across CLI invocations — there is no separate daemon to manage.
 */
export async function ensureBrowser(options: EnsureBrowserOptions) {
  const fetchFn = options.fetchFn || fetch;
  const sleep =
    options.sleep ||
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const existing = await browserEndpoint(options.port, fetchFn);
  if (existing) {
    return { endpoint: existing, launched: false };
  }
  const browserPath = options.browserPath();
  mkdirSync(options.userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Node's WebSocket sends no Origin; without this Chrome rejects the upgrade.
    "--remote-allow-origins=*",
    // Keep timers and rendering active even when the window is backgrounded or
    // occluded — the same flags used on Linux to prevent the agent browser from
    // throttling itself while the user works in another window.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // Big enough that a page laid out for a desktop viewport fits. The default
    // headless window is ~800x600, which pushes lower page content out of view;
    // input dispatched at those coordinates hit-tests to nothing.
    "--window-size=1280,900",
    // Without this, HiDPI scaling (e.g. 150%) shrinks the CSS viewport so
    // page content falls below the fold and pointer input silently does nothing.
    "--force-device-scale-factor=1",
    // Suppress "Chrome didn't shut down correctly — Restore pages?" on restart.
    "--hide-crash-restore-bubble",
    ...(options.headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const spawnFn = options.spawnFn || spawn;
  const child = spawnFn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + (options.timeoutMs ?? READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const endpoint = await browserEndpoint(options.port, fetchFn);
    if (endpoint) {
      return { endpoint, launched: true };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `browser did not expose CDP on port ${options.port} within ${options.timeoutMs ?? READY_TIMEOUT_MS}ms`,
  );
}
