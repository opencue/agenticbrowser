import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createUserActionApi, notifyUserAction } from "../src/user-action.mjs";

function fakeCdp(probes = []) {
  const calls = [];
  return {
    calls,
    attachedHint: () => "target-1",
    async call(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.attachToTarget") {
        return { sessionId: "session-1" };
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "frame-1" } } };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 41 };
      }
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("__egoUserActionProbe")) {
          return { result: { value: probes.shift() ?? null } };
        }
        if (params.expression.includes("__egoUserActionRender")) {
          return { result: { value: { targetFound: true } } };
        }
        return { result: { value: true } };
      }
      return {};
    },
  };
}

const listTabs = async () => ({
  tabs: [{ targetId: "target-1", active: true }],
});

describe("the human-action overlay", () => {
  it("shows a safe instruction panel and reports a new blocker", async () => {
    const cdp = fakeCdp([null]);
    const actions = createUserActionApi(cdp, { listTabs });

    assert.deepEqual(
      await actions.show({
        key: "login-captcha",
        instruction: "Solve the CAPTCHA, then continue.",
        target: { selector: "#captcha" },
        doneLabel: "Kész",
        cancelLabel: "Mégsem",
      }),
      {
        done: true,
        alreadyVisible: false,
        targetFound: true,
      },
    );

    const render = cdp.calls.find(
      (call) =>
        call.method === "Runtime.evaluate" &&
        call.params.expression.includes("__egoUserActionRender"),
    );
    assert.ok(render, "the panel is injected into the active page");
    assert.equal(
      render.params.contextId,
      41,
      "the decision state lives outside the website's main JavaScript world",
    );
    assert.match(render.params.expression, /Solve the CAPTCHA/);
    assert.match(render.params.expression, /#captcha/);
  });

  it("does not request another focus for the same pending blocker", async () => {
    const cdp = fakeCdp([
      { key: "login-captcha", result: null, visible: true },
    ]);
    const actions = createUserActionApi(cdp, { listTabs });

    const result = await actions.show({
      key: "login-captcha",
      instruction: "Solve the CAPTCHA.",
    });

    assert.equal(result.alreadyVisible, true);
  });

  it("waits for Done and survives a transiently missing page overlay", async () => {
    const cdp = fakeCdp([
      null,
      null,
      { key: "manual-step", result: "done", visible: true },
    ]);
    const actions = createUserActionApi(cdp, { listTabs });
    await actions.show({
      key: "manual-step",
      instruction: "Approve the sign-in.",
    });

    assert.deepEqual(
      await actions.wait({ key: "manual-step", timeoutMs: 100, pollMs: 1 }),
      { done: true, result: "done" },
    );
    assert.ok(
      cdp.calls.filter(
        (call) =>
          call.method === "Runtime.evaluate" &&
          call.params.expression.includes("__egoUserActionRender"),
      ).length >= 2,
      "a missing overlay is re-injected while the agent waits",
    );
  });

  it("clears the panel after the user decides", async () => {
    const cdp = fakeCdp([null]);
    const actions = createUserActionApi(cdp, { listTabs });
    await actions.show({ key: "manual-step", instruction: "Confirm." });
    assert.deepEqual(await actions.clear("manual-step"), { done: true });
    assert.ok(
      cdp.calls.some(
        (call) =>
          call.method === "Runtime.evaluate" &&
          call.params.expression.includes("__egoUserActionClear"),
      ),
    );
  });
});

it("uses notify-send without a shell as the presentation fallback", () => {
  const calls = [];
  const child = { on() {}, unref() {} };
  const result = notifyUserAction(
    { instruction: "Approve the login", reason: "raise-failed" },
    {
      spawnProcess(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
    },
  );

  assert.deepEqual(result, { done: true });
  assert.equal(calls[0].command, "notify-send");
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].args.join(" "), /Approve the login/);
});
