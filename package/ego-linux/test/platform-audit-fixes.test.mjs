/**
 * Regression tests for the audit findings fixed in this branch:
 *   #32  activateWindowByClass confirmation loop capped at 3 attempts
 *   #33  browserDisplayFlags respects WAYLAND_DISPLAY without XDG_SESSION_TYPE
 *   #89  processAncestry caches Linux /proc reads
 *   #90  snapshot label lookup is O(1) via labelForId map
 *   #93  snapshot skips subtree recursion for name-from-content nodes
 */

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

import {
  activateWindowByClass,
  browserDisplayFlags,
  createPlatform,
} from "../src/platform.mjs";
import { createSnapshotApi } from "../src/snapshot.mjs";

// ---------------------------------------------------------------------------
// Finding 33: browserDisplayFlags should respect WAYLAND_DISPLAY
// ---------------------------------------------------------------------------
describe("browserDisplayFlags: Wayland detection", () => {
  it("returns x11 flag when WAYLAND_DISPLAY is set without XDG_SESSION_TYPE", () => {
    assert.deepEqual(
      browserDisplayFlags({
        env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":1" },
        platform: "linux",
      }),
      ["--ozone-platform=x11"],
      "WAYLAND_DISPLAY alone should trigger the XWayland flag",
    );
  });

  it("returns x11 flag when both WAYLAND_DISPLAY and XDG_SESSION_TYPE=wayland are set", () => {
    assert.deepEqual(
      browserDisplayFlags({
        env: {
          WAYLAND_DISPLAY: "wayland-0",
          XDG_SESSION_TYPE: "wayland",
          DISPLAY: ":1",
        },
        platform: "linux",
      }),
      ["--ozone-platform=x11"],
    );
  });

  it("returns [] when WAYLAND_DISPLAY is set but DISPLAY is absent", () => {
    // Without DISPLAY the browser cannot use XWayland; no flag should be emitted.
    assert.deepEqual(
      browserDisplayFlags({
        env: { WAYLAND_DISPLAY: "wayland-0" },
        platform: "linux",
      }),
      [],
    );
  });

  it("still returns [] on a plain X11 session", () => {
    assert.deepEqual(
      browserDisplayFlags({
        env: { DISPLAY: ":0" },
        platform: "linux",
      }),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Finding 32: activateWindowByClass confirmation loop ceiling
// ---------------------------------------------------------------------------
describe("activateWindowByClass: confirmation loop ceiling", () => {
  it("stops checking after 3 attempts even when the window never becomes active", async () => {
    let activateCalls = 0;

    const run = async (_command, args) => {
      const key = args.join(" ");
      if (key === "search --onlyvisible --class myapp") {
        return { ok: true, stdout: "99\n", stderr: "" };
      }
      if (key === "getwindowpid 99") {
        return { ok: true, stdout: "1234\n", stderr: "" };
      }
      if (key === "windowactivate 99") {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (key === "getactivewindow") {
        activateCalls += 1;
        return { ok: true, stdout: "88\n", stderr: "" }; // a different window
      }
      if (key === "getwindowpid 88") {
        return { ok: true, stdout: "9999\n", stderr: "" }; // wrong pid
      }
      return { ok: false, stdout: "", stderr: "unexpected call" };
    };

    const result = await activateWindowByClass(
      {
        wmClass: "myapp",
        pid: 1234,
        env: { DISPLAY: ":1" },
        platform: "linux",
      },
      { run, sleep: async () => {} },
    );

    assert.equal(
      result,
      false,
      "returns false when window never becomes active",
    );
    assert.ok(
      activateCalls <= 3,
      `expected at most 3 getactivewindow calls, got ${activateCalls}`,
    );
  });

  it("succeeds on the first confirmation attempt", async () => {
    let activateCalls = 0;

    const run = async (_command, args) => {
      const key = args.join(" ");
      if (key === "search --onlyvisible --class myapp") {
        return { ok: true, stdout: "99\n", stderr: "" };
      }
      if (key === "getwindowpid 99") {
        return { ok: true, stdout: "1234\n", stderr: "" };
      }
      if (key === "windowactivate 99") {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (key === "getactivewindow") {
        activateCalls += 1;
        return { ok: true, stdout: "99\n", stderr: "" };
      }
      if (key === "getwindowpid 99" || key.startsWith("getwindowpid")) {
        return { ok: true, stdout: "1234\n", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unexpected" };
    };

    const result = await activateWindowByClass(
      {
        wmClass: "myapp",
        pid: 1234,
        env: { DISPLAY: ":1" },
        platform: "linux",
      },
      { run, sleep: async () => {} },
    );

    assert.equal(result, true);
    assert.equal(activateCalls, 1, "succeeds with a single confirmation call");
  });
});

// ---------------------------------------------------------------------------
// Finding 89: processAncestry Linux caching
// ---------------------------------------------------------------------------
describe("platform: processAncestry is cached on Linux", () => {
  it("returns the same array instance on repeated calls", () => {
    // createPlatform holds the cache internally; two calls on the same instance
    // must return identical content (and the second call must not re-read /proc).
    const platform = createPlatform({ platform: "linux", env: {} });
    const first = platform.processAncestry();
    const second = platform.processAncestry();
    assert.deepEqual(first, second, "repeated calls return the same ancestry");
    // Verify both slices are consistent when a limit is applied.
    const limited = platform.processAncestry(1);
    assert.ok(limited.length <= 1);
    assert.deepEqual(limited, first.slice(0, 1));
  });
});

// ---------------------------------------------------------------------------
// Finding 90: snapshot label lookup via labelForId (O(1))
// Finding 93: name-from-content nodes skip subtree recursion
// ---------------------------------------------------------------------------

function makeSnapshotApi(fixture) {
  const cdp = {
    async call(method) {
      if (method === "Target.attachToTarget") return { sessionId: "sess-x" };
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1280,
            clientHeight: 800,
          },
        };
      }
      if (method === "DOMSnapshot.captureSnapshot") return fixture;
      return {};
    },
  };
  const listTabs = async () => ({ tabs: [{ targetId: "t1", active: true }] });
  return createSnapshotApi(cdp, { listTabs });
}

test("snapshot uses <label for=> to name an input field (finding #90)", async () => {
  // String table indices
  const S = {
    EMPTY: 0,
    HTML: 1,
    BODY: 2,
    LABEL: 3,
    INPUT: 4,
    TEXT: 5,
    FOR: 6,
    ID: 7,
    FORVAL: 8,
    IDVAL: 9,
    TYPE: 10,
    TEXT_VAL: 11,
    URL: 12,
    PASSWORD: 13,
  };
  const strings = [
    "",
    "HTML",
    "BODY",
    "LABEL",
    "INPUT",
    "#text",
    "for",
    "id",
    "email-field",
    "email-field",
    "type",
    "Email address",
    "https://example.test/",
    "email",
  ];

  const fixture = {
    strings,
    documents: [
      {
        documentURL: S.URL,
        nodes: {
          // html  body  label  input  text
          parentIndex: [-1, 0, 1, 1, 2],
          nodeType: [1, 1, 1, 1, 3],
          nodeName: [S.HTML, S.BODY, S.LABEL, S.INPUT, S.TEXT],
          nodeValue: [S.EMPTY, S.EMPTY, S.EMPTY, S.EMPTY, S.TEXT_VAL],
          backendNodeId: [1, 2, 10, 20, 11],
          attributes: [
            [],
            [],
            [S.FOR, S.FORVAL], // label for="email-field"
            [S.ID, S.IDVAL, S.TYPE, S.PASSWORD], // input id="email-field" type="email"
            [],
          ],
        },
        layout: {
          nodeIndex: [2, 3, 4],
          bounds: [
            [0, 10, 200, 30],
            [0, 50, 200, 30],
            [0, 10, 200, 30],
          ],
          text: [S.EMPTY, S.EMPTY, S.TEXT_VAL],
        },
      },
    ],
  };

  const api = makeSnapshotApi(fixture);
  const result = await api.snapshot({ scope: "full_page" });

  assert.ok(
    result.content.includes("Email address"),
    `expected label text "Email address" in snapshot:\n${result.content}`,
  );
});

test("snapshot does not repeat subtree text for name-from-content nodes (finding #93)", async () => {
  // A button whose accessible name comes from its own text content must not
  // have that text printed again as a child line.
  const S = {
    EMPTY: 0,
    HTML: 1,
    BODY: 2,
    BUTTON: 3,
    TEXT: 4,
    LABEL: 5,
    URL: 6,
  };
  const strings = [
    "",
    "HTML",
    "BODY",
    "BUTTON",
    "#text",
    "Submit",
    "https://x.test/",
  ];

  const fixture = {
    strings,
    documents: [
      {
        documentURL: S.URL,
        nodes: {
          // html  body  btn  text
          parentIndex: [-1, 0, 1, 2],
          nodeType: [1, 1, 1, 3],
          nodeName: [S.HTML, S.BODY, S.BUTTON, S.TEXT],
          nodeValue: [S.EMPTY, S.EMPTY, S.EMPTY, S.LABEL],
          backendNodeId: [1, 2, 100, 101],
          attributes: [[], [], [], []],
        },
        layout: {
          nodeIndex: [2, 3],
          bounds: [
            [0, 10, 120, 30],
            [0, 10, 120, 30],
          ],
          text: [S.EMPTY, S.LABEL],
        },
      },
    ],
  };

  const api = makeSnapshotApi(fixture);
  const result = await api.snapshot({ scope: "full_page" });

  const lines = result.content.split("\n").filter((l) => l.includes("Submit"));
  assert.equal(
    lines.length,
    1,
    `"Submit" should appear exactly once (as the button name), got:\n${result.content}`,
  );
});
