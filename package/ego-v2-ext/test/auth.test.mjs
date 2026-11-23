/**
 * Unit tests for auth.mjs — loginPreflight and handleChallenge with fake
 * TaskSpace/Page objects (no real browser).
 *
 * Covers:
 * - Validation errors for bad options
 * - loginPreflight: no login form → detected:false
 * - loginPreflight: empty form → needsUser:true, no values leaked
 * - loginPreflight: pre-filled → submitted:true
 * - loginPreflight: not ready after wait → submitted:false
 * - handleChallenge: no challenge → {detected:false,handled:false}
 * - handleChallenge: challenge resolves automatically → resolvedAutomatically:true
 * - handleChallenge: challenge persists → requestUserAction called
 * - handleChallenge: headless → requestUserAction throws "not visible"
 * - options.page override works
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loginPreflight, handleChallenge } from "../src/auth.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Page.
 *
 * `evaluateResults` is an array of values returned by successive evaluate()
 * calls (cycled if exhausted by repeating the last entry).
 */
function fakePage(evaluateResults = []) {
  let calls = 0;
  return {
    _evaluateCalls: () => calls,
    async evaluate(_fn, _arg) {
      const idx = Math.min(calls, evaluateResults.length - 1);
      calls++;
      const val = evaluateResults[idx];
      return typeof val === "function" ? val() : val;
    },
  };
}

/**
 * Build a minimal fake TaskSpace.
 *
 * `tabsResults` controls what task.tabs() returns; each entry is
 * { active: boolean, page }.
 */
function fakeTask({
  tabsResults = [],
  pages = [],
  requestUserActionResult = null,
  requestUserActionThrows = null,
} = {}) {
  const task = {
    spaceId: 42,
    name: "test-space",
    ownership: "agent",
    async tabs() {
      return tabsResults;
    },
    async pages() {
      return pages;
    },
    page(label) {
      // Fallback p1 page
      return fakePage([
        { detected: false, ready: false, fieldCount: 0, filledCount: 0 },
      ]);
    },
    async requestUserAction(opts) {
      if (requestUserActionThrows) throw requestUserActionThrows;
      return requestUserActionResult;
    },
  };
  return task;
}

// ---------------------------------------------------------------------------
// loginPreflight
// ---------------------------------------------------------------------------

describe("task.loginPreflight", () => {
  it("rejects non-object options", async () => {
    const task = fakeTask();
    await assert.rejects(loginPreflight(task, "bad"), /must be an object/);
    await assert.rejects(loginPreflight(task, []), /must be an object/);
  });

  it("rejects negative waitForAutofill", async () => {
    const task = fakeTask();
    await assert.rejects(
      loginPreflight(task, { waitForAutofill: -1 }),
      /waitForAutofill must be non-negative/,
    );
  });

  it("rejects non-positive interval", async () => {
    const task = fakeTask();
    await assert.rejects(
      loginPreflight(task, { interval: 0 }),
      /interval must be positive/,
    );
  });

  it("rejects invalid submit type", async () => {
    const task = fakeTask();
    await assert.rejects(
      loginPreflight(task, { submit: 42 }),
      /submit must be boolean or a CSS selector/,
    );
  });

  it("no login form → detected:false, needsUser:false, no submit", async () => {
    const page = fakePage([
      { detected: false, ready: false, fieldCount: 0, filledCount: 0 },
    ]);
    const task = fakeTask({ tabsResults: [{ active: true, page }] });
    const r = await loginPreflight(task, { waitForAutofill: 0 });
    assert.deepEqual(r, {
      detected: false,
      ready: false,
      needsUser: false,
      fieldCount: 0,
      filledCount: 0,
      submitted: false,
    });
  });

  it("login form with empty fields → needsUser:true, no values in result", async () => {
    const page = fakePage([
      { detected: true, ready: false, fieldCount: 2, filledCount: 0 },
    ]);
    const task = fakeTask({ tabsResults: [{ active: true, page }] });
    const r = await loginPreflight(task, { waitForAutofill: 0 });
    assert.equal(r.detected, true);
    assert.equal(r.ready, false);
    assert.equal(r.needsUser, true);
    assert.equal(r.submitted, false);
    // No credential values should be leaked
    const str = JSON.stringify(r);
    assert.doesNotMatch(str, /password|credential|value|secret/i);
  });

  it("pre-filled form → ready:true, submits (auto-detect), submitted:true", async () => {
    // First evaluate: inspectLoginPage → ready
    // Second evaluate: submitReadyLogin → true
    const page = fakePage([
      { detected: true, ready: true, fieldCount: 2, filledCount: 2 },
      true, // submitReadyLogin returns true
    ]);
    const task = fakeTask({ tabsResults: [{ active: true, page }] });
    const r = await loginPreflight(task, { waitForAutofill: 0 });
    assert.equal(r.detected, true);
    assert.equal(r.ready, true);
    assert.equal(r.needsUser, false);
    assert.equal(r.fieldCount, 2);
    assert.equal(r.filledCount, 2);
    assert.equal(r.submitted, true);
  });

  it("submit:false suppresses submission even when ready", async () => {
    const page = fakePage([
      { detected: true, ready: true, fieldCount: 2, filledCount: 2 },
    ]);
    const task = fakeTask({ tabsResults: [{ active: true, page }] });
    const r = await loginPreflight(task, { waitForAutofill: 0, submit: false });
    assert.equal(r.submitted, false);
  });

  it("not ready after waitForAutofill → needsUser:true, not submitted", async () => {
    const page = fakePage([
      { detected: true, ready: false, fieldCount: 2, filledCount: 1 },
    ]);
    const task = fakeTask({ tabsResults: [{ active: true, page }] });
    const r = await loginPreflight(task, { waitForAutofill: 0 });
    assert.equal(r.needsUser, true);
    assert.equal(r.submitted, false);
  });

  it("uses options.page when provided, ignoring task.tabs()", async () => {
    const injectPage = fakePage([
      { detected: true, ready: true, fieldCount: 1, filledCount: 1 },
      true,
    ]);
    const decoyPage = fakePage([
      { detected: false, ready: false, fieldCount: 0, filledCount: 0 },
    ]);
    const task = fakeTask({
      tabsResults: [{ active: true, page: decoyPage }],
    });
    const r = await loginPreflight(task, {
      waitForAutofill: 0,
      page: injectPage,
    });
    assert.equal(r.detected, true);
    assert.equal(r.submitted, true);
  });

  it("falls back to pages()[0] when no active tab", async () => {
    const page = fakePage([
      { detected: true, ready: true, fieldCount: 1, filledCount: 1 },
      true,
    ]);
    // tabs() returns no active tab; pages() returns the page
    const task = fakeTask({
      tabsResults: [
        {
          active: false,
          page: fakePage([
            { detected: false, ready: false, fieldCount: 0, filledCount: 0 },
          ]),
        },
      ],
      pages: [page],
    });
    const r = await loginPreflight(task, { waitForAutofill: 0 });
    assert.equal(r.detected, true);
    assert.equal(r.submitted, true);
  });
});

