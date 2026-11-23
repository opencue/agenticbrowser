/**
 * Unit tests for locator.mjs using fake Page objects.
 * No real browser required — exercises selector translation, chaining,
 * filter, strictness, and auto-wait logic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Locator,
  LocatorError,
  installPageLocators,
  specToV2Sel,
  describeSpec,
  _EGO_IN_PAGE,
} from "../src/locator.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake v2 Page whose evaluate() runs the provided in-page
 * function synchronously via vm / direct call (we evaluate in-process for unit
 * tests). Click / fill / etc. record calls so we can assert on them.
 */
function makeFakePage({ evaluateImpl } = {}) {
  const calls = {
    click: [],
    fill: [],
    hover: [],
    press: [],
    focus: [],
    selectOption: [],
    dragAndDrop: [],
    waitForSelector: [],
    evaluate: [],
  };

  class FakePage {
    async evaluate(fn, arg) {
      // Allow caller to supply custom evaluate implementation.
      if (evaluateImpl) return evaluateImpl(fn, arg);
      // Default: run the function directly (works for _EGO_IN_PAGE tests).
      if (typeof fn === "function") {
        // Provide minimal browser globals for in-page tests.
        return fn(arg);
      }
      throw new Error("FakePage.evaluate: fn must be a function in tests");
    }

    async click(sel, opts) {
      calls.click.push({ sel, opts });
    }
    async dblclick(sel, opts) {
      calls.click.push({ sel, opts, double: true });
    }
    async hover(sel, opts) {
      calls.hover.push({ sel, opts });
    }
    async fill(sel, value, opts) {
      calls.fill.push({ sel, value, opts });
    }
    async press(sel, key, opts) {
      calls.press.push({ sel, key, opts });
    }
    async focus(sel) {
      calls.focus.push(sel);
    }
    async selectOption(sel, value, opts) {
      calls.selectOption.push({ sel, value, opts });
    }
    async dragAndDrop(src, dst, opts) {
      calls.dragAndDrop.push({ src, dst, opts });
    }
    async waitForSelector(sel, opts) {
      calls.waitForSelector.push({ sel, opts });
      return true;
    }
  }

  installPageLocators(FakePage.prototype, (proto, name, fn) => {
    if (!(name in proto)) {
      proto[name] = fn;
      return true;
    }
    return false;
  });

  return { page: new FakePage(), calls };
}

// ---------------------------------------------------------------------------
// specToV2Sel — selector translation
// ---------------------------------------------------------------------------

