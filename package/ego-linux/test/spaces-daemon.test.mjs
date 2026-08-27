import test from "node:test";
import assert from "node:assert/strict";

import { runtimeBuildId } from "../src/runtime-version.mjs";
import { startSpacesServer } from "../src/spaces-server.mjs";

function fakeShim() {
  return {
    ego: {
      async listTaskSpaces() {
        return { taskSpaces: [] };
      },
    },
    cdp: {
      onShimEvent() {},
      releaseSession() {},
      async call(method) {
        if (method === "Target.getTargets") return { targetInfos: [] };
        return {};
      },
    },
  };
}

test("the runtime build id is stable for the loaded source tree", async () => {
  const first = await runtimeBuildId();
  const second = await runtimeBuildId();
  assert.match(first, /^[a-f0-9]{16}$/);
  assert.equal(second, first);
});

test("the Spaces health handshake identifies its build and authenticates shutdown", async () => {
  let shutdowns = 0;
  const server = await startSpacesServer(fakeShim(), {
    buildId: "build-under-test",
    shutdownToken: "secret-under-test",
    onShutdown: () => {
      shutdowns += 1;
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const refusedHealth = await fetch(`${base}/api/health`);
    assert.equal(refusedHealth.status, 403);

    const health = await fetch(`${base}/api/health`, {
      headers: { "x-ego-daemon-token": "secret-under-test" },
    });
    assert.deepEqual(await health.json(), {
      ok: true,
      buildId: "build-under-test",
    });

    const eventsController = new AbortController();
    const events = await fetch(`${base}/api/events`, {
      headers: { "x-ego-daemon-token": "secret-under-test" },
      signal: eventsController.signal,
    });
    assert.match(events.headers.get("content-type"), /^text\/event-stream/);
    const reader = events.body.getReader();
    const firstEvent = await reader.read();
    assert.match(new TextDecoder().decode(firstEvent.value), /event: refresh/);
    eventsController.abort();
    await reader.cancel().catch(() => {});

    const refused = await fetch(`${base}/api/shutdown`, { method: "POST" });
    assert.equal(refused.status, 403);
    assert.equal(shutdowns, 0);

    const accepted = await fetch(`${base}/api/shutdown`, {
      method: "POST",
      headers: { "x-ego-daemon-token": "secret-under-test" },
    });
    assert.equal(accepted.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdowns, 1);
  } finally {
    server.close();
  }
});
