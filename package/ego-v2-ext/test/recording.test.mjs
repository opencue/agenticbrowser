/**
 * Unit tests for recording.mjs — page.trace() and page.screencast getter.
 * No real browser or ffmpeg required; uses fake Pages with controllable
 * events() / cdp() / info() queues.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installRecording } from "../src/recording.mjs";

// ---------------------------------------------------------------------------
// Fake Page
// ---------------------------------------------------------------------------

function makeFakePage({
  eventResults = [[]],
  cdpResults = {},
  infoResult = { w: 1280, h: 720 },
} = {}) {
  let eventIdx = 0;
  const calls = { cdp: [], events: 0, info: 0 };

  class FakePage {
    async events() {
      calls.events++;
      if (eventIdx < eventResults.length) return eventResults[eventIdx++];
      return [];
    }
    async cdp(method, params) {
      calls.cdp.push({ method, params });
      return cdpResults[method] ?? {};
    }
    async info() {
      calls.info++;
      return infoResult;
    }
  }

  installRecording(FakePage.prototype, (proto, name, fn) => {
    if (!(name in proto)) {
      proto[name] = fn;
      return true;
    }
    return false;
  });

  return { page: new FakePage(), calls };
}

// ---------------------------------------------------------------------------
// installRecording — adds trace and screencast getter
// ---------------------------------------------------------------------------

describe("installRecording", () => {
  it("adds trace method to a plain prototype", () => {
    class P {}
    const added = [];
    installRecording(P.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        added.push(name);
        return true;
      }
      return false;
    });
    assert.ok(added.includes("trace"), "trace added");
    assert.equal(typeof P.prototype.trace, "function");
  });

  it("adds screencast as a non-enumerable getter on the prototype", () => {
    class P {}
    installRecording(P.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        return true;
      }
      return false;
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      P.prototype,
      "screencast",
    );
    assert.ok(descriptor, "screencast descriptor exists");
    assert.equal(typeof descriptor.get, "function", "screencast is a getter");
    assert.equal(descriptor.enumerable, false, "not enumerable");
  });

  it("does not shadow a trace method v2 already has", () => {
    class P {
      trace() {
        return "upstream";
      }
    }
    installRecording(P.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        return true;
      }
      return false;
    });
    assert.equal(new P().trace(), "upstream");
  });

  it("does not shadow a screencast property v2 already has", () => {
    class P {}
    Object.defineProperty(P.prototype, "screencast", {
      value: "upstream",
      configurable: true,
    });
    installRecording(P.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        return true;
      }
      return false;
    });
    assert.equal(new P().screencast, "upstream");
  });
});

// ---------------------------------------------------------------------------
// page.trace() — shape and schema
// ---------------------------------------------------------------------------

describe("page.trace() — empty event buffer", () => {
  it("returns the ego-browser.trace.v1 schema shape", async () => {
    const { page } = makeFakePage({ eventResults: [[]] });
    const result = await page.trace();
    assert.equal(result.schema, "ego-browser.trace.v1");
    assert.equal(typeof result.createdAt, "string");
    assert.equal(result.count, 0);
    assert.equal(result.shown, 0);
    assert.deepEqual(result.items, []);
  });
});

describe("page.trace() — with events", () => {
  it("drains events and returns the right count", async () => {
    const events = [
      {
        method: "Network.requestWillBeSent",
        params: {
          requestId: "r1",
          request: { url: "https://api.test/foo", method: "GET" },
        },
      },
      {
        method: "Network.responseReceived",
        params: {
          requestId: "r1",
          response: { url: "https://api.test/foo", status: 200 },
        },
      },
      {
        method: "Page.loadEventFired",
        params: {},
      },
    ];
    const { page } = makeFakePage({ eventResults: [events] });
    const result = await page.trace();
    assert.equal(result.count, 3);
    assert.equal(result.shown, 3);
    assert.equal(result.items.length, 3);

    const item0 = result.items[0];
    assert.equal(item0.kind, "event");
    assert.equal(item0.method, "Network.requestWillBeSent");
    assert.equal(typeof item0.seq, "number");
    assert.equal(typeof item0.at, "string");
    assert.equal(typeof item0.summary, "string");
    assert.match(item0.summary, /request/);
  });

  it("respects the limit option", async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      method: "Page.loadEventFired",
      params: {},
    }));
    const { page } = makeFakePage({ eventResults: [events] });
    const result = await page.trace({ limit: 3 });
    assert.equal(result.count, 10);
    assert.equal(result.shown, 3);
    assert.equal(result.items.length, 3);
  });

  it("limit: 0 returns empty items but correct count", async () => {
    const events = [{ method: "Page.loadEventFired", params: {} }];
    const { page } = makeFakePage({ eventResults: [events] });
    const result = await page.trace({ limit: 0 });
    assert.equal(result.count, 1);
    assert.equal(result.shown, 0);
    assert.deepEqual(result.items, []);
  });

  it("redacts secret query parameters by default", async () => {
    const events = [
      {
        method: "Network.requestWillBeSent",
        params: {
          requestId: "r2",
          request: {
            url: "https://api.test/auth?token=abc123&ok=1",
            method: "GET",
          },
        },
      },
    ];
    const { page } = makeFakePage({ eventResults: [events] });
    const result = await page.trace();
    assert.doesNotMatch(result.items[0].url ?? "", /abc123/);
    assert.match(result.items[0].url ?? "", /<redacted>/);
  });

  it("redact: false preserves query values", async () => {
    const events = [
      {
        method: "Network.requestWillBeSent",
        params: {
          requestId: "r3",
          request: {
            url: "https://api.test/auth?token=secret42",
            method: "GET",
          },
        },
      },
    ];
    const { page } = makeFakePage({ eventResults: [events] });
    const result = await page.trace({ redact: false });
    assert.match(result.items[0].url ?? "", /secret42/);
  });
});

describe("page.trace() — summary content", () => {
  it("produces readable summaries for common event types", async () => {
    const events = [
      { method: "Page.domContentEventFired", params: {} },
      { method: "Page.loadEventFired", params: {} },
      {
        method: "Network.loadingFailed",
        params: { requestId: "r4", errorText: "net::ERR_CONNECTION_REFUSED" },
      },
      {
        method: "Page.frameNavigated",
        params: { frame: { url: "https://example.com/" } },
      },
    ];
    const { page } = makeFakePage({ eventResults: [events] });
    const result = await page.trace({ redact: false });
    const summaries = result.items.map((i) => i.summary);
    assert.ok(
      summaries.some((s) => s === "domcontentloaded"),
      "domcontentloaded",
    );
    assert.ok(
      summaries.some((s) => s === "load"),
      "load",
    );
    assert.ok(
      summaries.some((s) => /request failed/.test(s)),
      "failed",
    );
    assert.ok(
      summaries.some((s) => /navigated/.test(s)),
      "navigated",
    );
  });
});

// ---------------------------------------------------------------------------
// page.screencast getter — caching
// ---------------------------------------------------------------------------

describe("page.screencast getter", () => {
  it("returns the same controller on repeated access", () => {
    const { page } = makeFakePage();
    const a = page.screencast;
    const b = page.screencast;
    assert.strictEqual(a, b, "same ScreencastController instance");
  });

  it("exposes start and stop methods", () => {
    const { page } = makeFakePage();
    assert.equal(typeof page.screencast.start, "function");
    assert.equal(typeof page.screencast.stop, "function");
  });

  it("different page instances have independent controllers", () => {
    class P {}
    installRecording(P.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        return true;
      }
      return false;
    });
    const p1 = new P();
    const p2 = new P();
    // Assign minimal stubs so the getter doesn't throw
    assert.notStrictEqual(p1.screencast, p2.screencast);
  });
});

// ---------------------------------------------------------------------------
// page.screencast.start() — option validation (no ffmpeg needed)
// ---------------------------------------------------------------------------

describe("page.screencast.start() — option validation", () => {
  it("throws when path does not end with .webm", async () => {
    const { page } = makeFakePage();
    await assert.rejects(
      page.screencast.start({ path: "/tmp/out.mp4" }),
      /path must end with .webm/,
    );
  });

  it("throws when quality is out of range", async () => {
    const { page } = makeFakePage();
    await assert.rejects(
      page.screencast.start({ path: "/tmp/out.webm", quality: 101 }),
      /quality must be between 0 and 100/,
    );
  });

  it("throws when size dimensions are too small", async () => {
    const { page } = makeFakePage();
    await assert.rejects(
      page.screencast.start({
        path: "/tmp/out.webm",
        size: { width: 1, height: 100 },
      }),
      /at least 2 pixels/,
    );
  });
});
