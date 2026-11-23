/**
 * Unit tests for fast.mjs pure helpers and stale-check logic using fake Pages.
 * No real browser is required.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StalePageError, formatTable } from "../src/fast.mjs";
import { installFastLoop } from "../src/fast.mjs";

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

describe("formatTable", () => {
  it("renders fill action with current value", () => {
    const table = formatTable([
      { id: "e1", kind: "fill", role: "textbox", label: "From", value: "" },
    ]);
    assert.match(table, /^\[e1\]  fill textbox  From  · empty$/m);
  });

  it("renders fill action with a non-empty value", () => {
    const table = formatTable([
      {
        id: "e1",
        kind: "fill",
        role: "searchbox",
        label: "Search",
        value: "Paris",
      },
    ]);
    assert.match(table, /^\[e1\]  fill searchbox  Search  · Paris$/m);
  });

  it("renders click action without value", () => {
    const table = formatTable([
      { id: "e2", kind: "click", role: "button", label: "Go", value: "" },
    ]);
    assert.match(table, /^\[e2\]  button  Go$/m);
  });

  it("renders select action with current_value", () => {
    const table = formatTable([
      {
        id: "e3",
        kind: "select",
        role: "combobox",
        label: "Color → Blue",
        value: "blue",
        current_value: "Red",
      },
    ]);
    assert.match(table, /^\[e3\]  combobox  Color → Blue  · Red$/m);
  });

  it("renders checked flag for a checkbox", () => {
    const table = formatTable([
      {
        id: "e4",
        kind: "click",
        role: "checkbox",
        label: "Accept",
        value: "",
        checked: "false",
      },
    ]);
    assert.match(table, /checked=false/);
  });

  it("renders scroll and wait actions", () => {
    const table = formatTable([
      { id: "scroll_down", kind: "scroll", label: "Scroll down" },
      { id: "wait", kind: "wait", label: "Wait for the page to update" },
    ]);
    assert.match(table, /^\[scroll_down\]  scroll  Scroll down$/m);
    assert.match(table, /^\[wait\]  wait  Wait for the page to update$/m);
  });

  it("collapses whitespace in labels", () => {
    const table = formatTable([
      {
        id: "e1",
        kind: "click",
        role: "button",
        label: "Save  the\ndocument",
        value: "",
      },
    ]);
    assert.match(table, /Save the document/);
  });
});

// ---------------------------------------------------------------------------
// StalePageError identity
// ---------------------------------------------------------------------------

describe("StalePageError", () => {
  it("is an Error with name StalePageError", () => {
    const e = new StalePageError("oops");
    assert.ok(e instanceof Error);
    assert.ok(e instanceof StalePageError);
    assert.equal(e.name, "StalePageError");
    assert.equal(e.message, "oops");
  });
});

// ---------------------------------------------------------------------------
// installFastLoop — adds fastObserve / fastAct only when absent
// ---------------------------------------------------------------------------

describe("installFastLoop", () => {
  it("adds fastObserve and fastAct to a plain prototype", () => {
    class Page {}
    const added = [];
    installFastLoop(Page.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        added.push(name);
        return true;
      }
      return false;
    });
    assert.deepEqual(added.sort(), ["fastAct", "fastObserve"]);
    assert.equal(typeof Page.prototype.fastObserve, "function");
    assert.equal(typeof Page.prototype.fastAct, "function");
  });

  it("does not shadow a method v2 already has", () => {
    class Page {
      fastObserve() {
        return "upstream";
      }
    }
    installFastLoop(Page.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        return true;
      }
      return false;
    });
    assert.equal(new Page().fastObserve(), "upstream");
  });
});

// ---------------------------------------------------------------------------
// fastAct — validation before any page contact
// ---------------------------------------------------------------------------

/** Build a minimal fake v2 Page with controllable evaluate/cdp/mouse/keyboard. */
function makeFakePage({ evaluateResults = [], cdpResults = {} } = {}) {
  let evalIdx = 0;
  const calls = {
    evaluate: [],
    cdp: [],
    mouseClick: [],
    mouseMove: [],
    mouseWheel: [],
    keyPress: [],
    insertText: [],
  };

  class FakePage {
    constructor() {
      this.mouse = {
        click: async (x, y) => {
          calls.mouseClick.push({ x, y });
        },
        move: async (x, y) => {
          calls.mouseMove.push({ x, y });
        },
        wheel: async (dx, dy) => {
          calls.mouseWheel.push({ dx, dy });
        },
      };
      this.keyboard = {
        press: async (chord) => {
          calls.keyPress.push(chord);
        },
        insertText: async (text) => {
          calls.insertText.push(text);
        },
      };
    }

    async evaluate(expr) {
      calls.evaluate.push(expr);
      if (evalIdx < evaluateResults.length) {
        const r = evaluateResults[evalIdx++];
        if (r instanceof Error) throw r;
        return r;
      }
      return null;
    }

    async cdp(method, params) {
      calls.cdp.push({ method, params });
      return cdpResults[method] ?? {};
    }
  }

  installFastLoop(FakePage.prototype, (proto, name, fn) => {
    if (!(name in proto)) {
      proto[name] = fn;
      return true;
    }
    return false;
  });

  return { page: new FakePage(), calls };
}