describe("specToV2Sel", () => {
  it("passthrough for raw selectors", () => {
    assert.equal(specToV2Sel({ kind: "raw", sel: "#foo" }), "#foo");
    assert.equal(
      specToV2Sel({ kind: "raw", sel: "loc=role:button" }),
      "loc=role:button",
    );
    assert.equal(specToV2Sel({ kind: "raw", sel: "@21" }), "@21");
  });

  it("role without name → loc=role:", () => {
    assert.equal(
      specToV2Sel({ kind: "role", role: "button" }),
      "loc=role:button",
    );
  });

  it("role with name (exact default) → [name=...]", () => {
    assert.equal(
      specToV2Sel({ kind: "role", role: "button", name: "Sign in" }),
      'loc=role:button[name="Sign in"]',
    );
  });

  it("role with name exact=false → [name*=...]", () => {
    assert.equal(
      specToV2Sel({
        kind: "role",
        role: "textbox",
        name: "Email",
        exact: false,
      }),
      'loc=role:textbox[name*="Email"]',
    );
  });

  it("text= (inexact)", () => {
    assert.equal(
      specToV2Sel({ kind: "text", text: "Sign in", exact: false }),
      "text=Sign in",
    );
  });

  it("text= (exact)", () => {
    assert.equal(
      specToV2Sel({ kind: "text", text: "Sign in", exact: true }),
      'text="Sign in"',
    );
  });

  it("testid", () => {
    assert.equal(
      specToV2Sel({ kind: "testid", id: "my-btn" }),
      '[data-testid="my-btn"]',
    );
  });

  it("placeholder (exact)", () => {
    assert.equal(
      specToV2Sel({ kind: "placeholder", text: "Enter email", exact: true }),
      '[placeholder="Enter email"]',
    );
  });

  it("placeholder (substring)", () => {
    assert.equal(
      specToV2Sel({ kind: "placeholder", text: "email", exact: false }),
      '[placeholder*="email"]',
    );
  });

  it("altText (exact)", () => {
    assert.equal(
      specToV2Sel({ kind: "altText", text: "Logo", exact: true }),
      '[alt="Logo"]',
    );
  });

  it("title (substring)", () => {
    assert.equal(
      specToV2Sel({ kind: "title", text: "Settings", exact: false }),
      '[title*="Settings"]',
    );
  });

  it("nth on CSS selector → >> nth=N", () => {
    assert.equal(
      specToV2Sel({
        kind: "nth",
        base: { kind: "raw", sel: "button" },
        index: 2,
      }),
      "button >> nth=2",
    );
  });

  it("nth on role selector → null (in-page needed)", () => {
    assert.equal(
      specToV2Sel({
        kind: "nth",
        base: { kind: "role", role: "button" },
        index: 1,
      }),
      null,
    );
  });

  it("nth=-1 (last) on CSS → >> nth=-1", () => {
    assert.equal(
      specToV2Sel({
        kind: "nth",
        base: { kind: "raw", sel: ".item" },
        index: -1,
      }),
      ".item >> nth=-1",
    );
  });

  it("label → null (in-page needed)", () => {
    assert.equal(
      specToV2Sel({ kind: "label", text: "Email", exact: false }),
      null,
    );
  });

  it("scoped → null (in-page needed)", () => {
    assert.equal(
      specToV2Sel({
        kind: "scoped",
        ancestor: { kind: "raw", sel: ".list" },
        child: { kind: "raw", sel: "li" },
      }),
      null,
    );
  });

  it("filter → null (in-page needed)", () => {
    assert.equal(
      specToV2Sel({
        kind: "filter",
        base: { kind: "raw", sel: "li" },
        hasText: "Active",
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// installPageLocators — API shape
// ---------------------------------------------------------------------------

describe("installPageLocators", () => {
  it("adds all locator methods to prototype", () => {
    const { page } = makeFakePage();
    const methods = [
      "locator",
      "getByRole",
      "getByText",
      "getByLabel",
      "getByPlaceholder",
      "getByAltText",
      "getByTitle",
      "getByTestId",
    ];
    for (const m of methods) {
      assert.equal(
        typeof page[m],
        "function",
        `page.${m} should be a function`,
      );
    }
  });

  it("does not shadow a method v2 already has", () => {
    class Page {
      locator() {
        return "upstream";
      }
    }
    installPageLocators(Page.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        return true;
      }
      return false;
    });
    assert.equal(new Page().locator(), "upstream");
  });
});

// ---------------------------------------------------------------------------
// Locator chaining produces correct specs
// ---------------------------------------------------------------------------

describe("Locator chaining", () => {
  it("page.locator() produces raw spec", () => {
    const { page } = makeFakePage();
    const loc = page.locator("#foo");
    assert.deepEqual(loc._spec, { kind: "raw", sel: "#foo" });
  });

  it("page.getByRole produces role spec", () => {
    const { page } = makeFakePage();
    const loc = page.getByRole("button", { name: "Submit" });
    assert.deepEqual(loc._spec, {
      kind: "role",
      role: "button",
      name: "Submit",
      exact: undefined,
    });
  });

  it("page.getByText produces text spec", () => {
    const { page } = makeFakePage();
    const loc = page.getByText("Hello", { exact: true });
    assert.deepEqual(loc._spec, { kind: "text", text: "Hello", exact: true });
  });

  it("page.getByLabel produces label spec", () => {
    const { page } = makeFakePage();
    const loc = page.getByLabel("Email");
    assert.deepEqual(loc._spec, {
      kind: "label",
      text: "Email",
      exact: false,
    });
  });

  it("page.getByTestId produces testid spec", () => {
    const { page } = makeFakePage();
    const loc = page.getByTestId("my-id");
    assert.deepEqual(loc._spec, { kind: "testid", id: "my-id" });
  });

  it(".nth() produces nth spec", () => {
    const { page } = makeFakePage();
    const loc = page.locator("li").nth(2);
    assert.deepEqual(loc._spec, {
      kind: "nth",
      base: { kind: "raw", sel: "li" },
      index: 2,
    });
  });

  it(".first() is nth(0)", () => {
    const { page } = makeFakePage();
    assert.deepEqual(page.locator("li").first()._spec.index, 0);
  });

  it(".last() is nth(-1)", () => {
    const { page } = makeFakePage();
    assert.deepEqual(page.locator("li").last()._spec.index, -1);
  });

  it(".locator(sub) on a Locator produces scoped spec", () => {
    const { page } = makeFakePage();
    const loc = page.locator(".card").locator("button");
    assert.deepEqual(loc._spec, {
      kind: "scoped",
      ancestor: { kind: "raw", sel: ".card" },
      child: { kind: "raw", sel: "button" },
    });
  });

  it(".filter({hasText}) serializes string", () => {
    const { page } = makeFakePage();
    const loc = page.locator("li").filter({ hasText: "Active" });
    assert.deepEqual(loc._spec, {
      kind: "filter",
      base: { kind: "raw", sel: "li" },
      hasText: "Active",
    });
  });

  it(".filter({hasText: /regex/}) serializes regex", () => {
    const { page } = makeFakePage();
    const loc = page.locator("li").filter({ hasText: /active/i });
    assert.deepEqual(loc._spec.hasText, { regex: "active", flags: "i" });
  });

  it(".nth() rejects non-integer", () => {
    const { page } = makeFakePage();
    assert.throws(() => page.locator("li").nth(1.5), /non-negative integer/);
    assert.throws(() => page.locator("li").nth(-2), /non-negative integer/);
  });
});

// ---------------------------------------------------------------------------
// _resolve — action target resolution
// ---------------------------------------------------------------------------

describe("Locator._resolve — v2-native selectors bypass in-page marking", () => {
  it("resolves raw CSS without calling evaluate", async () => {
    const { page, calls } = makeFakePage();
    const loc = page.locator("#btn");
    const { sel } = await loc._resolve();
    assert.equal(sel, "#btn");
    assert.equal(calls.evaluate.length, 0);
  });

  it("resolves role with name without in-page marking", async () => {
    const { page } = makeFakePage();
    const loc = page.getByRole("button", { name: "Save" });
    const { sel } = await loc._resolve();
    assert.equal(sel, 'loc=role:button[name="Save"]');
  });
});

describe("Locator._resolve — in-page marking for complex specs", () => {
  it("calls evaluate with mark op and returns [data-ego-loc] selector", async () => {
    let markArg;
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        markArg = arg;
        if (arg.op === "mark") return { ok: true };
        if (arg.op === "unmark") return null;
        return null;
      },
    });
    const loc = page.getByLabel("Email");
    const { sel, cleanup } = await loc._resolve();
    assert.ok(
      sel.startsWith("[data-ego-loc="),
      `sel starts with [data-ego-loc=, got: ${sel}`,
    );
    assert.equal(markArg.op, "mark");
    assert.ok(typeof cleanup === "function");
    await cleanup();
  });

  it("retries when count=0 and within timeout", async () => {
    let attempts = 0;
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "mark") {
          attempts++;
          if (attempts < 3) return { ok: false, count: 0, candidates: [] };
          return { ok: true };
        }
        return null;
      },
    });
    const loc = page.getByLabel("Email");
    const { sel } = await loc._resolve({ timeout: 2000 });
    assert.ok(sel.startsWith("[data-ego-loc="));
    assert.equal(attempts, 3);
  });

  it("throws LocatorError when count=0 and timeout exceeded", async () => {
    const { page } = makeFakePage({
      evaluateImpl: async () => ({ ok: false, count: 0, candidates: [] }),
    });
    const loc = page.getByLabel("Missing Field");
    await assert.rejects(
      () => loc._resolve({ timeout: 0 }),
      (e) => e instanceof LocatorError && /Missing Field/.test(e.message),
    );
  });

  it("throws LocatorError immediately when count>1 (no retry)", async () => {
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "mark") {
          return {
            ok: false,
            count: 3,
            candidates: [
              { tag: "input", role: "textbox", text: "first" },
              { tag: "input", role: "textbox", text: "second" },
              { tag: "input", role: "textbox", text: "third" },
            ],
          };
        }
        return null;
      },
    });
    const loc = page.getByLabel("Email");
    const err = await loc._resolve({ timeout: 5000 }).catch((e) => e);
    assert.ok(err instanceof LocatorError);
    assert.match(err.message, /3 elements/);
    assert.match(err.message, /Locator diagnostics/);
    assert.match(err.message, /first/);
  });
});

