import test from "node:test";
import assert from "node:assert/strict";

import { connectCdp } from "../src/transport.mjs";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor() {
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    this.onSend = null;
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
        this.listeners.set(
          type,
          (this.listeners.get(type) || []).filter(
            (candidate) => candidate !== entry,
          ),
        );
      }
    }
  }

  respond(id, result = {}) {
    this.dispatch("message", {
      data: JSON.stringify({ id, result }),
    });
  }

  send(payload) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    this.onSend?.(message);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", {});
  }
}

async function withFakeSocket(run) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  try {
    const cdp = await connectCdp("ws://127.0.0.1/devtools/browser/fake");
    await run(cdp, FakeWebSocket.instances[0]);
    cdp.close();
  } finally {
    globalThis.WebSocket = original;
  }
}

test("read-only CDP calls retry once after their operation timeout", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  };
  try {
    await withFakeSocket(async (cdp, socket) => {
      socket.onSend = (message) => {
        if (socket.sent.length === 2) {
          queueMicrotask(() => socket.respond(message.id, { targetInfos: [] }));
        }
      };

      const result = await cdp.call("Target.getTargets", {}, undefined, {
        timeoutMs: 10,
        retryDelayMs: 0,
      });

      assert.deepEqual(result, { targetInfos: [] });
      assert.equal(socket.sent.length, 2);
      assert.notEqual(socket.sent[0].id, socket.sent[1].id);
      assert.ok(!delays.includes(25), "an explicit zero delay stays zero");
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("mutating CDP calls do not retry after a timeout", async () => {
  await withFakeSocket(async (cdp, socket) => {
    await assert.rejects(
      cdp.call(
        "Target.createTarget",
        { url: "https://example.com" },
        undefined,
        { timeoutMs: 10 },
      ),
      (error) =>
        error?.code === "EGO_CDP_TIMEOUT" &&
        error?.method === "Target.createTarget",
    );
    assert.equal(socket.sent.length, 1);
  });
});

test("a per-call abort stops waiting without retrying", async () => {
  await withFakeSocket(async (cdp, socket) => {
    const controller = new AbortController();
    const pending = cdp.call("Target.getTargets", {}, undefined, {
      timeoutMs: 1000,
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(pending, (error) => error?.name === "AbortError");
    assert.equal(socket.sent.length, 1);
  });
});