// ---------------------------------------------------------------------------
// handleChallenge
// ---------------------------------------------------------------------------

describe("task.handleChallenge", () => {
  it("rejects non-object options", async () => {
    const task = fakeTask();
    await assert.rejects(handleChallenge(task, "bad"), /must be an object/);
  });

  it("rejects negative waitForAutomatic", async () => {
    const task = fakeTask();
    await assert.rejects(
      handleChallenge(task, { waitForAutomatic: -1 }),
      /waitForAutomatic must be non-negative/,
    );
  });

  it("rejects non-positive interval", async () => {
    const task = fakeTask();
    await assert.rejects(
      handleChallenge(task, { interval: 0 }),
      /interval must be positive/,
    );
  });

  it("no challenge present → {detected:false, handled:false}", async () => {
    const page = fakePage([{ detected: false }]);
    const task = fakeTask({ tabsResults: [{ active: true, page }] });
    const r = await handleChallenge(task, { waitForAutomatic: 0 });
    assert.deepEqual(r, { detected: false, handled: false });
  });

  it("challenge resolves automatically → resolvedAutomatically:true, handled:false", async () => {
    // First call: challenge detected; second: gone
    let call = 0;
    const page = {
      async evaluate(_fn) {
        call++;
        if (call === 1)
          return {
            detected: true,
            provider: "cloudflare",
            kind: "turnstile",
            origin: "https://example.com",
            target: ".cf-turnstile",
          };
        return { detected: false };
      },
    };
    const task = fakeTask({ tabsResults: [{ active: true, page }] });
    const r = await handleChallenge(task, {
      waitForAutomatic: 0.05,
      interval: 0.01,
    });
    assert.equal(r.detected, true);
    assert.equal(r.handled, false);
    assert.equal(r.resolvedAutomatically, true);
    assert.equal(r.provider, "cloudflare");
    assert.equal(r.kind, "turnstile");
  });

  it("challenge persists → requestUserAction called, handled:true", async () => {
    const page = fakePage([
      {
        detected: true,
        provider: "hcaptcha",
        kind: "captcha",
        origin: "https://site.test",
        target: ".h-captcha",
      },
    ]);
    const userActionResult = {
      done: true,
      visible: true,
      presentation: "hand-off",
      actionKey: "human-challenge:hcaptcha:captcha:https://site.test",
      focused: false,
      userResult: "done",
      resumed: true,
    };
    const task = fakeTask({
      tabsResults: [{ active: true, page }],
      requestUserActionResult: userActionResult,
    });
    const r = await handleChallenge(task, { waitForAutomatic: 0 });
    assert.equal(r.detected, true);
    assert.equal(r.provider, "hcaptcha");
    assert.equal(r.kind, "captcha");
    assert.equal(r.handled, true);
    assert.equal(r.userResult, "done");
    assert.equal(r.resumed, true);
  });

  it("headless → requestUserAction throws 'not visible' error", async () => {
    const page = fakePage([
      {
        detected: true,
        provider: "cloudflare",
        kind: "interstitial",
        origin: "https://site.test",
        target: "body",
      },
    ]);
    const task = fakeTask({
      tabsResults: [{ active: true, page }],
      requestUserActionThrows: new Error(
        "task.requestUserAction: the page is not visible (headless); do not ask the user to act until presentation succeeds",
      ),
    });
    await assert.rejects(
      handleChallenge(task, { waitForAutomatic: 0 }),
      /not visible \(headless\)/,
    );
  });

  it("uses options.page override", async () => {
    const injectPage = fakePage([{ detected: false }]);
    const decoyPage = fakePage([
      {
        detected: true,
        provider: "google",
        kind: "recaptcha",
        origin: "https://site.test",
        target: ".g-recaptcha",
      },
    ]);
    const task = fakeTask({
      tabsResults: [{ active: true, page: decoyPage }],
    });
    // With the inject page (no challenge), should return detected:false
    const r = await handleChallenge(task, {
      waitForAutomatic: 0,
      page: injectPage,
    });
    assert.deepEqual(r, { detected: false, handled: false });
  });
});
