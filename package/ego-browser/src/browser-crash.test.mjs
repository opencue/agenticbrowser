/**
 * Tests for renderer-crash detection (EGO_PAGE_CRASHED).
 *
 * Verifies that:
 *  - Inspector.targetCrashed events mark the session as crashed.
 *  - chrome-error:// pages and iframe navigations do not count as crashes.
 *  - Page.navigate / Page.reload still reach a crashed session (recovery).
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
  clearCrashedTargets,
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
  clearCrashedTargets();
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

test("Page.frameNavigated to chrome-error:// is not a crash", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "chrome-error://chromewebdata" } },
      sessionId,
    );
    assert.equal(isCrashedSession(sessionId), false);
    await assert.doesNotReject(() =>
      browserCdp("Runtime.evaluate", { expression: "document.title" }),
    );
  } finally {
    cleanup();
  }
});

test("iframe navigation neither clears crash state nor replaces the last URL", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;

    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "https://example.com/app" } },
      sessionId,
    );
    fireEvent("Inspector.targetCrashed", {}, sessionId);
    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "https://cdn.example.com/widget", parentId: "main" } },
      sessionId,
    );

    assert.equal(isCrashedSession(sessionId), true, "iframe does not clear");
    assert.equal(getCrashedLastUrl(sessionId), "https://example.com/app");
  } finally {
    cleanup();
  }
});

test("chrome-error:// after targetCrashed keeps the crash state", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;
    fireEvent("Inspector.targetCrashed", {}, sessionId);
    fireEvent(
      "Page.frameNavigated",
      { frame: { url: "chrome-error://chromewebdata" } },
      sessionId,
    );
    assert.equal(isCrashedSession(sessionId), true);
  } finally {
    cleanup();
  }
});

test("Page.navigate and Page.reload reach a crashed session", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;
    fireEvent("Inspector.targetCrashed", {}, sessionId);

    await assert.doesNotReject(() =>
      browserCdp("Page.navigate", { url: "https://example.com/" }),
    );
    await assert.doesNotReject(() => browserCdp("Page.reload", {}));
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

/* ------------------------------------------------------------------ */
/*  Page.enable is no longer in CRASH_RECOVERY_METHODS                */
/* ------------------------------------------------------------------ */

test("Page.enable on a crashed session throws EGO_PAGE_CRASHED", async () => {
  // CRASH_RECOVERY_METHODS previously contained "Page.enable" as a dead
  // entry: enablePageEvents() calls rawCdp() directly, so Page.enable never
  // goes through browserCdp's crash guard. After removing the dead entry,
  // an explicit browserCdp("Page.enable") on a crashed session must be
  // blocked. This test fails when the entry is present (Page.enable passes).
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;
    fireEvent("Inspector.targetCrashed", {}, sessionId);

    await assert.rejects(
      () => browserCdp("Page.enable", {}),
      (err) => {
        assert.equal(err.error_code, "EGO_PAGE_CRASHED");
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  Crash mark survives session re-attachment (targetId tracking)     */
/* ------------------------------------------------------------------ */

test("re-attaching to a crashed target carries the crash mark to the new session", async () => {
  // After a crash + invalidateSession(), ensureSession() re-attaches to the
  // same target and gets a new sessionId. Without crashedTargets tracking,
  // the new sessionId is not in crashedSessions and the guard is bypassed.
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const sessionId = state.sessionId;
    assert.ok(sessionId, "session established");

    fireEvent("Inspector.targetCrashed", {}, sessionId);
    assert.equal(
      isCrashedSession(sessionId),
      true,
      "original session marked crashed",
    );

    // Simulate session expiry: invalidate without navigating away.
    invalidateSession();
    assert.equal(isCrashedSession(sessionId), false, "old sessionId cleared");

    // The next browserCdp call re-attaches to the same target (tab-1) and
    // gets a fresh sessionId. It must still throw EGO_PAGE_CRASHED.
    await assert.rejects(
      () => browserCdp("Runtime.evaluate", { expression: "2" }),
      (err) => {
        assert.equal(
          err.error_code,
          "EGO_PAGE_CRASHED",
          "new session for same crashed target must be blocked",
        );
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

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