describe("fastAct — input validation (no page contact)", () => {
  const observation = {
    url: "https://example.test/",
    title: "T",
    w: 1000,
    h: 800,
    text: "",
    scroll: { y: 0, height: 800 },
    actions: [
      {
        id: "e1",
        node: 1,
        role: "textbox",
        kind: "fill",
        label: "Name",
        value: "",
      },
      {
        id: "e2",
        node: 2,
        role: "button",
        kind: "click",
        label: "Go",
        value: "",
      },
      { id: "wait", kind: "wait", label: "Wait" },
    ],
    marker: ["m"],
    page_key: ["k"],
    guards: { 1: ["g1"], 2: ["g2"] },
    omitted_actions: 0,
  };

  it("rejects an unknown id before touching the page", async () => {
    const { page, calls } = makeFakePage();
    await assert.rejects(page.fastAct(observation, "e99"), /no action "e99"/);
    assert.equal(calls.evaluate.length, 0, "no evaluate call on bad id");
  });

  it("rejects a fill action without text before touching the page", async () => {
    const { page, calls } = makeFakePage();
    await assert.rejects(page.fastAct(observation, "e1"), /requires text/);
    assert.equal(calls.evaluate.length, 0, "no evaluate call on missing text");
  });
});

describe("fastAct — stale page detection", () => {
  const observation = {
    url: "https://example.test/",
    title: "T",
    w: 1000,
    h: 800,
    text: "",
    scroll: { y: 0, height: 800 },
    actions: [
      {
        id: "e2",
        node: 2,
        role: "button",
        kind: "click",
        label: "Go",
        value: "",
      },
      {
        id: "e1",
        node: 1,
        role: "textbox",
        kind: "fill",
        label: "Name",
        value: "",
      },
      { id: "wait", kind: "wait", label: "Wait" },
    ],
    marker: ["m"],
    page_key: ["k"],
    guards: { 1: ["g1"], 2: ["g2"] },
    omitted_actions: 0,
  };

  it("throws StalePageError when guard changed for click", async () => {
    // The freshness check for click returns a changed guard
    const { page } = makeFakePage({
      evaluateResults: [[["k"], ["g2-changed"]]],
    });
    await assert.rejects(page.fastAct(observation, "e2"), StalePageError);
  });

  it("throws StalePageError when marker changed for fill", async () => {
    // For fill, freshness is checked via marker; return a changed one
    const { page } = makeFakePage({
      evaluateResults: [["m-changed"]],
    });
    await assert.rejects(
      page.fastAct(observation, "e1", "text"),
      StalePageError,
    );
  });

  it("does not dispatch input on a stale decision", async () => {
    const { page, calls } = makeFakePage({
      evaluateResults: [[["k"], ["g2-changed"]]],
    });
    await assert.rejects(page.fastAct(observation, "e2"), StalePageError);
    assert.equal(calls.mouseClick.length, 0);
    assert.equal(calls.keyPress.length, 0);
    assert.equal(calls.insertText.length, 0);
  });

  it("throws StalePageError when evaluate raises a navigation error", async () => {
    const { page } = makeFakePage({
      evaluateResults: [
        new Error(
          "JavaScript evaluation failed: Execution context was destroyed",
        ),
      ],
    });
    await assert.rejects(page.fastAct(observation, "e2"), StalePageError);
  });
});

describe("fastAct — wait action", () => {
  const observation = {
    w: 1000,
    h: 800,
    actions: [{ id: "wait", kind: "wait", label: "Wait" }],
    marker: ["m"],
    page_key: ["k"],
    guards: {},
  };

  it("executes wait without touching the page (after freshness check)", async () => {
    // marker check returns unchanged marker, then wait executes
    const { page, calls } = makeFakePage({
      evaluateResults: [["m"]], // marker matches
    });
    const result = await page.fastAct(observation, "wait");
    assert.deepEqual(result, { executed: "wait" });
    assert.equal(calls.mouseClick.length, 0);
  });
});

