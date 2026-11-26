import test from "node:test";
import assert from "node:assert/strict";

import { startSpacesServer } from "../src/spaces-server.mjs";

const DAEMON_TOKEN = "spaces-timeout-test-token";

test("the Spaces API stays responsive when screenshot priming stalls", async () => {
  const never = new Promise(() => {});
  let captures = 0;
  const cdp = {
    onShimEvent() {},
    claimSession() {},
    releaseSession() {},
    async call(method) {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              type: "page",
              targetId: "tab-1",
              title: "Loading",
              url: "https://example.com/",
            },
          ],
        };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: "session-1" };
      }
      if (method === "Page.captureScreenshot") {
        captures += 1;
        return never;
      }
      if (method === "Runtime.evaluate") return { result: { value: null } };
      return {};
    },
  };
  const server = await startSpacesServer(
    {
      cdp,
      ego: {
        async listTaskSpaces() {
          return {
            taskSpaces: [
              {
                id: 1,
                name: "loading space",
                ownership: "agent",
                targetIds: ["tab-1"],
              },
            ],
          };
        },
      },
    },
    { shutdownToken: DAEMON_TOKEN },
  );

  try {
    const basic = await fetch(
      `http://127.0.0.1:${server.port}/api/spaces?preview=0`,
      { headers: { "x-ego-daemon-token": DAEMON_TOKEN } },
    );
    const { spaces } = await basic.json();
    assert.equal(basic.status, 200);
    assert.equal(spaces[0].name, "loading space");
    assert.equal(spaces[0].tabCount, 1);
    assert.equal(spaces[0].title, "Loading");
    assert.equal(spaces[0].thumbnail, null);
    assert.equal(captures, 0, "the first render must not prime screenshots");

    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/spaces`, {
      headers: { "x-ego-daemon-token": DAEMON_TOKEN },
      signal: AbortSignal.timeout(750),
    });
    assert.equal(response.status, 200);
    assert.ok(
      Date.now() - started < 750,
      "the card endpoint must not inherit the 30s CDP timeout",
    );
    const body = await response.json();
    assert.equal(body.spaces[0].name, "loading space");
    assert.equal(captures, 1, "the full refresh still primes screenshots");
  } finally {
    server.close();
  }
});
