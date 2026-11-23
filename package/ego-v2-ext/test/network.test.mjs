/**
 * Unit tests for network.mjs — waitForRequest / waitForResponse.
 * No real browser is required; uses a fake Page with controllable
 * events() / cdp() queues.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installNetworkWaits } from "../src/network.mjs";

// ---------------------------------------------------------------------------
// Fake Page
// ---------------------------------------------------------------------------

function makeFakePage({ eventQueue = [], cdpResults = {} } = {}) {
  let queueIdx = 0;
  const calls = { cdp: [], events: 0 };

  class FakePage {
    async events() {
      calls.events++;
      if (queueIdx < eventQueue.length) return eventQueue[queueIdx++];
      return [];
    }
    async cdp(method, params) {
      calls.cdp.push({ method, params });
      if (method in cdpResults) return cdpResults[method];
      return {};
    }
  }

  installNetworkWaits(FakePage.prototype, (proto, name, fn) => {
    if (!(name in proto)) {
      proto[name] = fn;
      return true;
    }
    return false;
  });

  return { page: new FakePage(), calls };
}

function requestWillBeSentEvent(url, requestId = "r1", method = "GET") {
  return {
    method: "Network.requestWillBeSent",
    params: {
      requestId,
      request: { url, method, headers: { "user-agent": "test" } },
      type: "XHR",
    },
  };
}

function responseReceivedEvent(url, requestId = "r1", status = 200) {
  return {
    method: "Network.responseReceived",
    params: {
      requestId,
      response: {
        url,
        status,
        statusText: status === 200 ? "OK" : "Error",
        headers: { "content-type": "application/json" },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// installNetworkWaits — adds the right methods
// ---------------------------------------------------------------------------

describe("installNetworkWaits", () => {
  it("adds waitForRequest and waitForResponse to a plain prototype", () => {
    class P {}
    const added = [];
    installNetworkWaits(P.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        added.push(name);
        return true;
      }
      return false;
    });
    assert.deepEqual(added.sort(), ["waitForRequest", "waitForResponse"]);
    assert.equal(typeof P.prototype.waitForRequest, "function");
    assert.equal(typeof P.prototype.waitForResponse, "function");
  });

  it("does not shadow a method v2 already has", () => {
    class P {
      waitForRequest() {
        return "upstream";
      }
    }
    installNetworkWaits(P.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        return true;
      }
      return false;
    });
    assert.equal(new P().waitForRequest(), "upstream");
  });
});

// ---------------------------------------------------------------------------
// waitForRequest — string URL match
// ---------------------------------------------------------------------------

describe("waitForRequest — string URL match", () => {
  it("resolves when the exact URL is seen", async () => {
    const url = "https://api.example.com/data";
    const { page, calls } = makeFakePage({
      // First poll: nothing; second poll: the request event.
      eventQueue: [[], [requestWillBeSentEvent(url)]],
    });
    const req = await page.waitForRequest(url, { timeout: 2_000 });
    assert.equal(req.url(), url);
    assert.equal(req.method(), "GET");
    assert.equal(typeof req.headers, "function");
    assert.equal(typeof req.resourceType, "function");
    // Network domain was enabled.
    assert.ok(
      calls.cdp.some((c) => c.method === "Network.enable"),
      "Network.enable called",
    );
    // Never disabled afterwards: v2 owns the domain for its network-idle
    // tracking, and disabling it would clear v2's in-flight requests.
    assert.ok(
      !calls.cdp.some((c) => c.method === "Network.disable"),
      "Network.disable must not be sent",
    );
  });

  it("matches on the first poll if the event is already buffered", async () => {
    const url = "https://example.com/instant";
    const { page } = makeFakePage({
      eventQueue: [[requestWillBeSentEvent(url)]],
    });
    const req = await page.waitForRequest(url, { timeout: 1_000 });
    assert.equal(req.url(), url);
  });

  it("resolves with the correct resourceType", async () => {
    const { page } = makeFakePage({
      eventQueue: [
        [
          {
            method: "Network.requestWillBeSent",
            params: {
              requestId: "r2",
              request: {
                url: "https://cdn.test/img.png",
                method: "GET",
                headers: {},
              },
              type: "Image",
            },
          },
        ],
      ],
    });
    const req = await page.waitForRequest("https://cdn.test/img.png", {
      timeout: 1_000,
    });
    assert.equal(req.resourceType(), "image");
  });
});

// ---------------------------------------------------------------------------
// waitForRequest — RegExp match
// ---------------------------------------------------------------------------

describe("waitForRequest — RegExp match", () => {
  it("matches when the URL satisfies the regexp", async () => {
    const { page } = makeFakePage({
      eventQueue: [
        [requestWillBeSentEvent("https://api.example.com/users/42")],
      ],
    });
    const req = await page.waitForRequest(/\/users\/\d+/, { timeout: 1_000 });
    assert.match(req.url(), /\/users\/42/);
  });
});

// ---------------------------------------------------------------------------
// waitForRequest — predicate match
// ---------------------------------------------------------------------------

describe("waitForRequest — predicate match", () => {
  it("calls the predicate with a request facade and resolves on truthy", async () => {
    const url = "https://api.example.com/items";
    const received = [];
    const { page } = makeFakePage({
      eventQueue: [[requestWillBeSentEvent(url, "r3", "POST")]],
    });
    const req = await page.waitForRequest(
      (r) => {
        received.push({ url: r.url(), method: r.method() });
        return r.method() === "POST";
      },
      { timeout: 1_000 },
    );
    assert.equal(req.method(), "POST");
    assert.equal(received[0].method, "POST");
  });

  it("throws on async predicates", async () => {
    const { page } = makeFakePage({
      eventQueue: [[requestWillBeSentEvent("https://x.test/")]],
    });
    await assert.rejects(
      page.waitForRequest(async () => true, { timeout: 1_000 }),
      /does not support async predicates/,
    );
  });
});

// ---------------------------------------------------------------------------
// waitForRequest — timeout
// ---------------------------------------------------------------------------

describe("waitForRequest — timeout", () => {
  it("throws after the timeout with the right message", async () => {
    const { page } = makeFakePage({ eventQueue: [] });
    await assert.rejects(
      page.waitForRequest("https://never.test/nope", { timeout: 150 }),
      (err) => {
        assert.match(err.message, /waitForRequest timed out after 150ms/);
        return true;
      },
    );
  });

  it("throws on invalid timeout", async () => {
    const { page } = makeFakePage();
    await assert.rejects(
      page.waitForRequest("https://x.test/", { timeout: -1 }),
      /timeout must be a non-negative number/,
    );
  });

  it("throws on non-string/RegExp/function matcher", async () => {
    const { page } = makeFakePage({
      eventQueue: [[requestWillBeSentEvent("https://x.test/")]],
    });
    await assert.rejects(
      page.waitForRequest(null, { timeout: 200 }),
      /expects a string, RegExp, or function matcher/,
    );
  });
});

// ---------------------------------------------------------------------------
// waitForResponse — string URL and status
// ---------------------------------------------------------------------------

describe("waitForResponse — string URL match", () => {
  it("resolves when the exact URL and status are present", async () => {
    const url = "https://api.example.com/data";
    const { page } = makeFakePage({
      eventQueue: [
        [requestWillBeSentEvent(url), responseReceivedEvent(url, "r1", 200)],
      ],
    });
    const resp = await page.waitForResponse(url, { timeout: 2_000 });
    assert.equal(resp.url(), url);
    assert.equal(resp.status(), 200);
    assert.equal(resp.ok(), true);
    assert.equal(typeof resp.headers, "function");
    assert.ok(resp.request());
  });

  it("resolves for a 404 response too", async () => {
    const url = "https://api.example.com/missing";
    const { page } = makeFakePage({
      eventQueue: [
        [requestWillBeSentEvent(url), responseReceivedEvent(url, "r1", 404)],
      ],
    });
    const resp = await page.waitForResponse(url, { timeout: 1_000 });
    assert.equal(resp.status(), 404);
    assert.equal(resp.ok(), false);
  });
});

describe("waitForResponse — predicate", () => {
  it("resolves when predicate returns true for status 200", async () => {
    const url = "https://api.example.com/items";
    const { page } = makeFakePage({
      eventQueue: [
        [requestWillBeSentEvent(url), responseReceivedEvent(url, "r1", 200)],
      ],
    });
    const resp = await page.waitForResponse((r) => r.status() === 200, {
      timeout: 1_000,
    });
    assert.equal(resp.status(), 200);
  });
});

describe("waitForResponse — timeout", () => {
  it("throws after timeout with the right message", async () => {
    const { page } = makeFakePage({ eventQueue: [] });
    await assert.rejects(
      page.waitForResponse("https://never.test/", { timeout: 150 }),
      (err) => {
        assert.match(err.message, /waitForResponse timed out after 150ms/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Network domain ref-count — concurrent waits share one enable/disable
// ---------------------------------------------------------------------------

describe("Network domain ref-count", () => {
  it("only calls Network.enable once for concurrent waits on the same page", async () => {
    // Use a fresh class per test so the WeakMap ref-count starts at zero.
    class P2 {}
    installNetworkWaits(P2.prototype, (proto, name, fn) => {
      if (!(name in proto)) {
        proto[name] = fn;
        return true;
      }
      return false;
    });

    const cdpCalls = [];
    let slotIdx = 0;
    // Supply enough event slots so both concurrent pollers can each find a match.
    const url = "https://api.test/concurrent";
    const slots = Array.from({ length: 20 }, () => [
      requestWillBeSentEvent(url),
    ]);

    const page2 = new P2();
    page2.events = async () => slots[slotIdx++] ?? [];
    page2.cdp = async (method) => {
      cdpCalls.push(method);
      return {};
    };

    await Promise.all([
      page2.waitForRequest(url, { timeout: 2_000 }),
      page2.waitForRequest(url, { timeout: 2_000 }),
    ]);

    const enables = cdpCalls.filter((m) => m === "Network.enable");
    assert.equal(enables.length, 1, "Network.enable called only once");
  });
});
