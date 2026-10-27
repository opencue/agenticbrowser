/**
 * Tests for renderer-crash detection (EGO_PAGE_CRASHED).
 *
 * Verifies that:
 *  - Inspector.targetCrashed events mark the session as crashed.
 *  - Page.frameNavigated to chrome-error:// also marks the session as crashed.
 *  - Subsequent page-level CDP calls throw EGO_PAGE_CRASHED with the last
 *    known URL and a 'reload or open a new page' hint.
 *  - Successful navigation away from the error page clears the crash state.
 *  - invalidateSession() clears crash state.
 *  - Browser-level (Target.*, Browser.*) calls are not blocked.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  browserCdp,
  clearPreferredTarget,
  drainBrowserEvents,
  drainBrowserTrace,
  getCrashedLastUrl,
  invalidateSession,
  isCrashedSession,
} from "../dist/src/browser-runtime.js";
import { state } from "../dist/src/state.js";

/** Install a minimal ego mock that auto-responds to every send. */
function installAutoEgo() {
  const calls = [];
  const tabs = { tabs: [{ targetId: "tab-1", active: true }] };
  globalThis.ego = {
    async listTabs() {
      return tabs;
    },
    sendCDPMessage(payload) {
      const parsed = JSON.parse(payload);
      calls.push(parsed);
      setTimeout(() => {
        if (globalThis.ego?.onCDPMessage) {
          const result =
            parsed.method === "Target.attachToTarget"
              ? { sessionId: `auto-sess-${parsed.id}` }
              : {};
          globalThis.ego.onCDPMessage(
            JSON.stringify({ id: parsed.id, result }),
          );
        }
      }, 0);
    },
  };
  return calls;
}

/** Fire a raw CDP event through the handler set up by rawCdp. */
function fireEvent(method, params = {}, sessionId) {
  const msg = { method, params };
  if (sessionId) msg.sessionId = sessionId;
  globalThis.ego.onCDPMessage(JSON.stringify(msg));
}

function cleanup() {
  delete globalThis.ego;
  invalidateSession();
  clearPreferredTarget();
  drainBrowserEvents();
  drainBrowserTrace();
  state.cdpOverride = null;
  state.sessionInflight = null;
}

/* ------------------------------------------------------------------ */
/*  Inspector.targetCrashed                                           */
/* ------------------------------------------------------------------ */

test("Inspector.targetCrashed marks the session as crashed", async () => {
  installAutoEgo();
  try {
    // Establish a session.
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;
    assert.ok(sessionId, "session established");
    assert.equal(isCrashedSession(sessionId), false, "not crashed initially");

    fireEvent("Inspector.targetCrashed", {}, sessionId);

    assert.equal(
      isCrashedSession(sessionId),
      true,
      "session marked as crashed after Inspector.targetCrashed",
    );
  } finally {
    cleanup();
  }
});

test("Inspector.targetCrashed with no sessionId falls back to state.sessionId", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    // Fire with no sessionId on the event — should fall back to state.sessionId.
    fireEvent("Inspector.targetCrashed", {});

    assert.equal(isCrashedSession(sessionId), true);
  } finally {
    cleanup();
  }
});

test("Inspector.targetCrashed records last known URL", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    // Simulate navigation to a real page before the crash.
    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "https://example.com/page" } },
      sessionId,
    );

    fireEvent("Inspector.targetCrashed", {}, sessionId);

    assert.equal(getCrashedLastUrl(sessionId), "https://example.com/page");
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  Page.frameNavigated to chrome-error://                            */
/* ------------------------------------------------------------------ */

test("Page.frameNavigated to chrome-error:// marks session as crashed", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "https://example.com/" } },
      sessionId,
    );
    assert.equal(isCrashedSession(sessionId), false, "not crashed on real URL");

    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "chrome-error://chromewebdata" } },
      sessionId,
    );
    assert.equal(
      isCrashedSession(sessionId),
      true,
      "marked crashed on chrome-error:// navigation",
    );
  } finally {
    cleanup();
  }
});

test("Page.frameNavigated to chrome-error:// preserves the last good URL", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "https://example.com/app" } },
      sessionId,
    );
    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "chrome-error://chromewebdata" } },
      sessionId,
    );

    assert.equal(getCrashedLastUrl(sessionId), "https://example.com/app");
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  browserCdp blocks on crashed session                              */
/* ------------------------------------------------------------------ */

test("page-level CDP call on a crashed session throws EGO_PAGE_CRASHED", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    fireEvent("Inspector.targetCrashed", {}, sessionId);

    await assert.rejects(
      () => browserCdp("Runtime.evaluate", { expression: "2 + 2" }),
      (err) => {
        assert.equal(err.error_code, "EGO_PAGE_CRASHED");
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("EGO_PAGE_CRASHED error includes the last known URL", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "https://example.com/dashboard" } },
      sessionId,
    );
    fireEvent("Inspector.targetCrashed", {}, sessionId);

    await assert.rejects(
      () => browserCdp("Runtime.evaluate", { expression: "1" }),
      (err) => {
        assert.match(err.message, /https:\/\/example\.com\/dashboard/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("EGO_PAGE_CRASHED error includes a reload hint", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;
    fireEvent("Inspector.targetCrashed", {}, sessionId);

    await assert.rejects(
      () => browserCdp("Runtime.evaluate", { expression: "1" }),
      (err) => {
        assert.match(err.message, /[Rr]eload or open a new page/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("browser-level Target.getTargets is not blocked by crash state", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;
    fireEvent("Inspector.targetCrashed", {}, sessionId);

    // Target.getTargets is browser-level and must not be blocked.
    await assert.doesNotReject(() =>
      browserCdp("Target.getTargets", {}, undefined, 5000),
    );
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  Recovery: navigation away from crash clears state                 */
/* ------------------------------------------------------------------ */

test("Page.frameNavigated to a real URL clears crash state", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    fireEvent("Inspector.targetCrashed", {}, sessionId);
    assert.equal(isCrashedSession(sessionId), true, "crashed after event");

    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "https://example.com/new" } },
      sessionId,
    );
    assert.equal(
      isCrashedSession(sessionId),
      false,
      "crash cleared after real navigation",
    );
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  invalidateSession clears crash state                              */
/* ------------------------------------------------------------------ */

test("invalidateSession clears crash and URL tracking state", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "https://example.com/" } },
      sessionId,
    );
    fireEvent("Inspector.targetCrashed", {}, sessionId);
    assert.equal(isCrashedSession(sessionId), true);

    invalidateSession();

    assert.equal(
      isCrashedSession(sessionId),
      false,
      "crash state cleared by invalidateSession",
    );
    assert.equal(getCrashedLastUrl(sessionId), "");
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  cdpOverride bypasses crash guard (test mock path)                 */
/* ------------------------------------------------------------------ */

test("cdpOverride bypasses the crash guard", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;
    fireEvent("Inspector.targetCrashed", {}, sessionId);

    // cdpOverride is the test mock path; it must not be blocked.
    let called = false;
    state.cdpOverride = async () => {
      called = true;
      return { result: {} };
    };
    await browserCdp("Runtime.evaluate", { expression: "1" });
    assert.ok(called, "cdpOverride was reached despite crash state");
  } finally {
    cleanup();
  }
});
