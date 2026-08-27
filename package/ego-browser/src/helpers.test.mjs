import test from "node:test";
import assert from "node:assert/strict";

import * as helperExports from "../dist/src/helpers.js";
import { setOverrides, state } from "../dist/src/state.js";
import {
  bringToFrontTaskSpace,
  claimTaskSpace,
  completeTaskSpace,
  executeTaskSpace,
  handleChallengeTaskSpace,
  handOffTaskSpace,
  loginPreflightTaskSpace,
  requestUserActionTaskSpace,
  newTaskSpace,
  helperContext,
  isEgoHardStopError,
  listTaskSpaces,
  runTaskSpace,
  useOrCreateTaskSpace,
  switchTaskSpace,
  takeOverTaskSpace,
  waitForAgentControl,
} from "../dist/src/helpers.js";

function withEgo(ego, fn) {
  const previous = globalThis.ego;
  globalThis.ego = ego;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("listTaskSpaces normalizes the current taskSpaces binding shape", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "Checkout flow",
              createdBy: "agent",
              ownership: "agent",
              recentTabTitles: ["Checkout", "Cart"],
            },
          ],
        };
      },
    },
    async () => {
      assert.deepEqual(await listTaskSpaces(), [
        {
          taskId: "checkout-flow",
          id: 7,
          name: "Checkout flow",
          createdBy: "agent",
          ownership: "agent",
          recentTabTitles: ["Checkout", "Cart"],
        },
      ]);
    },
  );
});

test("listTaskSpaces rejects legacy taskIds results", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return { taskIds: ["checkout-flow", "research-session"] };
      },
    },
    async () => {
      await assert.rejects(
        () => listTaskSpaces(),
        /listTaskSpaces expected \{ taskSpaces: \[\.\.\.\] \}/,
      );
    },
  );
});

test("listTaskSpaces throws on binding error objects", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return { error: "The task is under user control" };
      },
    },
    async () => {
      await assert.rejects(
        () => listTaskSpaces(),
        /listTaskSpaces: The task is under user control/,
      );
    },
  );
});

test("helper surface exposes Playwright-style object facades", () => {
  const context = helperContext();
  assert.equal(typeof context.page, "object");
  assert.equal(typeof context.page.goto, "function");
  assert.equal(typeof context.page.locator, "function");
  assert.equal(typeof context.page.getByText, "function");
  assert.equal(typeof context.page.getByLabel, "function");
  assert.equal(typeof context.page.getByPlaceholder, "function");
  assert.equal(typeof context.page.getByAltText, "function");
  assert.equal(typeof context.page.getByTitle, "function");
  assert.equal(typeof context.page.getByTestId, "function");
  assert.equal(typeof context.page.waitForLoadState, "function");
  assert.equal(typeof context.page.waitForURL, "function");
  assert.equal(typeof context.page.waitForRequest, "function");
  assert.equal(typeof context.page.waitForResponse, "function");
  assert.equal(typeof context.page.debug, "function");
  assert.equal(typeof context.page.trace, "function");
  assert.equal(typeof context.page.screencast, "object");
  assert.equal(typeof context.page.screencast.start, "function");
  assert.equal(typeof context.page.screencast.stop, "function");
  assert.equal(typeof context.page.keyboard.press, "function");
  assert.equal(typeof context.page.keyboard.down, "function");
  assert.equal(typeof context.page.keyboard.up, "function");
  assert.equal(typeof context.page.keyboard.type, "function");
  assert.equal(typeof context.page.mouse.click, "function");
  assert.equal(typeof context.page.mouse.down, "function");
  assert.equal(typeof context.page.mouse.up, "function");
  assert.equal(typeof context.page.mouse.drag, "function");
  const locator = context.page.locator("#target");
  assert.equal(typeof locator.click, "function");
  assert.equal(typeof locator.fill, "function");
  assert.equal(typeof locator.press, "function");
  assert.equal(typeof locator.locator, "function");
  assert.equal(typeof locator.getByRole, "function");
  assert.equal(typeof locator.getByText, "function");
  assert.equal(typeof locator.getByLabel, "function");
  assert.equal(typeof locator.getByPlaceholder, "function");
  assert.equal(typeof locator.getByAltText, "function");
  assert.equal(typeof locator.getByTitle, "function");
  assert.equal(typeof locator.getByTestId, "function");
  assert.equal(typeof locator.filter, "function");
  assert.equal(typeof locator.clear, "function");
  assert.equal(typeof locator.blur, "function");
  assert.equal(typeof locator.innerHTML, "function");
  assert.equal(typeof locator.isVisible, "function");
  assert.equal(typeof locator.isHidden, "function");
  assert.equal(typeof locator.isEnabled, "function");
  assert.equal(typeof locator.isDisabled, "function");
  assert.equal(typeof locator.isEditable, "function");
  assert.equal(typeof locator.boundingBox, "function");
  assert.equal(typeof locator.screenshot, "function");
  assert.equal(typeof locator.first, "function");
  assert.equal(typeof locator.nth, "function");
  assert.equal(typeof locator.last, "function");
  assert.equal(typeof locator.nth(1).click, "function");
  assert.equal(typeof locator.evaluate, "function");
  assert.equal(typeof locator.evaluateAll, "function");
  assert.equal(typeof locator.extractAll, "undefined");
  assert.equal(typeof context.page.getByText("Allow").click, "function");
  assert.equal(typeof context.page.getByLabel("Email").fill, "function");
  assert.equal(
    context.page.getByTestId("submit").selector,
    'loc=testid:exact:"submit"',
  );
  const roleRegexSelector = context.page.getByRole("button", {
    name: /New York \(JFK\)/i,
  }).selector;
  assert.match(roleRegexSelector, /^loc=role:button\[name=/);
  assert.deepEqual(
    JSON.parse(roleRegexSelector.match(/\[name=([\s\S]+)\]$/)[1]),
    {
      regex: "New York \\(JFK\\)",
      flags: "i",
    },
  );
  assert.deepEqual(
    JSON.parse(
      decodeURIComponent(
        locator.getByText("Save").selector.slice("internal:scope:".length),
      ),
    ),
    { base: "#target", child: 'loc=text:"Save"' },
  );
  assert.deepEqual(
    JSON.parse(
      decodeURIComponent(
        locator
          .filter({ hasText: /Ready/i })
          .selector.slice("internal:filter:".length),
      ),
    ),
    { base: "#target", hasText: { regex: "Ready", flags: "i" } },
  );
  const scopedRole = JSON.parse(
    decodeURIComponent(
      locator
        .getByRole("button", { name: /Save/i })
        .selector.slice("internal:scope:".length),
    ),
  );
  assert.equal(scopedRole.base, "#target");
  assert.deepEqual(
    JSON.parse(scopedRole.child.match(/\[name=([\s\S]+)\]$/)[1]),
    {
      regex: "Save",
      flags: "i",
    },
  );
  assert.equal(typeof context.page.setDefaultTimeout, "function");
  assert.equal(typeof context.page.waitForEvent, "function");
  assert.equal(typeof context.browser.openOrReuseTab, "function");
  assert.equal(typeof context.browser.closeTab, "function");
  assert.equal(typeof context.taskSpaces.useOrCreate, "function");
  assert.equal(typeof context.taskSpaces.run, "function");
  assert.equal(typeof context.taskSpaces.execute, "function");
  assert.equal(typeof context.taskSpaces.claim, "function");
  assert.equal(typeof context.taskSpaces.bringToFront, "function");
  assert.equal(typeof context.taskSpaces.requestUserAction, "function");
  assert.equal(typeof context.taskSpaces.loginPreflight, "function");
  assert.equal(typeof context.taskSpaces.handleChallenge, "function");
  assert.equal(typeof context.taskSpaces.isHardStopError, "function");
  assert.equal(typeof context.site.runTool, "function");
  assert.equal(typeof context.fetch.server, "function");
  assert.equal(typeof context.fetch.browser, "function");
  assert.equal(typeof context.cdp, "function");
  assert.equal(typeof context.help, "function");
  assert.equal(typeof isEgoHardStopError, "function");
  assert.equal(typeof helperExports.focus, "function");
  assert.equal(typeof helperExports.waitForRequest, "function");
  assert.equal(typeof helperExports.waitForResponse, "function");
  assert.equal(typeof context.focus, "undefined");
  assert.equal(typeof context.click, "undefined");
  assert.equal(typeof context.fill, "undefined");
  assert.equal(typeof context.goto, "undefined");
  assert.equal(typeof context.evaluate, "undefined");
  assert.equal("newTab" in helperExports, false);
  assert.equal("newTab" in context, false);
  assert.equal("elementEval" in helperExports, false);
  assert.equal("elementEval" in context, false);
});

test("help exposes test id exact-default locator guidance", () => {
  const context = helperContext();
  assert.match(context.help("locator"), /data-testid="foo" exactly/);
  assert.match(context.help("page.locator"), /data-testid="foo" exactly/);
  assert.match(context.help("page.locator"), /settings__visibilityToggle/);
  assert.match(context.help("page.getByTestId"), /complete data-testid/);
  assert.match(context.help("page.getByTestId"), /settings__visibilityToggle/);
  assert.doesNotMatch(context.help(), /settings__visibilityToggle/);
});

test("page.mouse.drag accepts Playwright-style from/to arguments", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await helperContext().page.mouse.drag([10, 20], [30, 40], {
      button: "right",
      delay: 1,
    });
  } finally {
    restore();
  }

  assert.deepEqual(
    calls
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => ({
        type: call.params.type,
        x: call.params.x,
        y: call.params.y,
        button: call.params.button,
        buttons: call.params.buttons,
      })),
    [
      { type: "mousePressed", x: 10, y: 20, button: "right", buttons: 2 },
      { type: "mouseMoved", x: 30, y: 40, button: "right", buttons: 2 },
      { type: "mouseReleased", x: 30, y: 40, button: "right", buttons: 0 },
    ],
  );
});