// ---------------------------------------------------------------------------
// Actions delegate to v2 Page methods
// ---------------------------------------------------------------------------

describe("Locator actions — v2-native selectors", () => {
  it("click delegates to page.click with v2 selector", async () => {
    const { page, calls } = makeFakePage();
    await page.locator("#btn").click();
    assert.equal(calls.click.length, 1);
    assert.equal(calls.click[0].sel, "#btn");
  });

  it("fill delegates to page.fill", async () => {
    const { page, calls } = makeFakePage();
    await page.locator("input").fill("hello");
    assert.equal(calls.fill[0].sel, "input");
    assert.equal(calls.fill[0].value, "hello");
  });

  it("hover delegates to page.hover", async () => {
    const { page, calls } = makeFakePage();
    await page.locator(".menu").hover();
    assert.equal(calls.hover[0].sel, ".menu");
  });

  it("press delegates to page.press", async () => {
    const { page, calls } = makeFakePage();
    await page.locator("input").press("Enter");
    assert.equal(calls.press[0].sel, "input");
    assert.equal(calls.press[0].key, "Enter");
  });

  it("selectOption delegates to page.selectOption", async () => {
    const { page, calls } = makeFakePage();
    await page.locator("select").selectOption("blue");
    assert.equal(calls.selectOption[0].sel, "select");
    assert.equal(calls.selectOption[0].value, "blue");
  });

  it("dragTo calls page.dragAndDrop with both selectors", async () => {
    const { page, calls } = makeFakePage();
    const src = page.locator("#src");
    const dst = page.locator("#dst");
    await src.dragTo(dst);
    assert.equal(calls.dragAndDrop[0].src, "#src");
    assert.equal(calls.dragAndDrop[0].dst, "#dst");
  });
});

