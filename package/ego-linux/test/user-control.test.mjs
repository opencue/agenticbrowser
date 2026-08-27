import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own state dir: this suite flips ownership states that must never affect a
// real session or another test's backing browser.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-user-control-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");
const { createSnapshotApi } = await import("../src/snapshot.mjs");
const { connectCdp } = await import("../src/transport.mjs");

const USER_CONTROL = {
  error: "The task is under user control",
  error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
};

function fakeCdp() {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              type: "page",
              targetId: "t-a",
              url: "https://a.example",
              browserContextId: "ctx-a",
            },
          ],
        };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: "session-a" };
      }
      if (method === "DOMSnapshot.captureSnapshot") {
        return { strings: [], documents: [] };
      }
      return {};
    },
  };
}

function space(ownership) {
  const at = Date.now();
  return {
    id: 1,
    taskId: 1,
    name: "handoff",
    createdAt: at,
    touchedAt: at,
    lastContentAt: at,
    ownership,
    browserContextId: "ctx-a",
    targetIds: ["t-a"],
  };
}

async function seed(ownership) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({
      spaces: [space(ownership)],
      selectedId: 1,
      nextId: 2,
    }),
  );
}

function tabsApi(cdp) {
  return {
    async createTab(url, browserContextId) {
      return cdp.call("Target.createTarget", { url, browserContextId });
    },
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor() {
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatch("open", {});
    });
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({ listener, once: options.once === true });
    this.listeners.set(type, entries);
  }

  dispatch(type, event) {
    const entries = [...(this.listeners.get(type) || [])];
    for (const entry of entries) {
      entry.listener(event);
      if (entry.once) {
        const current = this.listeners.get(type) || [];
        this.listeners.set(
          type,
          current.filter((candidate) => candidate !== entry),
        );
      }
    }
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", {});
  }
}

describe("Linux user-control boundary", () => {
  it("agent useTaskSpace selects a user-owned space for read-only observation", async () => {
    await seed("user");
    const result = await createTaskSpacesApi(fakeCdp()).useTaskSpace(1);
    assert.deepEqual(result, { done: true, readOnly: true });
  });

  it("the Spaces panel can still switch to user-owned spaces", async () => {
    await seed("user");
    const previous = process.env.EGO_LINUX_PANEL;
    process.env.EGO_LINUX_PANEL = "1";
    try {
      const result = await createTaskSpacesApi(fakeCdp()).useTaskSpace(1);
      assert.deepEqual(result, { done: true });
    } finally {
      if (previous === undefined) delete process.env.EGO_LINUX_PANEL;
      else process.env.EGO_LINUX_PANEL = previous;
    }
  });

  it("snapshot remains available while a handed-off space is under user control", async () => {
    await seed("agentDelegatedToUser");
    const cdp = fakeCdp();
    const taskSpaces = createTaskSpacesApi(cdp);
    const snapshot = createSnapshotApi(cdp, {
      listTabs: async () => ({
        tabs: [{ targetId: "t-a", active: true }],
      }),
      // Kept as a regression sentinel: snapshot must not invoke the ownership
      // assertion now that passive observation is explicitly supported.
      assertAgentControl: taskSpaces.assertAgentControl,
    });

    const result = await snapshot.snapshot();
    assert.deepEqual(result, { content: "", refs: [] });
    assert.ok(
      cdp.calls.some((call) => call.method === "DOMSnapshot.captureSnapshot"),
    );
  });

  it("new tabs are not opened in a handed-off space", async () => {
    await seed("agentDelegatedToUser");
    const cdp = fakeCdp();
    const result = await createTaskSpacesApi(cdp).createTabInSelectedSpace(
      tabsApi(cdp),
      "https://example.com",
    );

    assert.deepEqual(result, USER_CONTROL);
    assert.ok(
      !cdp.calls.some((call) => call.method === "Target.createTarget"),
      "the page stays in the user's hands",
    );
  });

  it("only passive screenshot and attach plumbing remain available under user control", async () => {
    const original = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket;
    try {
      const cdp = await connectCdp("ws://127.0.0.1/devtools/browser/fake");
      const socket = FakeWebSocket.instances[0];
      const errors = [];
      cdp.bind({
        onSendCDPMessageError(message, error_code) {
          errors.push([message, error_code]);
        },
      });
      cdp.setPageControlGuard(() => USER_CONTROL);

      cdp.sendRaw(JSON.stringify({ id: 1, method: "Runtime.evaluate" }));
      assert.deepEqual(errors, [
        ["The task is under user control", "EGO_TASK_SPACE_USER_IN_CONTROL"],
      ]);
      assert.deepEqual(socket.sent, [], "blocked page command was not sent");

      cdp.sendRaw(JSON.stringify({ id: 2, method: "Page.navigate" }));
      assert.equal(errors.length, 2);
      assert.deepEqual(socket.sent, [], "navigation was not sent");

      cdp.sendRaw(JSON.stringify({ id: 3, method: "Page.captureScreenshot" }));
      cdp.sendRaw(JSON.stringify({ id: 4, method: "Browser.getVersion" }));
      cdp.sendRaw(
        JSON.stringify({
          id: 5,
          method: "Target.attachToTarget",
          params: { targetId: "t-a", flatten: true },
        }),
      );
      cdp.sendRaw(
        JSON.stringify({
          id: 6,
          method: "Target.closeTarget",
          params: { targetId: "t-a" },
        }),
      );
      cdp.sendRaw(JSON.stringify({ id: 7, method: "Browser.close" }));
      cdp.sendRaw(
        JSON.stringify({
          id: 8,
          method: "Target.createTarget",
          params: { url: "https://example.com" },
        }),
      );
      assert.equal(errors.length, 5, "all mutating commands are blocked");
      assert.deepEqual(
        socket.sent.map((payload) => JSON.parse(payload).method),
        [
          "Page.captureScreenshot",
          "Browser.getVersion",
          "Target.attachToTarget",
        ],
      );
    } finally {
      globalThis.WebSocket = original;
    }
  });
});
