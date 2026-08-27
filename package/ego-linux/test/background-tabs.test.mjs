import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTabsApi } from "../src/tabs.mjs";

function fakeCdp() {
  const calls = [];
  return {
    calls,
    selectedTargetId: null,
    selectTarget(targetId) {
      this.selectedTargetId = targetId;
    },
    async call(method, params) {
      calls.push({ method, params });
      if (method === "Target.createTarget") return { targetId: "new-tab" };
      return {};
    },
  };
}

describe("agent tab foreground policy", () => {
  it("keeps a new agent tab behind an unrelated user view", async () => {
    const cdp = fakeCdp();
    const guarded = [];
    const tabs = createTabsApi(cdp, {
      port: null,
      getScope: null,
      shouldAutoFocus: async () => false,
      guardBackground: async (reason, operation) => {
        guarded.push(reason);
        return operation();
      },
    });

    const result = await tabs.createTab("https://example.com");

    assert.equal(result.targetId, "new-tab");
    assert.equal(
      cdp.selectedTargetId,
      "new-tab",
      "the agent still selects its background target logically",
    );
    assert.deepEqual(cdp.calls[0], {
      method: "Target.createTarget",
      params: {
        url: "https://example.com",
        background: true,
        focus: false,
      },
    });
    assert.ok(
      !cdp.calls.some((call) => call.method === "Target.activateTarget"),
      "the user's current tab keeps the foreground",
    );
    assert.deepEqual(guarded, ["create-tab"]);
  });

  it("preserves activation for integrations that explicitly opt into it", async () => {
    const cdp = fakeCdp();
    let guarded = false;
    const tabs = createTabsApi(cdp, {
      port: null,
      getScope: null,
      guardBackground: async (_reason, operation) => {
        guarded = true;
        return operation();
      },
    });

    await tabs.createTab("https://example.com");

    assert.ok(
      cdp.calls.some(
        (call) =>
          call.method === "Target.activateTarget" &&
          call.params.targetId === "new-tab",
      ),
      "ordinary browser sessions still focus the tab they create",
    );
    assert.equal(guarded, false, "explicit foreground creation is not guarded");
  });
});