describe("Locator actions — in-page spec (label)", () => {
  it("click via mark → page.click([data-ego-loc]) → cleanup", async () => {
    let unmarked = false;
    const { page, calls } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "mark") return { ok: true };
        if (arg.op === "unmark") {
          unmarked = true;
          return null;
        }
        return null;
      },
    });
    await page.getByLabel("Email").click();
    assert.equal(calls.click.length, 1);
    assert.ok(calls.click[0].sel.startsWith("[data-ego-loc="));
    assert.ok(unmarked, "cleanup (unmark) must be called after action");
  });
});

// ---------------------------------------------------------------------------
// waitFor
// ---------------------------------------------------------------------------

describe("Locator.waitFor", () => {
  it("v2-native selector → page.waitForSelector", async () => {
    const { page, calls } = makeFakePage();
    await page.locator("#msg").waitFor({ state: "visible", timeout: 5000 });
    assert.equal(calls.waitForSelector.length, 1);
    assert.equal(calls.waitForSelector[0].sel, "#msg");
    assert.equal(calls.waitForSelector[0].opts.state, "visible");
  });

  it("in-page spec polls until matched", async () => {
    let calls2 = 0;
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "waitForState") {
          calls2++;
          return { matched: calls2 >= 3 };
        }
        return null;
      },
    });
    await page
      .getByLabel("Status")
      .waitFor({ state: "visible", timeout: 5000 });
    assert.ok(calls2 >= 3);
  });

  it("throws on timeout", async () => {
    const { page } = makeFakePage({
      evaluateImpl: async () => ({ matched: false }),
    });
    await assert.rejects(
      () => page.getByLabel("Never").waitFor({ state: "visible", timeout: 0 }),
      /did not reach state/,
    );
  });
});

// ---------------------------------------------------------------------------
// Reads — auto-wait and strictness
// ---------------------------------------------------------------------------