test("page.mouse.drag keeps path-array arguments working", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await helperContext().page.mouse.drag(
      [
        [10, 20],
        [20, 30],
        [30, 40],
      ],
      { delay: 1 },
    );
  } finally {
    restore();
  }

  assert.deepEqual(
    calls
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => ({
        type: call.params.type,
        x: call.params.x,
        y: call.params.y,
      })),
    [
      { type: "mousePressed", x: 10, y: 20 },
      { type: "mouseMoved", x: 20, y: 30 },
      { type: "mouseMoved", x: 30, y: 40 },
      { type: "mouseReleased", x: 30, y: 40 },
    ],
  );
});

test("page.mouse.drag explains a missing destination", async () => {
  await assert.rejects(
    async () => helperContext().page.mouse.drag({ x: 10, y: 20 }),
    /page\.mouse\.drag requires a destination/,
  );
});

test("help exposes nested page.mouse.drag guidance", () => {
  const context = helperContext();
  assert.match(context.help("page.mouse.drag"), /from, to/);
  assert.match(context.help("page.mouse.drag"), /ordered path/);
  assert.match(context.help(), /page\.mouse\.drag\(from, to/);
  assert.doesNotMatch(context.help(), /ordered path/);
});

test("help exposes nested taskSpaces.takeOver guidance", () => {
  const context = helperContext();
  assert.match(context.help("taskSpaces.takeOver"), /Promise<void>/);
  assert.match(context.help("taskSpaces.takeOver"), /claims that space/);
  assert.doesNotMatch(context.help(), /taskSpaces\.takeOver\(nameOrId\?\) =>/);
});

test("help exposes nested taskSpaces.bringToFront guidance", () => {
  const context = helperContext();
  assert.match(context.help("taskSpaces.bringToFront"), /Promise<object>/);
  assert.match(context.help("taskSpaces.bringToFront"), /without selecting/);
  assert.doesNotMatch(
    context.help(),
    /taskSpaces\.bringToFront\(nameOrId\) =>/,
  );
});

test("help exposes nested taskSpaces.requestUserAction guidance", () => {
  const context = helperContext();
  assert.match(
    context.help("taskSpaces.requestUserAction"),
    /require visible: true/,
  );
  assert.match(
    context.help(),
    /taskSpaces\.requestUserAction\(nameOrId, options\)/,
  );
});

test("taskSpaces.isHardStopError identifies errors that must not be retried", () => {
  const context = helperContext();
  const userControl = Object.assign(new Error("anything"), {
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  const inactive = { error_code: "EGO_TASK_SPACE_INACTIVE" };
  const ordinary = Object.assign(new Error("selector missing"), {
    error_code: "EGO_OPERATION_FAILED",
  });

  assert.equal(context.taskSpaces.isHardStopError(userControl), true);
  assert.equal(context.taskSpaces.isHardStopError(inactive), true);
  assert.equal(context.taskSpaces.isHardStopError(ordinary), false);
  assert.equal(isEgoHardStopError(userControl), true);
});

test("runTaskSpace completes a successful one-round task", async () => {
  const calls = [];
  const spaces = [];
  const restore = setOverrides({ defaultTimeout: 9999 });
  try {
    await withEgo(
      {
        async listTaskSpaces() {
          calls.push(["listTaskSpaces"]);
          return { taskSpaces: spaces.map((space) => ({ ...space })) };
        },
        async createTaskSpace(name) {
          calls.push(["createTaskSpace", name]);
          const created = { taskId: name, id: 7, name, ownership: "agent" };
          spaces.push(created);
          return created;
        },
        async useTaskSpace(id) {
          calls.push(["useTaskSpace", id]);
          return { done: true };
        },
        async closeTaskSpace() {
          calls.push(["closeTaskSpace"]);
          spaces.length = 0;
          return { done: true };
        },
      },
      async () => {
        const out = await runTaskSpace(
          "checkout-flow",
          async (task) => {
            assert.equal(task.id, 7);
            assert.equal(state.defaultTimeout, 1234);
            return "ok";
          },
          { timeout: 1234 },
        );
        assert.equal(out.result, "ok");
        assert.deepEqual(out.completion, { done: true });
      },
    );
    assert.equal(state.defaultTimeout, 9999);
  } finally {
    restore();
  }
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 7],
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["closeTaskSpace"],
  ]);
});

test("runTaskSpace never auto-claims or completes a read-only user space", async () => {
  const calls = [];
  const restore = setOverrides({
    selectedTaskSpaceId: null,
    taskSpaceReadOnly: false,
  });
  try {
    await withEgo(
      {
        async listTaskSpaces() {
          calls.push(["listTaskSpaces"]);
          return {
            taskSpaces: [
              {
                taskId: "user-review",
                id: 7,
                name: "user-review",
                ownership: "user",
              },
            ],
          };
        },
        async useTaskSpace(id) {
          calls.push(["useTaskSpace", id]);
          return { done: true, readOnly: true };
        },
        async claimTaskSpace() {
          calls.push(["claimTaskSpace"]);
          throw new Error("read-only run must not claim");
        },
        async closeTaskSpace() {
          calls.push(["closeTaskSpace"]);
          throw new Error("read-only run must not close");
        },
      },
      async () => {
        const out = await runTaskSpace("user-review", async (task) => {
          assert.equal(task.ownership, "user");
          assert.equal(state.taskSpaceReadOnly, true);
          return "verified";
        });
        assert.equal(out.result, "verified");
        assert.deepEqual(out.completion, {
          done: false,
          skipped: "user-owned",
        });
      },
    );
  } finally {
    restore();
  }
  assert.deepEqual(calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("runTaskSpace validates timeout before touching task spaces", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
    },
    async () => {
      await assert.rejects(
        () => runTaskSpace("checkout-flow", async () => {}, { timeout: -1 }),
        /timeout must be a non-negative number/,
      );
    },
  );
  assert.deepEqual(calls, []);
});

