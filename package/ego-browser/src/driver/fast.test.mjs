import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import {
  fastAct,
  fastObserve,
  StalePageError,
} from "../../dist/src/driver/fast.js";

const observed = {
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

function fakeCdp(handler) {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      return handler(method, params) ?? {};
    },
  });
  return { calls, restore };
}

test("fastObserve returns the page state with a readable table", async () => {
  const { calls, restore } = fakeCdp((method, params) => {
    if (
      method === "Runtime.evaluate" &&
      params.expression.includes("__egoFast")
    ) {
      return { result: { value: structuredClone(observed) } };
    }
  });
  try {
    const obs = await fastObserve();
    assert.equal(calls.length, 1, "one browser call per observation");
    assert.match(obs.table, /^\[e1\]  fill textbox  From  · empty$/m);
    assert.match(obs.table, /^\[e2\]  button  Go$/m);
    assert.match(obs.table, /^\[wait\]  wait  Wait for the page to update$/m);
  } finally {
    restore();
  }
});

test("fastObserve retries while the document is navigating", async () => {
  let reads = 0;
  const { restore } = fakeCdp((method) => {
    if (method === "Runtime.evaluate") {
      reads += 1;
      return {
        result: { value: reads < 3 ? null : structuredClone(observed) },
      };
    }
  });
  try {
    const obs = await fastObserve();
    assert.equal(reads, 3);
    assert.equal(obs.url, observed.url);
  } finally {
    restore();
  }
});

test("fastAct refuses a click whose target guard changed", async () => {
  const { calls, restore } = fakeCdp((method, params) => {
    if (
      method === "Runtime.evaluate" &&
      params.expression.includes("c.pageKey()")
    ) {
      return { result: { value: [["k"], ["g2-changed"]] } };
    }
  });
  try {
    await assert.rejects(fastAct(observed, "e2"), StalePageError);
    assert.ok(
      !calls.some((c) => c.method === "Input.dispatchMouseEvent"),
      "no input is dispatched on a stale decision",
    );
  } finally {
    restore();
  }
});

test("fastAct rejects a covered target", async () => {
  const { restore } = fakeCdp((method, params) => {
    if (method !== "Runtime.evaluate") return;
    if (params.expression.includes("c.pageKey()")) {
      return { result: { value: [["k"], ["g2"]] } };
    }
    if (params.expression.includes("elementFromPoint")) {
      return { result: { value: null } };
    }
  });
  try {
    await assert.rejects(fastAct(observed, "e2"), /covered/);
  } finally {
    restore();
  }
});

test("fastAct fill clicks the observed node, selects all, and inserts text", async () => {
  const { calls, restore } = fakeCdp((method, params) => {
    if (method !== "Runtime.evaluate") return;
    if (params.expression.includes("state?.marker")) {
      return { result: { value: ["m"] } };
    }
    if (params.expression.includes("elementFromPoint")) {
      return { result: { value: { x: 50, y: 60 } } };
    }
    return { result: { value: true } };
  });
  try {
    assert.deepEqual(
      await fastAct(observed, "e1", "Zurich", { settle: false }),
      {
        executed: "e1",
      },
    );
    const resolve = calls.find(
      (c) =>
        c.method === "Runtime.evaluate" &&
        c.params.expression.includes("elementFromPoint"),
    );
    assert.match(resolve.params.expression, /"node":1/);
    const pressed = calls.find(
      (c) =>
        c.method === "Input.dispatchMouseEvent" &&
        c.params.type === "mousePressed",
    );
    assert.equal(pressed.params.x, 50);
    assert.equal(pressed.params.y, 60);
    const selectAll = calls.find((c) => c.method === "Input.dispatchKeyEvent");
    assert.deepEqual(selectAll.params.commands, ["selectAll"]);
    const inserted = calls.find((c) => c.method === "Input.insertText");
    assert.equal(inserted.params.text, "Zurich");
  } finally {
    restore();
  }
});

test("fastAct validates ids and fill text before touching the page", async () => {
  const { calls, restore } = fakeCdp(() => undefined);
  try {
    await assert.rejects(fastAct(observed, "e99"), /no action "e99"/);
    await assert.rejects(fastAct(observed, "e1"), /requires text/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});
