import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCursorApi } from "../src/cursor.mjs";

/** Records what the cursor asks of CDP, and hands back the shim event hooks. */
function fakeCdp() {
  const calls = [];
  const events = new Map();
  const claimed = [];
  return {
    calls,
    events,
    claimed,
    attachedHint: () => "target-1",
    onShimEvent(method, handler) {
      events.set(method, handler);
    },
    claimSession(sessionId) {
      claimed.push(sessionId);
    },
    async call(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      return {};
    },
  };
}

/** The payload each render carries, pulled back out of the injected expression. */
function renderedPayloads(cdp) {
  return cdp.calls
    .filter((call) => call.method === "Runtime.evaluate")
    .map((call) => {
      const source = call.params.expression;
      const json = source.slice(source.lastIndexOf(")(") + 2, -1);
      return JSON.parse(json);
    });
}

const listTabs = async () => ({
  tabs: [{ targetId: "target-1", active: true }],
});

describe("the cursor survives a navigation", () => {
  it("subscribes to loads, and redraws when one fires", async () => {
    const cdp = fakeCdp();
    const cursor = createCursorApi(cdp, { listTabs });

    assert.ok(
      cdp.events.has("Page.loadEventFired"),
      "a load handler is registered up front",
    );

    await cursor.watchPage();
    assert.deepEqual(cdp.claimed, ["session-1"], "the session is claimed");
    assert.ok(
      cdp.calls.some((c) => c.method === "Page.enable"),
      "and Page is enabled, or the load event never arrives",
    );

    const before = renderedPayloads(cdp).length;
    // A navigation replaces the document the overlay lives in. This is the
    // event that has to put it back.
    cdp.events.get("Page.loadEventFired")();
    await new Promise(setImmediate);

    const drawn = renderedPayloads(cdp);
    assert.ok(drawn.length > before, "the load triggers a render");

    const last = drawn[drawn.length - 1];
    assert.equal(last.visible, true, "and the overlay is visible");
    assert.equal(
      last.placed,
      true,
      "placed, so an untouched page still shows the cursor",
    );
    assert.equal(last.read, null, "any read from the old document is dropped");
  });

  it("claims each session once, however many renders happen", async () => {
    const cdp = fakeCdp();
    const cursor = createCursorApi(cdp, { listTabs });

    await cursor.watchPage();
    await cursor.watchPage();
    cursor.moveTo(10, 10);
    await new Promise(setImmediate);

    assert.deepEqual(cdp.claimed, ["session-1"]);
    assert.equal(
      cdp.calls.filter((c) => c.method === "Page.enable").length,
      1,
      "Page.enable is not re-sent on every render",
    );
  });

  it("dismisses the overlay when explicitly requested", async () => {
    const cdp = fakeCdp();
    const cursor = createCursorApi(cdp, { listTabs });

    cursor.reading();
    await new Promise(setImmediate);
    assert.equal(
      renderedPayloads(cdp).at(-1)?.visible,
      true,
      "the active process first shows its presence",
    );

    await cursor.dismiss();

    const last = renderedPayloads(cdp).at(-1);
    assert.equal(
      last?.visible,
      false,
      "the final render removes agent presence",
    );
    assert.equal(last?.read, null, "no reading sweep survives dismissal");
  });
});

describe("an action's label and the move that follows it", () => {
  // v2 sends an action's label just before the cursor move for that action;
  // the label has to land on the point the move goes to, not where it was.
  async function settle() {
    for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
  }

  it("carries a label set just before a move to the new point", async () => {
    const cdp = fakeCdp();
    const cursor = createCursorApi(cdp, { listTabs });
    cursor.moveTo(10, 10);
    await settle();
    cursor.setTaskState("counting");
    cursor.moveTo(70, 300);
    await settle();
    const last = renderedPayloads(cdp).at(-1);
    assert.equal(last.label, "counting");
    assert.equal(last.labelStale, false, "the label describes the new point");
  });

  it("lets an old label go stale when the cursor moves on later", async () => {
    const cdp = fakeCdp();
    const cursor = createCursorApi(cdp, { listTabs });
    cursor.moveTo(10, 10);
    await settle();
    cursor.setTaskState("counting");
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 350));
    cursor.moveTo(70, 300);
    await settle();
    const last = renderedPayloads(cdp).at(-1);
    assert.equal(last.label, "counting");
    assert.equal(last.labelStale, true, "a later move does not inherit it");
  });
});