test("runTaskSpace leaves the space open when the callback fails", async () => {
  const calls = [];
  const spaces = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: spaces.map((space) => ({ ...space })) };
      },
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        const created = { taskId: name, id: 7, name, ownership: "agent" };
        spaces.push(created);
        return created;
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return { done: true };
      },
      async closeTaskSpace() {
        calls.push(["closeTaskSpace"]);
        return { done: true };
      },
    },
    async () => {
      await assert.rejects(
        () =>
          runTaskSpace("checkout-flow", async () => {
            throw new Error("boom");
          }),
        /boom/,
      );
      assert.equal(spaces.length, 1, "failed task space remains for debugging");
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 7],
  ]);
});

test("executeTaskSpace completes only after explicit verification succeeds", async () => {
  const calls = [];
  const spaces = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: spaces.map((space) => ({ ...space })) };
      },
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        const created = { taskId: name, id: 7, name, ownership: "agent" };
        spaces.push(created);
        return created;
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return { done: true };
      },
      async closeTaskSpace() {
        calls.push(["closeTaskSpace"]);
        spaces.length = 0;
        return { done: true };
      },
    },
    async () => {
      const out = await executeTaskSpace("verified-search", {
        goal: "return a verified result",
        risk: "destructive",
        async work({ task, attempt }) {
          calls.push(["work", task.id, attempt]);
          return { found: 3 };
        },
        async verify({ result, attempt }) {
          calls.push(["verify", result.found, attempt]);
          return { ok: result.found === 3, evidence: "three results" };
        },
      });

      assert.deepEqual(out.result, { found: 3 });
      assert.deepEqual(out.verification, {
        ok: true,
        evidence: "three results",
      });
      assert.equal(out.attempts, 1);
      assert.equal(out.receipt.status, "verified");
      assert.equal(out.receipt.risk, "destructive");
      assert.deepEqual(out.completion, { done: true });
    },
  );

  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "verified-search"],
    ["useTaskSpace", 7],
    ["work", 7, 1],
    ["verify", 3, 1],
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["closeTaskSpace"],
  ]);
});

test("executeTaskSpace retries failed verification for read-only work", async () => {
  const spaces = [];
  let workCalls = 0;
  await withEgo(
    {
      async listTaskSpaces() {
        return { taskSpaces: spaces.map((space) => ({ ...space })) };
      },
      async createTaskSpace(name) {
        const created = { taskId: name, id: 7, name, ownership: "agent" };
        spaces.push(created);
        return created;
      },
      async useTaskSpace() {
        return { done: true };
      },
    },
    async () => {
      const out = await executeTaskSpace("eventual-result", {
        risk: "read-only",
        retries: { max: 2, delay: 0, on: ["verification"] },
        complete: false,
        async work({ attempt, previousVerification }) {
          workCalls += 1;
          assert.equal(previousVerification?.ok ?? false, false);
          return attempt;
        },
        async verify({ result }) {
          return { ok: result === 2, observed: result };
        },
      });

      assert.equal(out.result, 2);
      assert.equal(out.attempts, 2);
      assert.deepEqual(
        out.receipt.attempts.map((attempt) => attempt.outcome),
        ["verification-failed", "verified"],
      );
      assert.deepEqual(out.completion, { done: false, skipped: "disabled" });
    },
  );
  assert.equal(workCalls, 2);
  assert.equal(spaces.length, 1);
});

test("executeTaskSpace retries ordinary read-only work errors", async () => {
  const spaces = [];
  let workCalls = 0;
  await withEgo(
    {
      async listTaskSpaces() {
        return { taskSpaces: spaces.map((space) => ({ ...space })) };
      },
      async createTaskSpace(name) {
        const created = { taskId: name, id: 7, name, ownership: "agent" };
        spaces.push(created);
        return created;
      },
      async useTaskSpace() {
        return { done: true };
      },
    },
    async () => {
      const out = await executeTaskSpace("retry-read", {
        risk: "read-only",
        retries: { max: 1, delay: 0, on: ["error"] },
        complete: false,
        async work() {
          workCalls += 1;
          if (workCalls === 1) throw new Error("temporary read failure");
          return "ready";
        },
        async verify({ result }) {
          return result === "ready";
        },
      });

      assert.equal(out.result, "ready");
      assert.deepEqual(
        out.receipt.attempts.map((attempt) => attempt.outcome),
        ["error", "verified"],
      );
    },
  );
  assert.equal(workCalls, 2);
});

test("executeTaskSpace attaches its receipt when completion fails", async () => {
  const spaces = [];
  await withEgo(
    {
      async listTaskSpaces() {
        return { taskSpaces: spaces.map((space) => ({ ...space })) };
      },
      async createTaskSpace(name) {
        const created = { taskId: name, id: 7, name, ownership: "agent" };
        spaces.push(created);
        return created;
      },
      async useTaskSpace() {
        return { done: true };
      },
      async closeTaskSpace() {
        throw new Error("close failed");
      },
    },
    async () => {
      await assert.rejects(
        () =>
          executeTaskSpace("completion-failure", {
            risk: "destructive",
            work() {
              return "done";
            },
            verify() {
              return true;
            },
          }),
        (error) => {
          assert.match(error.message, /close failed/);
          assert.equal(error.executionReceipt.status, "completion-failed");
          assert.equal(error.executionReceipt.attempts[0].outcome, "verified");
          return true;
        },
      );
    },
  );
});

test("executeTaskSpace leaves the space open when verification is exhausted", async () => {
  const spaces = [];
  await withEgo(
    {
      async listTaskSpaces() {
        return { taskSpaces: spaces.map((space) => ({ ...space })) };
      },
      async createTaskSpace(name) {
        const created = { taskId: name, id: 7, name, ownership: "agent" };
        spaces.push(created);
        return created;
      },
      async useTaskSpace() {
        return { done: true };
      },
      async closeTaskSpace() {
        assert.fail("unverified work must not complete its task space");
      },
    },
    async () => {
      await assert.rejects(
        () =>
          executeTaskSpace("unverified-result", {
            risk: "read-only",
            retries: { max: 1, delay: 0 },
            async work({ attempt }) {
              return attempt;
            },
            async verify({ result }) {
              return { ok: false, message: `result ${result} is not ready` };
            },
          }),
        (error) => {
          assert.equal(
            error.error_code,
            "EGO_TASK_EXECUTION_VERIFICATION_FAILED",
          );
          assert.equal(error.executionReceipt.status, "failed");
          assert.equal(error.executionReceipt.attempts.length, 2);
          assert.match(error.message, /result 2 is not ready/);
          return true;
        },
      );
    },
  );
  assert.equal(spaces.length, 1);
});

test("executeTaskSpace never retries task-space hard stops", async () => {
  const spaces = [];
  const hardStop = Object.assign(new Error("user is controlling"), {
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  let workCalls = 0;
  await withEgo(
    {
      async listTaskSpaces() {
        return { taskSpaces: spaces.map((space) => ({ ...space })) };
      },
      async createTaskSpace(name) {
        const created = { taskId: name, id: 7, name, ownership: "agent" };
        spaces.push(created);
        return created;
      },
      async useTaskSpace() {
        return { done: true };
      },
    },
    async () => {
      await assert.rejects(
        () =>
          executeTaskSpace("handoff", {
            risk: "read-only",
            retries: { max: 5, delay: 0 },
            async work() {
              workCalls += 1;
              throw hardStop;
            },
            async verify() {
              assert.fail("verify must not run after a hard stop");
            },
          }),
        (error) => error === hardStop,
      );
    },
  );
  assert.equal(workCalls, 1);
});

test("executeTaskSpace validates retry safety before touching task spaces", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
    },
    async () => {
      await assert.rejects(
        () =>
          executeTaskSpace("unsafe-retry", {
            risk: "reversible",
            retries: { max: 1 },
            work() {},
            verify() {
              return true;
            },
          }),
        (error) => {
          assert.equal(error.error_code, "EGO_TASK_EXECUTION_CONTRACT");
          assert.match(error.message, /require risk: "read-only"/);
          return true;
        },
      );
    },
  );
  assert.deepEqual(calls, []);
});

