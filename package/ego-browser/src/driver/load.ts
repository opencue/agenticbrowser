import { cdp, evaluate } from "../cdp-eval.js";
import { state } from "../state.js";
import { isBrowserRuntime, waitForBrowserEvent } from "../browser-runtime.js";

export type WaitForLoadOptions = {
  timeout?: number;
  until?: "load" | "domcontentloaded";
};

// Backstop interval between readiness probes. The lifecycle events below
// normally wake the wait far sooner; this interval only has to cover the cases
// where no event can arrive — a document that finished loading before we
// started waiting, a session that rejected Page.enable, or a runtime with no
// event channel at all.
const PROBE_INTERVAL = 300;

// Any of these means the document moved on, so re-probe immediately instead of
// sitting out the rest of the interval.
const LOAD_EVENTS = new Set([
  "Page.loadEventFired",
  "Page.domContentEventFired",
  "Page.frameStoppedLoading",
]);

/**
 * Wait until the document reaches the requested readiness.
 *
 * Probing is event-driven with a polling backstop. A plain 300 ms poll charged
 * every navigation up to a full interval of dead time — ~150 ms on average —
 * even when the page had been ready almost immediately, because nothing woke
 * the loop early. CDP already tells us when the document is ready, and the
 * runtime already routes those events (`Page.enable` is on), so the interval
 * is now only a safety net rather than the thing that sets the pace.
 */
export async function waitForDocumentLoad(options: WaitForLoadOptions = {}) {
  const timeout = options.timeout ?? 15000;
  const ready =
    options.until === "domcontentloaded"
      ? ["interactive", "complete"]
      : ["complete"];
  const deadline = state.now() + timeout;

  // A frame that has committed stays committed for the navigation we are
  // waiting on, so the Page.getFrameTree round trip only runs until we see it.
  // Before, every probe paid for two round trips instead of one.
  let committed = false;

  while (state.now() < deadline) {
    if (!committed) {
      committed = true;
      try {
        const tree = await cdp("Page.getFrameTree");
        const url = tree.frameTree?.frame?.url || "";
        committed = url !== "" && url !== ":" && url !== "about:blank";
      } catch {
        // Page.getFrameTree may not be supported in some sessions; fall back to readyState only.
      }
    }
    if (committed && ready.includes(await evaluate("document.readyState"))) {
      return true;
    }
    await probeDelay(Math.min(PROBE_INTERVAL, deadline - state.now()));
  }
  return false;
}

/**
 * Sleep until the next probe, but let a load-lifecycle event cut the wait
 * short. Falls back to a plain sleep when there is no event channel to listen
 * on, which is also what keeps the pure-CDP unit tests deterministic.
 */
async function probeDelay(waitMs: number) {
  if (waitMs <= 0) return;
  if (!isBrowserRuntime()) {
    await state.sleep(waitMs);
    return;
  }
  // The waiter carries the same timeout as the interval, so it can never
  // outlive the probe it was created for and pile up across iterations.
  await Promise.race([
    waitForBrowserEvent(
      (event: any) => LOAD_EVENTS.has(event?.method),
      waitMs,
    ).catch(() => undefined),
    state.sleep(waitMs),
  ]);
}
