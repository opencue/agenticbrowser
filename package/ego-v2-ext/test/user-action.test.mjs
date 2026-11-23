import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeUserActionOptions,
  requestUserAction,
} from "../src/user-action.mjs";

function fakes({
  ownership = "agent",
  visible = true,
  decision = "done",
  resumed = true,
} = {}) {
  const calls = [];
  const task = {
    spaceId: 7,
    name: "login",
    ownership,
    async handOff() {
      calls.push("handOff");
      this.ownership = "agentDelegatedToUser";
    },
  };
  const ego = {
    showUserAction: async (o) => (
      calls.push(["show", o.key]),
      { requestId: "r1" }
    ),
    presentTaskSpace: async (id) => (
      calls.push(["present", id]),
      visible ? { visible: true } : { visible: false, reason: "headless" }
    ),
    notifyUserAction: async (o) => calls.push(["notify", o.reason ?? null]),
    waitForUserAction: async () => (
      calls.push("wait"),
      { result: decision, resumed }
    ),
    clearUserAction: async (key) => calls.push(["clear", key]),
  };
  return { task, ego, calls };
}

describe("task.requestUserAction", () => {
  it("validates like v1", () => {
    assert.throws(
      () => normalizeUserActionOptions({ wait: true }),
      /requires a non-empty instruction/,
    );
    assert.throws(
      () => normalizeUserActionOptions({ instruction: "x", timeout: -1 }),
      /timeout/,
    );
    const o = normalizeUserActionOptions({
      instruction: "  Log   in ",
      target: "@3",
    });
    assert.equal(o.instruction, "Log in");
    assert.equal(o.wait, true);
    assert.equal(o.actionKey, 'manual:Log in:"@3"');
  });

  it("hands off, shows the card, notifies once, waits, and resumes on Done", async () => {
    const { task, ego, calls } = fakes();
    const r = await requestUserAction(
      task,
      { instruction: "Sign in", actionKey: "k" },
      ego,
    );
    assert.deepEqual(r, {
      done: true,
      visible: true,
      presentation: "hand-off",
      actionKey: "k",
      focused: false,
      requestId: "r1",
      userResult: "done",
      resumed: true,
    });
    assert.deepEqual(calls, [
      "handOff",
      ["show", "k"],
      ["present", 7],
      ["notify", null],
      "wait",
      ["clear", "k"],
    ]);
  });

  it("leaves control with the user on Cancel", async () => {
    const { task, ego } = fakes({ decision: "cancel" });
    const r = await requestUserAction(task, { instruction: "Sign in" }, ego);
    assert.equal(r.userResult, "cancel");
    assert.equal(r.resumed, false);
  });

  it("refuses to ask a user who cannot see the page", async () => {
    const { task, ego, calls } = fakes({ visible: false });
    await assert.rejects(
      requestUserAction(task, { instruction: "Sign in" }, ego),
      /not visible \(headless\)/,
    );
    // Headless has no window to act in: no desktop notice for it.
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "notify"));
  });

  it("does not hand off a space the user already owns", async () => {
    const { task, ego, calls } = fakes({ ownership: "user" });
    const r = await requestUserAction(task, { wait: false }, ego);
    assert.equal(r.presentation, "bring-to-front");
    assert.ok(!calls.includes("handOff"));
  });
});

describe("task.requestUserAction notifications", () => {
  it("still notifies when the window exists but is not visible", async () => {
    const { task, ego, calls } = fakes();
    ego.presentTaskSpace = async () => ({
      visible: false,
      reason: "minimized",
    });
    await assert.rejects(
      requestUserAction(task, { instruction: "Sign in" }, ego),
      /minimized/,
    );
    assert.deepEqual(calls.at(-1), ["notify", "minimized"]);
  });
});
