import test from "node:test";
import assert from "node:assert/strict";

import { elementCenter } from "../dist/src/driver/observe.js";
import { browserRefMap } from "../dist/src/ref-state.js";
import { setOverrides } from "../dist/src/state.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installRefRuntime(t, snapshot) {
  const previousEgo = globalThis.ego;
  browserRefMap.clear();
  globalThis.ego = { snapshot };
  const restore = setOverrides({
    async cdpOverride(method) {
      assert.equal(method, "DOM.getBoxModel");
      return { model: { content: [10, 20, 30, 20, 30, 60, 10, 60] } };
    },
  });
  t.after(() => {
    restore();
    browserRefMap.clear();
    if (previousEgo === undefined) delete globalThis.ego;
    else globalThis.ego = previousEgo;
  });
}

test("concurrent first ref actions share and await the snapshot refresh", async (t) => {
  const gate = deferred();
  let snapshots = 0;
  installRefRuntime(t, async () => {
    snapshots += 1;
    await gate.promise;
    return { refs: [{ backendNodeId: 7, role: "button", name: "Save" }] };
  });

  const actions = Promise.allSettled([
    elementCenter("@7"),
    elementCenter("@7"),
  ]);
  gate.resolve();
  const results = await actions;
  for (const result of results) assert.equal(result.status, "fulfilled");
  assert.deepEqual(
    results.map((result) => result.value),
    [
      { x: 20, y: 40, sessionId: undefined },
      { x: 20, y: 40, sessionId: undefined },
    ],
  );
  assert.equal(snapshots, 1);
});

test("concurrent ref actions share refresh failures and a later action can retry", async (t) => {
  const gate = deferred();
  let snapshots = 0;
  let shouldFail = true;
  installRefRuntime(t, async () => {
    snapshots += 1;
    await gate.promise;
    if (shouldFail) throw new Error("refresh failed");
    return { refs: [{ backendNodeId: 7, role: "button", name: "Save" }] };
  });

  const actions = Promise.allSettled([
    elementCenter("@7"),
    elementCenter("@7"),
  ]);
  gate.resolve();
  for (const result of await actions) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /refresh failed/);
  }
  assert.equal(snapshots, 1);

  shouldFail = false;
  assert.deepEqual(await elementCenter("@7"), {
    x: 20,
    y: 40,
    sessionId: undefined,
  });
  assert.equal(snapshots, 2);
});