test("executeTaskSpace rejects an invalid verification contract without retrying", async () => {
  const spaces = [];
  let workCalls = 0;
  await withEgo(
    {
      async listTaskSpaces() {
        return { taskSpaces: spaces.map((space) => ({ ...space })) };
      },
      async createTaskSpace(name) {
        const created = { taskId: name, id: 7, name, ownership: "agent" };
        spaces.push(created);
        return created;
      },
      async useTaskSpace() {
        return { done: true };
      },
    },
    async () => {
      await assert.rejects(
        () =>
          executeTaskSpace("bad-verifier", {
            risk: "read-only",
            retries: { max: 3, delay: 0 },
            work() {
              workCalls += 1;
            },
            verify() {
              return { evidence: "missing ok" };
            },
          }),
        (error) => {
          assert.equal(error.error_code, "EGO_TASK_EXECUTION_CONTRACT");
          assert.equal(error.executionReceipt.attempts.length, 1);
          return true;
        },
      );
    },
  );
  assert.equal(workCalls, 1);
});

test("page.url reads the current URL asynchronously", async () => {
  const restore = setOverrides({
    cdpOverride: async (method) => {
      assert.equal(method, "Runtime.evaluate");
      return {
        result: {
          value: JSON.stringify({
            url: "https://example.com/current",
            title: "Current",
            w: 800,
            h: 600,
            sx: 0,
            sy: 0,
            pw: 800,
            ph: 600,
          }),
        },
      };
    },
  });
  try {
    const value = helperContext().page.url();
    assert.equal(typeof value.then, "function");
    assert.equal(await value, "https://example.com/current");
  } finally {
    restore();
  }
});

test("page.debug returns a structured redacted dump for agents", async () => {
  await helperExports.drainEvents();
  await helperExports.trace({ limit: 0 });
  const writes = [];
  const restore = setOverrides({
    now: () => Date.parse("2026-08-13T00:00:00.000Z"),
    writeFile: async (path, data) => {
      writes.push({ path, data });
    },
    cdpOverride: async (method, params) => {
      if (method === "Runtime.evaluate") {
        if (params.expression === "window.devicePixelRatio") {
          return { result: { value: 1 } };
        }
        return {
          result: {
            value: JSON.stringify({
              url: "https://example.com/path?token=secret#frag",
              title: "Debug target",
              w: 800,
              h: 600,
              sx: 10,
              sy: 20,
              pw: 1000,
              ph: 1200,
            }),
          },
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: Buffer.from("png").toString("base64") };
      }
      throw new Error(`unexpected CDP method ${method}`);
    },
  });
  try {
    await withEgo(
      {
        async listTabs() {
          return {
            tabs: [
              {
                targetId: "tab-1",
                title: "Debug target",
                url: "https://example.com/path?token=secret#frag",
                active: true,
                index: 0,
              },
            ],
          };
        },
        async snapshot(options) {
          assert.equal(options.scope, "only_within_viewport");
          return {
            content: "button Save [ref=1]",
            refs: [{ backendNodeId: 1, role: "button", name: "Save" }],
          };
        },
      },
      async () => {
        const dump = await helperContext().page.debug({
          maxSnapshotChars: 8,
          eventLimit: 0,
        });

        assert.equal(dump.timestamp, "2026-08-13T00:00:00.000Z");
        assert.equal(
          dump.info.url,
          "https://example.com/path?token=REDACTED#REDACTED",
        );
        assert.equal(dump.info.title, "Debug target");
        assert.equal(dump.tabs[0].url, dump.info.url);
        assert.equal(dump.currentTab.targetId, "tab-1");
        assert.deepEqual(dump.snapshot, {
          scope: "only_within_viewport",
          chars: 19,
          excerpt: "button S\n...[truncated 11 chars]",
          refCount: 1,
        });
        assert.match(dump.screenshot.path, /ego-browser-shot-/);
        assert.equal(writes.length, 1);
        assert.equal(dump.events.drained, true);
        assert.equal(dump.events.count, 0);
        assert.equal(dump.trace.schema, "ego-browser.trace.v1");
        assert.equal(dump.trace.count, 0);
        assert.deepEqual(dump.errors, undefined);
      },
    );
  } finally {
    restore();
  }
});

test("page.debug completes passive verification in a user-controlled space", async () => {
  const writes = [];
  const restore = setOverrides({
    taskSpaceReadOnly: true,
    selectedTaskSpaceId: 7,
    writeFile: async (path, data) => {
      writes.push({ path, data });
    },
    cdpOverride: async (method) => {
      assert.equal(method, "Page.captureScreenshot");
      return { data: Buffer.from("png").toString("base64") };
    },
  });
  try {
    await withEgo(
      {
        async listTabs() {
          return {
            tabs: [
              {
                targetId: "tab-7",
                title: "User view",
                url: "https://example.com/user-view",
                active: true,
                index: 0,
              },
            ],
          };
        },
        async snapshot() {
          return { content: "heading User view", refs: [] };
        },
      },
      async () => {
        const dump = await helperContext().page.debug({
          includeEvents: false,
          includeTrace: false,
        });

        assert.deepEqual(dump.session, {
          hasSession: false,
          targetId: null,
          preferredTargetId: null,
          defaultTimeout: state.defaultTimeout,
          networkDomainEnabled: false,
          taskSpaceId: 7,
          readOnly: true,
        });
        assert.equal(dump.info, undefined);
        assert.equal(dump.currentTab.targetId, "tab-7");
        assert.equal(dump.snapshot.excerpt, "heading User view");
        assert.match(dump.screenshot.path, /ego-browser-shot-/);
        assert.equal(writes.length, 1);
        assert.equal(dump.errors, undefined);
      },
    );
  } finally {
    restore();
  }
});

test("page.trace returns a redacted chronological timeline", async () => {
  await helperExports.trace({ limit: 0 });
  const calls = [];
  const previousNow = state.now;
  let now = Date.parse("2026-08-13T00:00:00.000Z");
  state.now = () => now;
  try {
    await withEgo(
      {
        sendCDPMessage(payload) {
          calls.push(JSON.parse(payload));
        },
      },
      async () => {
        const pending = helperExports.cdp(
          "Page.navigate",
          { url: "https://example.com/path?token=secret" },
          "sess-1",
          5000,
        );
        now += 5;
        globalThis.ego.onCDPMessage(
          JSON.stringify({
            id: calls[0].id,
            result: { frameId: "frame-1" },
          }),
        );
        await pending;

        const timeline = await helperContext().page.trace({ limit: 5 });
        assert.equal(timeline.schema, "ego-browser.trace.v1");
        assert.equal(timeline.count, 2);
        assert.equal(timeline.shown, 2);
        assert.equal(timeline.items[0].kind, "cdp.request");
        assert.equal(
          timeline.items[0].summary,
          "navigate https://example.com/path?token=REDACTED",
        );
        assert.equal(timeline.items[1].durationMs, 5);
        assert.equal(
          timeline.items[1].summary,
          "Page.navigate completed in 5ms",
        );
      },
    );
  } finally {
    state.now = previousNow;
    await helperExports.trace({ limit: 0 });
  }
});

