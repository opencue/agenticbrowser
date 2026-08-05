import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createWindowFit } from "../src/window-fit.mjs";

/** A cdp double that records the bounds it was asked to set. */
function fakeCdp() {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "Browser.getWindowForTarget") return { windowId: 7 };
      return {};
    },
    bounds() {
      return calls.find((c) => c.method === "Browser.setWindowBounds")?.params.bounds ?? null;
    },
  };
}

describe("createWindowFit", () => {
  it("shrinks the window to a phone viewport", async () => {
    const cdp = fakeCdp();
    await createWindowFit(cdp).follow({ width: 390, height: 844, mobile: true }, "T1");

    const bounds = cdp.bounds();
    assert.ok(bounds, "the window is resized");
    assert.equal(bounds.width, 390, "as wide as the viewport the agent emulates");
    assert.ok(
      bounds.height > 844,
      "taller than the viewport, because the window also has to hold Chrome's own chrome",
    );
  });

  it("leaves a desktop-sized emulation alone", async () => {
    const cdp = fakeCdp();
    await createWindowFit(cdp).follow({ width: 1280, height: 800 }, "T1");
    assert.equal(cdp.bounds(), null, "the window is already that size");
  });

  it("ignores a cleared override", async () => {
    const cdp = fakeCdp();
    // clearDeviceMetricsOverride arrives as a 0x0 set on some paths.
    await createWindowFit(cdp).follow({ width: 0, height: 0 }, "T1");
    assert.equal(cdp.bounds(), null, "back to the real window means leave the window be");
  });

  it("refuses a sliver Chrome would clamp anyway", async () => {
    const cdp = fakeCdp();
    await createWindowFit(cdp).follow({ width: 120, height: 600 }, "T1");
    assert.equal(cdp.bounds(), null, "too narrow to be worth following");
  });

  it("does not resize without a tab to resize", async () => {
    const cdp = fakeCdp();
    await createWindowFit(cdp).follow({ width: 390, height: 844 }, null);
    assert.equal(cdp.calls.length, 0, "nothing to act on");
  });

  it("resizes once for a repeated emulation", async () => {
    const cdp = fakeCdp();
    const fit = createWindowFit(cdp);
    await fit.follow({ width: 390, height: 844 }, "T1");
    await fit.follow({ width: 390, height: 844 }, "T1");

    const resizes = cdp.calls.filter((c) => c.method === "Browser.setWindowBounds");
    assert.equal(resizes.length, 1, "an unchanged viewport is not re-applied");
  });

  it("never lets a refusing browser fail the action", async () => {
    const angry = {
      async call() {
        throw new Error("no window here");
      },
    };
    await assert.doesNotReject(
      createWindowFit(angry).follow({ width: 390, height: 844 }, "T1"),
      "resizing is cosmetic; an automation step must not fail on it",
    );
  });
});
