import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  browserCdp,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import { drainEvents, screenshot } from "../../dist/src/driver/observe.js";
import { setOverrides } from "../../dist/src/state.js";

function withCdpRuntime(fn) {
  const previous = globalThis.ego;
  const sent = [];
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          {
            targetId: "target-1",
            active: true,
            title: "Example",
            url: "https://example.com/",
          },
        ],
      };
    },
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      sent.push(request);
      let result = {};
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      } else if (request.method === "Page.captureScreenshot") {
        result = { data: Buffer.from("png").toString("base64") };
      } else if (request.method === "Runtime.evaluate") {
        result = { result: { value: "1" } };
      }
      queueMicrotask(() =>
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result })),
      );
    },
    emit(method, params) {
      runtime.onCDPMessage(
        JSON.stringify({ sessionId: "session-1", method, params }),
      );
    },
  };
  globalThis.ego = runtime;
  invalidateSession();
  return Promise.resolve()
    .then(() => fn({ runtime, sent }))
    .finally(() => {
      invalidateSession();
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("screenshot skips page metric JavaScript while a native dialog is pending", async () => {
  const writes = [];
  const restore = setOverrides({
    async writeFile(path, data) {
      writes.push({ path, data });
    },
  });
  try {
    await withCdpRuntime(async ({ runtime, sent }) => {
      await browserCdp("Runtime.evaluate", { expression: "document.title" });
      runtime.emit("Page.javascriptDialogOpening", {
        type: "alert",
        message: "Blocked",
        url: "https://example.com/",
      });
      sent.length = 0;

      await screenshot({ path: "/tmp/ego-browser-dialog-shot.png" });

      assert.equal(
        sent.some((request) => request.method === "Runtime.evaluate"),
        false,
      );
      const shot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.deepEqual(shot.params, {
        format: "png",
        captureBeyondViewport: false,
      });
    });
  } finally {
    restore();
  }

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tmp/ego-browser-dialog-shot.png");
});

test("screenshot stays passive in a user-controlled task space", async () => {
  const writes = [];
  const restore = setOverrides({
    taskSpaceReadOnly: true,
    selectedTaskSpaceId: 7,
    async writeFile(path, data) {
      writes.push({ path, data });
    },
  });
  try {
    await withCdpRuntime(async ({ sent }) => {
      await screenshot({ path: "/tmp/ego-browser-read-only-shot.png" });

      assert.equal(
        sent.some((request) => request.method === "Runtime.evaluate"),
        false,
      );
      const shot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.deepEqual(shot.params, {
        format: "png",
        captureBeyondViewport: false,
      });
    });
  } finally {
    restore();
  }

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tmp/ego-browser-read-only-shot.png");
});

test("screenshot creates a missing parent directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ego-browser-observe-"));
  const path = join(tempDir, "nested", "shot.png");
  try {
    await withCdpRuntime(() => screenshot({ path, raw: true }));
    assert.equal((await readFile(path)).toString(), "png");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("a generated screenshot is private and cannot overwrite an existing file", async () => {
  const writes = [];
  const restore = setOverrides({
    async writeFile(path, data, options) {
      writes.push({ path, data, options });
    },
  });
  try {
    await withCdpRuntime(() => screenshot({ raw: true }));
  } finally {
    restore();
  }

  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /^\/tmp\/ego-browser-shot-/);
  assert.deepEqual(writes[0].options, { mode: 0o600, flag: "wx" });
});

test("screenshot gives captureScreenshot a larger CDP response deadline", async () => {
  const requests = [];
  const restore = setOverrides({
    async send(request) {
      requests.push(request);
      return { result: { data: Buffer.from("png").toString("base64") } };
    },
    async writeFile() {},
  });
  try {
    await screenshot({ path: "/tmp/ego-browser-timeout-shot.png", raw: true });
  } finally {
    restore();
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "Page.captureScreenshot");
  assert.equal(requests[0].timeout_ms, 60_000);
});

test("drainEvents resolves to the current event array", async () => {
  assert.ok(Array.isArray(await drainEvents()));
});

// The documented signature is page.drainEvents() => Promise<object[]>, so a
// caller is entitled to chain on the result rather than await it. Returning a
// bare array made that a TypeError.
test("drainEvents returns a thenable, so .then/.catch chain instead of throwing", async () => {
  const pending = drainEvents();
  assert.equal(typeof pending.then, "function");
  assert.equal(typeof pending.catch, "function");
  assert.ok(Array.isArray(await pending.catch(() => "unreachable")));
});