test("switchTaskSpace selects a matching task space", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "Checkout flow",
              ownership: "agent",
            },
          ],
        };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
    },
    async () => {
      assert.deepEqual(await switchTaskSpace(7), {
        taskId: "checkout-flow",
        id: 7,
        name: "Checkout flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [["useTaskSpace", 7]]);
});

test("switchTaskSpace rejects non-agent-owned task spaces", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      useTaskSpace() {},
    },
    async () => {
      await assert.rejects(
        () => switchTaskSpace("checkout-flow"),
        /switchTaskSpace requires an agent-owned task space/,
      );
    },
  );
});

test("switchTaskSpace awaits useTaskSpace binding errors", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace() {
        return { error: "Task space not selected" };
      },
    },
    async () => {
      await assert.rejects(
        () => switchTaskSpace("checkout-flow"),
        /switchTaskSpace: Task space not selected/,
      );
    },
  );
});

test("newTaskSpace creates and selects an agent task space", async () => {
  const calls = [];
  await withEgo(
    {
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return { taskId: name, id: 7, name, ownership: "agent" };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
    },
    async () => {
      assert.deepEqual(await newTaskSpace("checkout-flow"), {
        taskId: "checkout-flow",
        id: 7,
        name: "checkout-flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 7],
  ]);
});

test("newTaskSpace rejects results without a numeric id", async () => {
  const calls = [];
  await withEgo(
    {
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return { taskId: name, id: name, name };
      },
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
      },
    },
    async () => {
      await assert.rejects(
        () => newTaskSpace("checkout-flow"),
        /newTaskSpace requires a numeric task space id/,
      );
    },
  );
  assert.deepEqual(calls, [["createTaskSpace", "checkout-flow"]]);
});

test("newTaskSpace throws on binding error objects", async () => {
  await withEgo(
    {
      async createTaskSpace() {
        return { error: "Task space already exists: checkout-flow" };
      },
      useTaskSpace() {},
    },
    async () => {
      await assert.rejects(
        () => newTaskSpace("checkout-flow"),
        /newTaskSpace: Task space already exists: checkout-flow/,
      );
    },
  );
});

test("useOrCreateTaskSpace reuses existing agent-owned spaces", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return { taskId: name, id: 8, name, ownership: "agent" };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
    },
    async () => {
      assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
        taskId: "checkout-flow",
        id: 7,
        name: "checkout-flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("useOrCreateTaskSpace does not reuse another agent session's same-named space", async () => {
  const calls = [];
  const previous = process.env.CODEX_SESSION_ID;
  process.env.CODEX_SESSION_ID = "current-session-1234";
  try {
    await withEgo(
      {
        async listTaskSpaces() {
          calls.push(["listTaskSpaces"]);
          return {
            taskSpaces: [
              {
                taskId: 7,
                id: 7,
                name: "checkout-flow",
                ownership: "agent",
                session: "other-session-1234",
              },
            ],
          };
        },
        async createTaskSpace(name) {
          calls.push(["createTaskSpace", name]);
          return {
            taskId: 8,
            id: 8,
            name,
            ownership: "agent",
            session: "current-session-1234",
          };
        },
        async useTaskSpace(id) {
          calls.push(["useTaskSpace", id]);
          return { done: true };
        },
      },
      async () => {
        const result = await useOrCreateTaskSpace("checkout-flow");
        assert.equal(result.id, 8);
        assert.equal(result.session, "current-session-1234");
      },
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = previous;
  }
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 8],
  ]);
});

test("useOrCreateTaskSpace selects user-owned spaces read-only without claiming", async () => {
  const calls = [];
  const previousId = state.selectedTaskSpaceId;
  const previousReadOnly = state.taskSpaceReadOnly;
  try {
    await withEgo(
      {
        async listTaskSpaces() {
          calls.push(["listTaskSpaces"]);
          return {
            taskSpaces: [
              {
                taskId: "checkout-flow",
                id: 7,
                name: "checkout-flow",
                ownership: "user",
              },
            ],
          };
        },
        async claimTaskSpace(id, name) {
          calls.push(["claimTaskSpace", id, name]);
          return { taskId: name, id, name, ownership: "agent" };
        },
        useTaskSpace(taskId) {
          calls.push(["useTaskSpace", taskId]);
          return { done: true, readOnly: true };
        },
      },
      async () => {
        const result = await useOrCreateTaskSpace("checkout-flow");
        assert.equal(result.ownership, "user");
        assert.equal(state.selectedTaskSpaceId, 7);
        assert.equal(state.taskSpaceReadOnly, true);
      },
    );
  } finally {
    state.selectedTaskSpaceId = previousId;
    state.taskSpaceReadOnly = previousReadOnly;
  }
  assert.deepEqual(calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("bringToFrontTaskSpace checks user-owned spaces without selecting or claiming", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async presentTaskSpace(id) {
        calls.push(["presentTaskSpace", id]);
        return { done: true, visible: true };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
    },
    async () => {
      assert.deepEqual(await bringToFrontTaskSpace("checkout-flow"), {
        done: true,
        visible: true,
      });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"], ["presentTaskSpace", 7]]);
});

test("bringToFrontTaskSpace forwards explicit user-authorized focus", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async presentTaskSpace(id, options) {
        calls.push(["presentTaskSpace", id, options]);
        return { done: true, visible: true };
      },
    },
    async () => {
      await bringToFrontTaskSpace("checkout-flow", { focus: true });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["presentTaskSpace", 7, { focus: true }],
  ]);
});

test("claimTaskSpace claims and selects an existing user-owned space", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
    },
    async () => {
      assert.deepEqual(await claimTaskSpace("checkout-flow"), {
        taskId: "checkout-flow",
        id: 7,
        name: "checkout-flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
  ]);
});

test("takeOverTaskSpace claims a user-owned named space before taking over", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
      async takeOverTaskSpace() {
        calls.push(["takeOverTaskSpace"]);
        return { done: true };
      },
    },
    async () => {
      assert.equal(await takeOverTaskSpace("checkout-flow"), undefined);
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
    ["takeOverTaskSpace"],
  ]);
});

test("takeOverTaskSpace selects agent-owned spaces without claiming", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
      async takeOverTaskSpace() {
        calls.push(["takeOverTaskSpace"]);
        return { done: true };
      },
    },
    async () => {
      assert.equal(await takeOverTaskSpace("checkout-flow"), undefined);
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["takeOverTaskSpace"],
  ]);
});

test("takeOverTaskSpace treats agentDelegatedToUser as agent-owned", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agentDelegatedToUser",
            },
          ],
        };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
      async takeOverTaskSpace() {
        calls.push(["takeOverTaskSpace"]);
        return { done: true };
      },
    },
    async () => {
      assert.equal(await takeOverTaskSpace("checkout-flow"), undefined);
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["takeOverTaskSpace"],
  ]);
});

test("takeOverTaskSpace resolves digit strings by id and claims user-owned spaces", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "other",
              id: 7,
              name: "other",
              ownership: "user",
            },
          ],
        };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
      async takeOverTaskSpace() {
        calls.push(["takeOverTaskSpace"]);
        return { done: true };
      },
    },
    async () => {
      assert.equal(await takeOverTaskSpace("7"), undefined);
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "other"],
    ["useTaskSpace", 7],
    ["takeOverTaskSpace"],
  ]);
});

test("claimTaskSpace throws on an unknown task space", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
    },
    async () => {
      await assert.rejects(
        () => claimTaskSpace("checkout-flow"),
        /task space not found: checkout-flow/,
      );
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("useOrCreateTaskSpace creates missing spaces", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return { taskId: name, id: 7, name, ownership: "agent" };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
    },
    async () => {
      assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
        taskId: "checkout-flow",
        id: 7,
        name: "checkout-flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 7],
  ]);
});

