import test from "node:test";
import assert from "node:assert/strict";

import * as helperExports from "../dist/src/helpers.js";
import { setOverrides, state } from "../dist/src/state.js";
import {
  claimTaskSpace,
  completeTaskSpace,
  handOffTaskSpace,
  newTaskSpace,
  helperContext,
  isEgoHardStopError,
  listTaskSpaces,
  runTaskSpace,
  useOrCreateTaskSpace,
  switchTaskSpace,
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
  assert.equal(typeof context.taskSpaces.claim, "function");
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

test("useOrCreateTaskSpace selects user-owned spaces without claiming and surfaces the owned user-control guidance", async () => {
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
        // Native attaches the stable code; resolveEgoError overrides the live
        // text with ego-browser's owned EGO_TASK_SPACE_USER_IN_CONTROL guidance.
        return {
          error: "The task is under user control",
          error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
        };
      },
    },
    async () => {
      await assert.rejects(
        () => useOrCreateTaskSpace("checkout-flow"),
        /useOrCreateTaskSpace: The user has taken control of this task space/,
      );
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
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
        await waitForAgentControl("t", { interval: 0, timeout: 5 });
      },
    );
  } finally {
    restore();
  }
  assert.equal(calls, 3);
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
        () => waitForAgentControl("t", { interval: 0, timeout: 5 }),
        /snapshot failed/,
      );
    },
  );
});
