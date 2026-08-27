import { open } from "node:fs/promises";
import { join } from "node:path";

import { STATE_DIR } from "./paths.mjs";
import { ensurePrivateStateDir } from "./private-state.mjs";

export const FOCUS_AUDIT_FILE = join(STATE_DIR, "focus-audit.jsonl");

/** Append one focus-theft repair without exposing URLs or page contents. */
export async function appendFocusAudit(event) {
  await ensurePrivateStateDir();
  const handle = await open(FOCUS_AUDIT_FILE, "a", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Repair focus only around operations that are contractually background work.
 *
 * This is deliberately not a global watcher. If the user switches to another
 * application, or the managed browser already owned focus before the operation,
 * the guard does nothing. Only a transition from another app to the exact
 * managed-browser PID is treated as focus theft.
 */
export function createDesktopFocusGuard({
  browserPid,
  getActiveWindow = async () => null,
  restoreFocus = async () => false,
  recordEvent = appendFocusAudit,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  settleMs = 75,
  restoreSettleMs = 150,
  now = () => new Date().toISOString(),
} = {}) {
  const validBrowserPid = Number.isInteger(browserPid) && browserPid > 0;

  async function readActiveWindow() {
    try {
      return await getActiveWindow();
    } catch {
      return null;
    }
  }

  async function repair(previous, reason) {
    let observed = await readActiveWindow();
    if (
      observed?.windowId === previous.windowId &&
      observed?.pid === previous.pid &&
      settleMs > 0
    ) {
      await sleep(settleMs).catch(() => {});
      observed = await readActiveWindow();
    }
    if (
      !observed ||
      observed.pid !== browserPid ||
      observed.windowId === previous.windowId
    ) {
      return;
    }

    let restorationRequested = false;
    try {
      restorationRequested = (await restoreFocus(previous)) === true;
    } catch {
      restorationRequested = false;
    }
    let restored = false;
    if (restorationRequested) {
      if (restoreSettleMs > 0) {
        await sleep(restoreSettleMs).catch(() => {});
      }
      const current = await readActiveWindow();
      restored = previous.windowId
        ? current?.windowId === previous.windowId &&
          current?.pid === previous.pid
        : current?.pid !== browserPid;
    }
    try {
      await recordEvent({
        at: now(),
        reason,
        browserPid,
        previous,
        observed,
        restored,
      });
    } catch {
      // Focus protection is cosmetic; audit I/O must never break automation.
    }
  }

  async function run(reason, operation) {
    if (typeof operation !== "function") {
      throw new TypeError("focus guard operation must be a function");
    }
    if (!validBrowserPid) return operation();

    const previous = await readActiveWindow();
    if (!previous || previous.pid === browserPid) return operation();

    let result;
    let operationError;
    let operationFailed = false;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
      operationFailed = true;
    }

    await restoreAfter(reason, previous);
    if (operationFailed) throw operationError;
    return result;
  }

  async function restoreAfter(reason, previous) {
    if (!validBrowserPid || !previous || previous.pid === browserPid) {
      return;
    }
    await repair(previous, reason).catch(() => {});
  }

  return { run, restoreAfter };
}