test("useOrCreateTaskSpace restores pages from an idle-closed replacement space", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return {
          taskId: name,
          id: 7,
          name,
          ownership: "agent",
          previously: {
            urls: [
              "about:blank",
              "https://app.foxglove.dev/example",
              "chrome://version",
              "https://app.foxglove.dev/example",
            ],
          },
        };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
      },
      async listTabs() {
        calls.push(["listTabs"]);
        return {
          tabs: [
            {
              targetId: "anchor",
              title: "Ego Lite agent space",
              url: "about:blank",
              active: true,
            },
          ],
        };
      },
      async createTab(url) {
        calls.push(["createTab", url]);
        return { targetId: "anchor" };
      },
    },
    async () => {
      const task = await useOrCreateTaskSpace("agv foxglove live");
      assert.deepEqual(task.restoredUrls, ["https://app.foxglove.dev/example"]);
      assert.equal(task.previously.restored, true);
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "agv foxglove live"],
    ["useTaskSpace", 7],
    ["listTabs"],
    ["createTab", "https://app.foxglove.dev/example"],
  ]);
});

// An id cannot be created, so the miss is permanent for that argument. The
// message has to say so, or the caller just retries the same call.
test("useOrCreateTaskSpace explains that a missing id cannot be created", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout",
              id: 12,
              name: "checkout",
              ownership: "agent",
            },
            { taskId: "search", id: 98, name: "search", ownership: "agent" },
          ],
        };
      },
    },
    async () => {
      await assert.rejects(
        () => useOrCreateTaskSpace(97),
        (error) => {
          assert.match(error.message, /no task space with id 97/);
          assert.match(error.message, /pass a name to create one/);
          // The ids that do exist are the actionable part.
          assert.match(error.message, /12 \(checkout\)/);
          assert.match(error.message, /98 \(search\)/);
          return true;
        },
      );
    },
  );
});

test("useOrCreateTaskSpace resolves string names before numeric id strings", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "plain-seven",
              id: 7,
              name: "plain-seven",
              ownership: "agent",
            },
            { taskId: "7", id: 8, name: "7", ownership: "agent" },
          ],
        };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
    },
    async () => {
      assert.deepEqual(await useOrCreateTaskSpace("7"), {
        taskId: "7",
        id: 8,
        name: "7",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"], ["useTaskSpace", 8]]);
});

test("useOrCreateTaskSpace resolves numeric strings by id when name is absent", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
    },
    async () => {
      assert.deepEqual(await useOrCreateTaskSpace("7"), {
        taskId: "checkout-flow",
        id: 7,
        name: "checkout-flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("useOrCreateTaskSpace rejects missing numeric ids instead of creating", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return {
          taskId: String(name),
          id: 7,
          name: String(name),
          ownership: "agent",
        };
      },
    },
    async () => {
      await assert.rejects(
        () => useOrCreateTaskSpace(7),
        (error) => {
          assert.match(error.message, /no task space with id 7/);
          assert.match(error.message, /No task spaces exist yet/);
          return true;
        },
      );
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("completeTaskSpace selects by numeric id before completing", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
      async completeTaskSpace() {
        calls.push(["completeTaskSpace"]);
        return "7 task space completed.";
      },
    },
    async () => {
      const result = await completeTaskSpace("checkout-flow", { keep: true });
      // A binding that says nothing about visibility is one that has a window.
      assert.deepEqual(result, { done: true, visible: true });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["completeTaskSpace"],
  ]);
});

test("completeTaskSpace waits for async useTaskSpace before completing", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace:start", id]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        calls.push(["useTaskSpace:end", id]);
      },
      async completeTaskSpace() {
        calls.push(["completeTaskSpace"]);
        return "7 task space completed.";
      },
    },
    async () => {
      await completeTaskSpace("checkout-flow", { keep: true });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace:start", 7],
    ["useTaskSpace:end", 7],
    ["completeTaskSpace"],
  ]);
});

test("completeTaskSpace keep true reports a kept page the user cannot see", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace() {},
      async completeTaskSpace() {
        return { done: true, visible: false, reason: "headless" };
      },
    },
    async () => {
      const result = await completeTaskSpace("checkout-flow", { keep: true });
      assert.deepEqual(result, {
        done: true,
        visible: false,
        reason: "headless",
      });
    },
  );
});

test("completeTaskSpace claims user-owned spaces before closing", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
      async closeTaskSpace() {
        calls.push(["closeTaskSpace"]);
        return "7 task space closed.";
      },
    },
    async () => {
      const result = await completeTaskSpace("checkout-flow", { keep: false });
      assert.deepEqual(result, { done: true });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
    ["closeTaskSpace"],
  ]);
});

test("completeTaskSpace keep true skips user-owned spaces and reports it", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async completeTaskSpace() {
        calls.push(["completeTaskSpace"]);
      },
    },
    async () => {
      const result = await completeTaskSpace("checkout-flow", { keep: true });
      assert.deepEqual(result, { done: false, skipped: "user-owned" });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("completeTaskSpace keep true reports a page the user cannot see", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        return id;
      },
      // Keeping a space headless leaves a page open on no screen at all.
      async completeTaskSpace() {
        return { done: true, visible: false };
      },
    },
    async () => {
      const result = await completeTaskSpace("checkout-flow", { keep: true });
      assert.deepEqual(result, { done: true, visible: false });
    },
  );
});

test("handOffTaskSpace skips user-owned spaces and reports it", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async handOffTaskSpace() {
        calls.push(["handOffTaskSpace"]);
      },
    },
    async () => {
      const result = await handOffTaskSpace("checkout-flow");
      assert.deepEqual(result, { done: false, skipped: "user-owned" });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("handOffTaskSpace reports done for agent-owned spaces", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
      async handOffTaskSpace() {
        calls.push(["handOffTaskSpace"]);
      },
    },
    async () => {
      const result = await handOffTaskSpace("checkout-flow");
      // A binding that says nothing about visibility is one that has a window.
      assert.deepEqual(result, { done: true, visible: true });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["handOffTaskSpace"],
  ]);
});

test("handOffTaskSpace reports a handoff the user cannot see", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        return id;
      },
      // What the Linux port answers when the browser is running headless: the
      // handoff happened, but there is no window for the user to act in.
      async handOffTaskSpace() {
        return { done: true, visible: false, reason: "headless" };
      },
    },
    async () => {
      const result = await handOffTaskSpace("checkout-flow");
      assert.deepEqual(result, {
        done: true,
        visible: false,
        reason: "headless",
      });
    },
  );
});

test("requestUserActionTaskSpace keeps a bare legacy handoff focus-protected", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
      async handOffTaskSpace() {
        calls.push(["handOffTaskSpace"]);
        return { done: true, visible: true };
      },
      async presentTaskSpace(id) {
        calls.push(["presentTaskSpace", id]);
        return { done: true, visible: true };
      },
    },
    async () => {
      assert.deepEqual(await requestUserActionTaskSpace("checkout-flow"), {
        done: true,
        visible: true,
        presentation: "hand-off",
      });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["handOffTaskSpace"],
    ["presentTaskSpace", 7],
  ]);
});

test("requestUserActionTaskSpace checks a bare user-owned space without focusing or claiming it", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return { done: true, readOnly: true };
      },
      async presentTaskSpace(id) {
        calls.push(["presentTaskSpace", id]);
        return { done: true, visible: true };
      },
    },
    async () => {
      assert.deepEqual(await requestUserActionTaskSpace("checkout-flow"), {
        done: true,
        visible: true,
        presentation: "bring-to-front",
      });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["presentTaskSpace", 7],
  ]);
});