describe("fastAct — scroll action via evaluate(window.scrollBy)", () => {
  const observation = {
    w: 1000,
    h: 800,
    actions: [
      { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
    ],
    marker: ["m"],
    page_key: ["k"],
    guards: {},
  };

  it("calls evaluate with window.scrollBy after the freshness check", async () => {
    // marker matches for the freshness check; second call is the scrollBy
    const { page, calls } = makeFakePage({
      evaluateResults: [["m"], undefined],
    });
    const result = await page.fastAct(observation, "scroll_down");
    assert.deepEqual(result, { executed: "scroll_down" });
    // No mouse events — scroll is JS-based
    assert.equal(calls.mouseClick.length, 0);
    assert.equal(calls.mouseWheel.length, 0);
    // evaluate was called: first for the freshness marker, second for scrollBy
    assert.ok(
      calls.evaluate.some((e) => /scrollBy/.test(e)),
      `expected a scrollBy call, got: ${JSON.stringify(calls.evaluate)}`,
    );
    assert.ok(
      calls.evaluate.some((e) => /560/.test(e)),
      `expected delta 560 in a scrollBy call, got: ${JSON.stringify(calls.evaluate)}`,
    );
  });
});

describe("fastAct — fill dispatches click + keyboard", () => {
  const observation = {
    w: 1000,
    h: 800,
    actions: [
      {
        id: "e1",
        node: 1,
        role: "textbox",
        kind: "fill",
        label: "Name",
        value: "",
      },
    ],
    marker: ["m"],
    page_key: ["k"],
    guards: { 1: ["g1"] },
  };

  it("clicks the target then selects-all and inserts text, with settle=false", async () => {
    const { page, calls } = makeFakePage({
      evaluateResults: [
        ["m"], // freshness check (marker)
        { x: 50, y: 60 }, // RESOLVE_TARGET returns coords
        // settle is skipped (settle: false)
      ],
    });
    const result = await page.fastAct(observation, "e1", "Zurich", {
      settle: false,
    });
    assert.deepEqual(result, { executed: "e1" });
    // Click at the resolved coords
    assert.equal(calls.mouseClick.length, 1);
    assert.equal(calls.mouseClick[0].x, 50);
    assert.equal(calls.mouseClick[0].y, 60);
    // Select-all via keyboard
    assert.ok(
      calls.keyPress.some((k) => /control\+a/i.test(k)),
      `expected Control+a in ${JSON.stringify(calls.keyPress)}`,
    );
    // insertText with the given value
    assert.deepEqual(calls.insertText, ["Zurich"]);
  });
});

describe("fastAct — covered target raises StalePageError", () => {
  const observation = {
    w: 1000,
    h: 800,
    actions: [
      {
        id: "e2",
        node: 2,
        role: "button",
        kind: "click",
        label: "Go",
        value: "",
      },
    ],
    marker: ["m"],
    page_key: ["k"],
    guards: { 2: ["g2"] },
  };

  it("throws StalePageError when RESOLVE_TARGET returns null", async () => {
    const { page } = makeFakePage({
      evaluateResults: [
        [["k"], ["g2"]], // guard matches → not stale
        null, // RESOLVE_TARGET → covered
      ],
    });
    await assert.rejects(page.fastAct(observation, "e2"), StalePageError);
  });
});

describe("fastObserve — returns observation with table", () => {
  const fakeState = {
    url: "https://example.test/",
    title: "Example",
    w: 1000,
    h: 800,
    text: "Search",
    scroll: { y: 0, height: 800 },
    actions: [
      {
        id: "e1",
        node: 1,
        role: "textbox",
        kind: "fill",
        label: "From",
        value: "",
      },
      {
        id: "e2",
        node: 2,
        role: "button",
        kind: "click",
        label: "Go",
        value: "",
      },
      { id: "wait", kind: "wait", label: "Wait for the page to update" },
    ],
    marker: ["m"],
    page_key: ["k"],
    guards: { 1: ["g1"], 2: ["g2"] },
    omitted_actions: 0,
  };

  it("returns state with table in one evaluate call", async () => {
    const { page, calls } = makeFakePage({
      evaluateResults: [structuredClone(fakeState)],
    });
    const obs = await page.fastObserve();
    assert.equal(calls.evaluate.length, 1, "one browser call per observation");
    assert.equal(obs.url, fakeState.url);
    assert.match(obs.table, /^\[e1\]  fill textbox  From  · empty$/m);
    assert.match(obs.table, /^\[e2\]  button  Go$/m);
  });

  it("retries when document is navigating (null result)", async () => {
    // null three times then real state
    const { page } = makeFakePage({
      evaluateResults: [null, null, null, structuredClone(fakeState)],
    });
    const obs = await page.fastObserve();
    assert.equal(obs.url, fakeState.url);
  });

  it("throws StalePageError after all retries exhausted", async () => {
    // Always null; retries = 2
    const nullResults = Array.from({ length: 5 }, () => null);
    const { page } = makeFakePage({ evaluateResults: nullResults });
    await assert.rejects(page.fastObserve({ retries: 2 }), StalePageError);
  });
});
