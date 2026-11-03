import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSessionResolver } from "../src/session.mjs";

function fakeCdp(hintFn) {
  const calls = [];
  return {
    calls,
    attachedHint: hintFn,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "Target.attachToTarget") {
        return { sessionId: `session-for-${params.targetId}` };
      }
      return {};
    },
  };
}

const listTabs = async () => ({
  tabs: [{ targetId: "target-1", active: true }],
});

describe("createSessionResolver", () => {
  it("returns a cached sessionId on repeat calls for the same target", async () => {
    const cdp = fakeCdp(() => "target-1");
    const sessionForActiveTab = createSessionResolver(cdp, {
      listTabs,
      op: "test",
    });

    const s1 = await sessionForActiveTab();
    assert.equal(s1, "session-for-target-1");
    assert.equal(
      cdp.calls.filter((c) => c.method === "Target.attachToTarget").length,
      1,
      "first call attaches once",
    );

    const s2 = await sessionForActiveTab();
    assert.equal(
      s2,
      "session-for-target-1",
      "same session returned from cache",
    );
    assert.equal(
      cdp.calls.filter((c) => c.method === "Target.attachToTarget").length,
      1,
      "cache hit — no re-attach",
    );
  });

  it("re-attaches when attachedHint changes to a different targetId", async () => {
    let hint = "target-1";
    const cdp = fakeCdp(() => hint);
    const sessionForActiveTab = createSessionResolver(cdp, {
      listTabs,
      op: "test",
    });

    const s1 = await sessionForActiveTab();
    assert.equal(s1, "session-for-target-1");

    // Simulate a tab switch — the attached hint now points to a different target.
    hint = "target-2";
    const s2 = await sessionForActiveTab();
    assert.equal(s2, "session-for-target-2", "new target gets its own session");

    const attachCalls = cdp.calls.filter(
      (c) => c.method === "Target.attachToTarget",
    );
    assert.equal(
      attachCalls.length,
      2,
      "Target.attachToTarget called for each distinct target",
    );
    assert.equal(attachCalls[0].params.targetId, "target-1");
    assert.equal(attachCalls[1].params.targetId, "target-2");
  });

  it("falls back to listTabs when attachedHint is absent", async () => {
    // cdp without attachedHint — resolver must fall back to tab listing
    const calls = [];
    const cdp = {
      calls,
      async call(method, params) {
        calls.push({ method, params });
        if (method === "Target.attachToTarget") {
          return { sessionId: `session-for-${params.targetId}` };
        }
        return {};
      },
    };
    const tabs = async () => ({
      tabs: [{ targetId: "tab-target", active: true }],
    });
    const sessionForActiveTab = createSessionResolver(cdp, {
      listTabs: tabs,
      op: "test",
    });

    const s = await sessionForActiveTab();
    assert.equal(s, "session-for-tab-target");
  });
});