test("requestUserActionTaskSpace focuses once, waits for Done, and resumes the agent", async () => {
  const calls = [];
  let ownership = "agent";
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership,
            },
          ],
        };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return { done: true };
      },
      async handOffTaskSpace() {
        calls.push(["handOffTaskSpace"]);
        ownership = "agentDelegatedToUser";
        return { done: true, visible: true };
      },
      async showUserAction(action) {
        calls.push(["showUserAction", action]);
        return { done: true, alreadyVisible: false, targetFound: true };
      },
      async presentTaskSpace(id, options) {
        calls.push(["presentTaskSpace", id, options]);
        return { done: true, visible: true };
      },
      async waitForUserAction(options) {
        calls.push(["waitForUserAction", options]);
        return { done: true, result: "done" };
      },
      async clearUserAction(key) {
        calls.push(["clearUserAction", key]);
        return { done: true };
      },
      async takeOverTaskSpace() {
        calls.push(["takeOverTaskSpace"]);
        ownership = "agent";
        return { done: true };
      },
    },
    async () => {
      const result = await requestUserActionTaskSpace("checkout-flow", {
        instruction: "Approve the login, then press Kész.",
        target: { selector: "button.approve" },
        actionKey: "approve-login",
        doneLabel: "Kész",
        cancelLabel: "Mégsem",
        timeout: 5,
      });
      assert.deepEqual(result, {
        done: true,
        visible: true,
        presentation: "hand-off",
        actionKey: "approve-login",
        focused: true,
        userResult: "done",
        resumed: true,
      });
    },
  );
  assert.ok(
    calls.some(
      (call) => call[0] === "presentTaskSpace" && call[2]?.focus === true,
    ),
  );
  assert.ok(calls.some((call) => call[0] === "waitForUserAction"));
  assert.ok(calls.some((call) => call[0] === "takeOverTaskSpace"));
});

test("requestUserActionTaskSpace does not refocus an already-visible blocker", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async useTaskSpace() {
        return { done: true, readOnly: true };
      },
      async showUserAction() {
        return { done: true, alreadyVisible: true, targetFound: true };
      },
      async presentTaskSpace(id, options) {
        calls.push(["presentTaskSpace", id, options]);
        return { done: true, visible: true };
      },
    },
    async () => {
      await requestUserActionTaskSpace("checkout-flow", {
        instruction: "Approve the login.",
        actionKey: "approve-login",
        wait: false,
      });
    },
  );
  assert.deepEqual(calls, [["presentTaskSpace", 7, undefined]]);
});

test("requestUserActionTaskSpace keeps user control after Cancel", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async useTaskSpace() {
        return { done: true, readOnly: true };
      },
      async showUserAction() {
        return { done: true, alreadyVisible: false, targetFound: false };
      },
      async presentTaskSpace() {
        return { done: true, visible: true };
      },
      async waitForUserAction() {
        return { done: true, result: "cancel" };
      },
      async clearUserAction(key) {
        calls.push(["clearUserAction", key]);
        return { done: true };
      },
      async takeOverTaskSpace() {
        calls.push(["takeOverTaskSpace"]);
        return { done: true };
      },
    },
    async () => {
      const result = await requestUserActionTaskSpace("checkout-flow", {
        instruction: "Confirm the purchase.",
        actionKey: "confirm-purchase",
      });
      assert.equal(result.userResult, "cancel");
      assert.equal(result.resumed, false);
    },
  );
  assert.deepEqual(calls, [["clearUserAction", "confirm-purchase"]]);
});

test("requestUserActionTaskSpace rejects a page that is not visible", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        return id;
      },
      async handOffTaskSpace() {
        return { done: true, visible: false, reason: "headless" };
      },
      async presentTaskSpace() {
        return { done: true, visible: false, reason: "headless" };
      },
    },
    async () => {
      await assert.rejects(
        requestUserActionTaskSpace("checkout-flow"),
        /page is not visible \(headless\); do not ask the user to act/,
      );
    },
  );
});

test("requestUserActionTaskSpace notifies when focused presentation fails", async () => {
  const notifications = [];
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async useTaskSpace() {
        return { done: true, readOnly: true };
      },
      async showUserAction() {
        return { done: true, alreadyVisible: false, targetFound: false };
      },
      async presentTaskSpace() {
        return { done: true, visible: false, reason: "raise-failed" };
      },
      async notifyUserAction(payload) {
        notifications.push(payload);
        return { done: true };
      },
    },
    async () => {
      await assert.rejects(
        requestUserActionTaskSpace("checkout-flow", {
          instruction: "Approve the login.",
          wait: false,
        }),
        /page is not visible \(raise-failed\)/,
      );
    },
  );
  assert.deepEqual(notifications, [
    { instruction: "Approve the login.", reason: "raise-failed" },
  ]);
});

test("loginPreflightTaskSpace waits for autofill and submits without exposing values", async () => {
  const evaluations = [
    { detected: true, ready: false, fieldCount: 2, filledCount: 1 },
    { detected: true, ready: true, fieldCount: 2, filledCount: 2 },
    true,
  ];
  const restore = setOverrides({
    cdpOverride: async (method) => {
      assert.equal(method, "Runtime.evaluate");
      return { result: { value: evaluations.shift() } };
    },
  });
  try {
    await withEgo(
      {
        async listTaskSpaces() {
          return {
            taskSpaces: [
              {
                taskId: "login",
                id: 9,
                name: "login",
                ownership: "agent",
              },
            ],
          };
        },
        async useTaskSpace() {
          return { done: true };
        },
      },
      async () => {
        assert.deepEqual(
          await loginPreflightTaskSpace("login", {
            waitForAutofill: 0.05,
            interval: 0.001,
          }),
          {
            detected: true,
            ready: true,
            needsUser: false,
            fieldCount: 2,
            filledCount: 2,
            submitted: true,
          },
        );
      },
    );
  } finally {
    restore();
  }
});

test("handleChallengeTaskSpace hands a persistent Cloudflare challenge to the user once", async () => {
  const calls = [];
  let ownership = "agent";
  const restore = setOverrides({
    cdpOverride: async (method) => {
      assert.equal(method, "Runtime.evaluate");
      return {
        result: {
          value: {
            detected: true,
            provider: "cloudflare",
            kind: "turnstile",
            origin: "https://www.npmjs.com",
            target: ".cf-turnstile",
          },
        },
      };
    },
  });
  try {
    await withEgo(
      {
        async listTaskSpaces() {
          return {
            taskSpaces: [
              {
                taskId: "npm",
                id: 12,
                name: "npm",
                ownership,
              },
            ],
          };
        },
        async useTaskSpace(id) {
          calls.push(["useTaskSpace", id]);
          return { done: true };
        },
        async handOffTaskSpace() {
          calls.push(["handOffTaskSpace"]);
          ownership = "agentDelegatedToUser";
          return { done: true, visible: true };
        },
        async showUserAction(action) {
          calls.push(["showUserAction", action]);
          return { done: true, alreadyVisible: false, targetFound: true };
        },
        async presentTaskSpace(id, options) {
          calls.push(["presentTaskSpace", id, options]);
          return { done: true, visible: true };
        },
        async waitForUserAction() {
          calls.push(["waitForUserAction"]);
          return { done: true, result: "done" };
        },
        async clearUserAction(key) {
          calls.push(["clearUserAction", key]);
          return { done: true };
        },
        async takeOverTaskSpace() {
          calls.push(["takeOverTaskSpace"]);
          ownership = "agent";
          return { done: true };
        },
      },
      async () => {
        assert.deepEqual(
          await handleChallengeTaskSpace("npm", {
            waitForAutomatic: 0,
            instruction:
              "Erősítsd meg, hogy nem vagy robot, majd kattints a Kész gombra.",
            doneLabel: "Kész",
            cancelLabel: "Mégsem",
          }),
          {
            detected: true,
            provider: "cloudflare",
            kind: "turnstile",
            handled: true,
            done: true,
            visible: true,
            presentation: "hand-off",
            actionKey:
              "human-challenge:cloudflare:turnstile:https://www.npmjs.com",
            focused: true,
            userResult: "done",
            resumed: true,
          },
        );
      },
    );
  } finally {
    restore();
  }

  const panel = calls.find((call) => call[0] === "showUserAction");
  assert.equal(panel[1].target, ".cf-turnstile");
  assert.equal(panel[1].doneLabel, "Kész");
  assert.equal(
    calls.filter((call) => call[0] === "presentTaskSpace").length,
    1,
  );
});