describe("Locator reads — strictness and auto-wait", () => {
  it("count() returns 0 without throwing", async () => {
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "count") return 0;
      },
    });
    const n = await page.getByLabel("Missing").count();
    assert.equal(n, 0);
  });

  it("count() returns multiple without throwing", async () => {
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "count") return 5;
      },
    });
    const n = await page.locator("button").count();
    assert.equal(n, 5);
  });

  it("textContent() throws LocatorError when 0 matches and timeout=0", async () => {
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "textContent")
          return { _strict: true, count: 0, candidates: [] };
      },
    });
    await assert.rejects(
      () => page.getByLabel("Missing").textContent({ timeout: 0 }),
      LocatorError,
    );
  });

  it("textContent() auto-waits and resolves when element appears", async () => {
    let attempts = 0;
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "textContent") {
          attempts++;
          if (attempts < 3) return { _strict: true, count: 0, candidates: [] };
          return { value: "Hello world" };
        }
      },
    });
    const text = await page.getByLabel("Msg").textContent({ timeout: 5000 });
    assert.equal(text, "Hello world");
    assert.equal(attempts, 3);
  });

  it("textContent() throws LocatorError with diagnostics for multiple matches", async () => {
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "textContent") {
          return {
            _strict: true,
            count: 2,
            candidates: [
              { tag: "p", role: "generic", text: "para one" },
              { tag: "p", role: "generic", text: "para two" },
            ],
          };
        }
      },
    });
    const err = await page
      .getByText("para")
      .textContent({ timeout: 0 })
      .catch((e) => e);
    assert.ok(err instanceof LocatorError);
    assert.match(err.message, /2 elements/);
    assert.match(err.message, /diagnostics/i);
    assert.match(err.message, /para one/);
  });

  it("isVisible() returns false without throwing for 0 matches", async () => {
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "isVisible") return { value: false };
      },
    });
    const v = await page.getByLabel("Ghost").isVisible();
    assert.equal(v, false);
  });

  it("isHidden() is the inverse of isVisible()", async () => {
    const { page } = makeFakePage({
      evaluateImpl: async (fn, arg) => {
        if (arg.op === "isVisible") return { value: true };
      },
    });
    assert.equal(await page.locator("#el").isHidden(), false);
  });

  it("@ref throws on textContent read", async () => {
    const { page } = makeFakePage();
    await assert.rejects(() => page.locator("@21").textContent(), /@ref/);
  });
});

// ---------------------------------------------------------------------------
// describeSpec — human-readable descriptions
// ---------------------------------------------------------------------------

describe("describeSpec", () => {
  it("raw → returns selector string", () => {
    assert.equal(describeSpec({ kind: "raw", sel: "#foo" }), "#foo");
  });

  it("role with name", () => {
    assert.equal(
      describeSpec({ kind: "role", role: "button", name: "Save" }),
      'role=button[name="Save"]',
    );
  });

  it("nth", () => {
    assert.equal(
      describeSpec({ kind: "nth", base: { kind: "raw", sel: "li" }, index: 2 }),
      "li >> nth=2",
    );
  });

  it("filter with hasText", () => {
    assert.match(
      describeSpec({
        kind: "filter",
        base: { kind: "raw", sel: "li" },
        hasText: "Active",
      }),
      /li.*filter/,
    );
  });
});

import { specFromSelector } from "../src/locator.mjs";

describe("specFromSelector", () => {
  it("maps snapshot selectors to readable specs and leaves the rest raw", () => {
    assert.deepEqual(specFromSelector('loc=role:button[name="Save \\"x\\""]'), {
      kind: "role",
      role: "button",
      name: 'Save "x"',
      exact: true,
    });
    assert.deepEqual(specFromSelector('loc=role:textbox[name*="Sea"]'), {
      kind: "role",
      role: "textbox",
      name: "Sea",
      exact: false,
    });
    assert.deepEqual(specFromSelector("loc=role:link"), {
      kind: "role",
      role: "link",
    });
    assert.deepEqual(specFromSelector("loc=testid:a/b"), {
      kind: "testid",
      id: "a/b",
    });
    assert.deepEqual(specFromSelector("loc=css:#x > .y"), {
      kind: "raw",
      sel: "#x > .y",
    });
    assert.deepEqual(specFromSelector('text="Hi"'), {
      kind: "text",
      text: "Hi",
      exact: true,
    });
    assert.deepEqual(specFromSelector("text=hi"), {
      kind: "text",
      text: "hi",
      exact: false,
    });
    assert.deepEqual(specFromSelector("@12"), { kind: "raw", sel: "@12" });
  });
});
