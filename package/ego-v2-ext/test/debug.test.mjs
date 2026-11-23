import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pageDebug, redactUrl, summarizeEvents } from "../src/debug.mjs";

describe("page.debug", () => {
  it("redacts secrets in query strings", () => {
    assert.equal(
      redactUrl("https://x.test/cb?code=abc&state=1&access_token=zzz"),
      "https://x.test/cb?code=<redacted>&state=1&access_token=<redacted>",
    );
  });

  it("keeps only the events worth showing an agent", () => {
    const out = summarizeEvents([
      {
        method: "Runtime.consoleAPICalled",
        params: { type: "log", args: [{ value: "hi" }] },
      },
      {
        method: "Runtime.consoleAPICalled",
        params: { type: "error", args: [{ value: "boom" }] },
      },
      {
        method: "Network.responseReceived",
        params: { response: { status: 200, url: "a" } },
      },
      {
        method: "Network.responseReceived",
        params: { response: { status: 503, url: "https://x/api?token=t" } },
      },
      {
        method: "Page.frameNavigated",
        params: { frame: { url: "https://x/" } },
      },
      {
        method: "Page.frameNavigated",
        params: { frame: { url: "https://ad/", parentId: "f" } },
      },
    ]);
    assert.deepEqual(out, [
      { kind: "console.error", text: "boom" },
      {
        kind: "response.error",
        status: 503,
        url: "https://x/api?token=<redacted>",
      },
      { kind: "navigated", url: "https://x/" },
    ]);
  });

  it("reports a failing part in errors and keeps the rest", async () => {
    const page = {
      label: "p1",
      spaceId: 3,
      info: async () => ({ url: "https://x/?key=k", title: "X" }),
      snapshot: async () => "a".repeat(50),
      screenshot: async () => {
        throw new Error("screenshot timed out");
      },
      events: async () => [],
    };
    const dump = await pageDebug(page, { snapshotChars: 10 });
    assert.equal(dump.page.url, "https://x/?key=<redacted>");
    assert.match(dump.snapshot, /^a{10}\n\[\.\.\. 40 more characters\]$/);
    assert.equal(dump.errors.screenshot, "screenshot timed out");
    assert.deepEqual(dump.events, []);
  });
});