test("handleChallengeTaskSpace stays background-only when no challenge is present", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride: async () => ({ result: { value: { detected: false } } }),
  });
  try {
    await withEgo(
      {
        async listTaskSpaces() {
          return {
            taskSpaces: [
              { taskId: "plain", id: 13, name: "plain", ownership: "agent" },
            ],
          };
        },
        async useTaskSpace(id) {
          calls.push(["useTaskSpace", id]);
          return { done: true };
        },
        async presentTaskSpace() {
          calls.push(["presentTaskSpace"]);
          return { done: true, visible: true };
        },
      },
      async () => {
        assert.deepEqual(await handleChallengeTaskSpace("plain"), {
          detected: false,
          handled: false,
        });
      },
    );
  } finally {
    restore();
  }
  assert.deepEqual(calls, [["useTaskSpace", 13]]);
});

test("handleChallengeTaskSpace does not focus a challenge that resolves automatically", async () => {
  const evaluations = [
    {
      detected: true,
      provider: "cloudflare",
      kind: "turnstile",
      origin: "https://example.test",
      target: ".cf-turnstile",
    },
    { detected: false },
  ];
  const restore = setOverrides({
    cdpOverride: async () => ({ result: { value: evaluations.shift() } }),
  });
  try {
    await withEgo(
      {
        async listTaskSpaces() {
          return {
            taskSpaces: [
              { taskId: "auto", id: 14, name: "auto", ownership: "agent" },
            ],
          };
        },
        async useTaskSpace() {
          return { done: true };
        },
      },
      async () => {
        assert.deepEqual(
          await handleChallengeTaskSpace("auto", {
            waitForAutomatic: 0.05,
            interval: 0.001,
          }),
          {
            detected: true,
            provider: "cloudflare",
            kind: "turnstile",
            handled: false,
            resolvedAutomatically: true,
          },
        );
      },
    );
  } finally {
    restore();
  }
});

test("challenge inspection ignores a Turnstile widget that already has a token", () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousStyle = globalThis.getComputedStyle;
  const visibleWidget = {
    getBoundingClientRect: () => ({ width: 300, height: 65 }),
  };
  globalThis.document = {
    title: "Sign in",
    querySelector(selector) {
      if (selector === 'input[name="cf-turnstile-response"]') {
        return { value: "completed-token" };
      }
      if (selector === ".cf-turnstile") return visibleWidget;
      return null;
    },
  };
  globalThis.location = { origin: "https://accounts.example.test" };
  globalThis.getComputedStyle = () => ({
    display: "block",
    visibility: "visible",
  });
  try {
    assert.deepEqual(helperExports.__testing.inspectHumanChallenge(), {
      detected: false,
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousStyle;
  }
});

test("challenge inspection ignores solved hCaptcha and reCAPTCHA widgets", () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousStyle = globalThis.getComputedStyle;
  const visibleWidget = {
    getBoundingClientRect: () => ({ width: 300, height: 65 }),
  };
  globalThis.location = { origin: "https://accounts.example.test" };
  globalThis.getComputedStyle = () => ({
    display: "block",
    visibility: "visible",
  });
  try {
    for (const testCase of [
      {
        response: "h-captcha-response",
        widget: ".h-captcha",
      },
      {
        response: "g-recaptcha-response",
        widget: ".g-recaptcha",
      },
    ]) {
      globalThis.document = {
        title: "Sign in",
        querySelectorAll(selector) {
          return selector.includes(testCase.response)
            ? [{ value: "completed-token" }]
            : [];
        },
        querySelector(selector) {
          return selector === testCase.widget ||
            selector === "[data-sitekey][data-callback]"
            ? visibleWidget
            : null;
        },
      };
      assert.deepEqual(helperExports.__testing.inspectHumanChallenge(), {
        detected: false,
      });
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousStyle;
  }
});

test("useOrCreateTaskSpace rejects unknown ownership", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "shared",
            },
          ],
        };
      },
    },
    async () => {
      await assert.rejects(
        () => useOrCreateTaskSpace("checkout-flow"),
        /ownership "shared"/,
      );
    },
  );
});

// The probe in waitForAgentControl keys on ego.snapshot()'s rejection carrying
// error_code === EGO_TASK_SPACE_USER_IN_CONTROL (the documented contract), not on
// message wording. These tests pin that contract so a runtime that stops setting
// the code surfaces as a failing test rather than a silent regression.
function taskSpaceEgo(snapshot) {
  return {
    async listTaskSpaces() {
      return {
        taskSpaces: [{ taskId: "t", id: 1, name: "t", ownership: "agent" }],
      };
    },
    async useTaskSpace() {
      return 1;
    },
    snapshot,
  };
}

test("waitForAgentControl retries while snapshot reports user control", async () => {
  const restore = helperExports.__testing.setOverrides({
    sleep: () => Promise.resolve(),
  });
  let calls = 0;
  try {
    await withEgo(
      taskSpaceEgo(async () => {
        calls += 1;
        if (calls < 3) {
          throw Object.assign(new Error("anything at all"), {
            error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
          });
        }
        return { content: "" };
      }),
      async () => {
        await waitForAgentControl("t", { interval: 0.001, timeout: 5 });
      },
    );
  } finally {
    restore();
  }
  assert.equal(calls, 3);
});

test("waitForAgentControl waits for user-owned spaces without claiming them", async () => {
  const restore = helperExports.__testing.setOverrides({
    sleep: () => Promise.resolve(),
  });
  const calls = [];
  let listCalls = 0;
  try {
    await withEgo(
      {
        async listTaskSpaces() {
          listCalls += 1;
          calls.push(["listTaskSpaces", listCalls]);
          return {
            taskSpaces: [
              {
                taskId: "checkout-flow",
                id: 7,
                name: "checkout-flow",
                ownership: listCalls < 3 ? "user" : "agent",
              },
            ],
          };
        },
        async claimTaskSpace(id, name) {
          calls.push(["claimTaskSpace", id, name]);
          return { taskId: name, id, name, ownership: "agent" };
        },
        async useTaskSpace(id) {
          calls.push(["useTaskSpace", id]);
          return id;
        },
        async snapshot() {
          calls.push(["snapshot"]);
          return { content: "" };
        },
      },
      async () => {
        await waitForAgentControl("checkout-flow", {
          interval: 0.001,
          timeout: 5,
        });
      },
    );
  } finally {
    restore();
  }
  assert.deepEqual(calls, [
    ["listTaskSpaces", 1],
    ["listTaskSpaces", 2],
    ["listTaskSpaces", 3],
    ["useTaskSpace", 7],
    ["snapshot"],
  ]);
});

test("waitForAgentControl propagates non-user-control snapshot errors", async () => {
  await withEgo(
    taskSpaceEgo(async () => {
      throw Object.assign(new Error("snapshot failed"), {
        error_code: "EGO_SNAPSHOT_FAILED",
      });
    }),
    async () => {
      await assert.rejects(
        () => waitForAgentControl("t", { interval: 0.001, timeout: 5 }),
        /snapshot failed/,
      );
    },
  );
});

test("waitForAgentControl rejects invalid polling options", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [{ taskId: "t", id: 1, name: "t", ownership: "user" }],
        };
      },
    },
    async () => {
      await assert.rejects(
        () => waitForAgentControl("t", { interval: 0, timeout: 5 }),
        /interval must be a positive number/,
      );
      await assert.rejects(
        () =>
          waitForAgentControl("t", {
            interval: 1,
            timeout: Number.NaN,
          }),
        /timeout must be a non-negative number/,
      );
    },
  );
});
