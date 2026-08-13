import test from "node:test";
import assert from "node:assert/strict";

import { installEgoSdk } from "../dist/src/index.js";
import { observeTaskSpace, takeOverTaskSpace } from "../dist/src/helpers.js";
import { state } from "../dist/src/state.js";

function withEgo(ego, fn) {
  const previous = globalThis.ego;
  globalThis.ego = ego;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.ego = previous;
      state.observing = false;
    });
}

/** One space, owned and driven by somebody else. */
function driverEgo(extra = {}) {
  return {
    async listTaskSpaces() {
      return {
        taskSpaces: [
          {
            taskId: "checkout-flow",
            id: 7,
            name: "Checkout flow",
            createdBy: "agent",
            ownership: "agent",
          },
        ],
      };
    },
    ...extra,
  };
}

/** Install the SDK on a bare target with logging silenced. */
function sdk() {
  const target = {};
  const originalLog = console.log;
  installEgoSdk(target, { cliLog() {} });
  console.log = originalLog;
  return target;
}

test("observeTaskSpace marks the session as watching", async () => {
  const seen = [];
  await withEgo(
    driverEgo({
      async observeTaskSpace(id) {
        seen.push(id);
        return { done: true, observing: true };
      },
    }),
    async () => {
      assert.equal(state.observing, false, "not watching to begin with");
      const space = await observeTaskSpace("Checkout flow");
      assert.equal(space.id, 7);
      assert.deepEqual(seen, [7], "resolved the name to the numeric id");
      assert.equal(state.observing, true);
    },
  );
});

test("observeTaskSpace never selects the space it is watching", async () => {
  // Selecting means "I am driving this" on the backing layer: it would raise the
  // driver's window and clear the flag observeTaskSpace just set.
  await withEgo(
    driverEgo({
      async observeTaskSpace() {
        return { done: true, observing: true };
      },
      async useTaskSpace() {
        throw new Error("observeTaskSpace must not call useTaskSpace");
      },
    }),
    async () => {
      await observeTaskSpace(7);
      assert.equal(state.observing, true);
    },
  );
});

test("observeTaskSpace watches a user-owned space too", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            { taskId: "t", id: 3, name: "user page", ownership: "user" },
          ],
        };
      },
      async observeTaskSpace() {
        return { done: true, observing: true };
      },
    },
    async () => {
      await observeTaskSpace(3);
      assert.equal(state.observing, true, "ownership is not an observer's business");
    },
  );
});

test("observeTaskSpace says what is missing when the runtime cannot observe", async () => {
  await withEgo(driverEgo(), async () => {
    await assert.rejects(
      () => observeTaskSpace(7),
      /observeTaskSpace requires ego\.observeTaskSpace/,
    );
    assert.equal(state.observing, false, "a failed attach is not observing");
  });
});

test("the calls the backing layer cannot judge are refused here", async () => {
  // Input, navigation and tab churn are refused in the backing layer's transport,
  // which covers every route to CDP from both the CLI and SDK entry points — see
  // ego-linux/test/observe-e2e.test.mjs, which proves it across two processes.
  // What that layer cannot judge is arbitrary JS: it sees Runtime.evaluate, the
  // same method the snapshot it must allow is made of. So these are guarded at
  // the public facade bindings instead, which both entry points share.
  const target = sdk();
  state.observing = true;
  try {
    const refused = {
      "page.evaluate": () => target.page.evaluate("1 + 1"),
      "locator.evaluateAll": () =>
        target.page.locator("#row").evaluateAll((rows) => rows.length),
      "site.runTool": () => target.site.runTool("tool", {}),
      "site.runBrowserTool": () => target.site.runBrowserTool("tool", {}),
      "taskSpaces.complete": () => target.taskSpaces.complete(7, { keep: true }),
      "taskSpaces.handOff": () => target.taskSpaces.handOff(7),
    };
    for (const [name, call] of Object.entries(refused)) {
      await assert.rejects(call, /observing a task space/, `${name} must refuse`);
    }
  } finally {
    state.observing = false;
  }
});

test("the refusal names the call and the way out", async () => {
  const target = sdk();
  state.observing = true;
  try {
    await assert.rejects(
      () => target.page.evaluate("document.title"),
      (error) => {
        assert.match(error.message, /page\.evaluate/, "names what was refused");
        assert.match(error.message, /takeOverTaskSpace/, "names the way out");
        assert.match(error.message, /snapshot, screenshot/, "names what still works");
        return true;
      },
    );
  } finally {
    state.observing = false;
  }
});

test("evaluate is refused even though it is often used to read", async () => {
  // Arbitrary JS is a write vector: querySelector(...).click() is a click. The
  // backing layer cannot tell the difference, so this is the layer that decides.
  const target = sdk();
  state.observing = true;
  try {
    await assert.rejects(
      target.page.evaluate("document.title"),
      /observing a task space/,
    );
  } finally {
    state.observing = false;
  }
});

test("reads are not refused while observing", async () => {
  const target = sdk();
  state.observing = true;
  try {
    // No browser here, so these fail for their own reasons — the assertion is
    // only that the observer guard is not what stopped them.
    for (const call of [
      () => target.page.snapshot(),
      () => target.page.screenshot(),
      () => target.page.locator("#total").textContent(),
      () => target.page.locator("#row").count(),
      () => target.page.info(),
      () => target.page.waitForLoadState("load"),
      () => target.browser.listTabs(),
      () => target.taskSpaces.list(),
    ]) {
      await call().then(
        () => {},
        (error) => {
          assert.doesNotMatch(
            String(error?.message ?? error),
            /observing a task space/,
            "a read must not be blocked by the observer guard",
          );
        },
      );
    }
  } finally {
    state.observing = false;
  }
});

test("takeOverTaskSpace stops observing", async () => {
  await withEgo(
    driverEgo({
      async observeTaskSpace() {
        return { done: true, observing: true };
      },
      async takeOverTaskSpace() {
        return { done: true };
      },
    }),
    async () => {
      await observeTaskSpace(7);
      assert.equal(state.observing, true);

      await takeOverTaskSpace();

      assert.equal(state.observing, false, "input is allowed again");
    },
  );
});

test("a failed take-over leaves the session observing", async () => {
  // Half-driving is the worst outcome: the guard would be down while the backing
  // layer still had someone else as owner.
  await withEgo(
    driverEgo({
      async observeTaskSpace() {
        return { done: true, observing: true };
      },
      async takeOverTaskSpace() {
        throw new Error("space is gone");
      },
    }),
    async () => {
      await observeTaskSpace(7);
      await assert.rejects(() => takeOverTaskSpace(), /space is gone/);
      assert.equal(state.observing, true, "still watching");
    },
  );
});
