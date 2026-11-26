import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { APP_DIR } from "../src/platform.mjs";
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

test("the launcher opens a matching daemon and shuts down a stale one first", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ego-spaces-launch-test-"));
  const stateDir = join(sandbox, APP_DIR);
  const expired = join(sandbox, "ego-browser-shot-1-1-1.png");
  const token = "secret-under-test";
  let buildId = await runtimeBuildId();
  const requests = [];
  const server = createServer((request, response) => {
    if (request.headers["x-ego-daemon-token"] !== token) {
      response.writeHead(403).end();
      return;
    }
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/api/health")
      response.end(JSON.stringify({ ok: true, buildId }));
    else if (request.url === "/api/open") response.end();
    // Refuse shutdown so we can check the upgrade order without starting Chrome.
    else response.writeHead(503).end();
  });
  const bin = fileURLToPath(new URL("../bin/ego-browser.mjs", import.meta.url));
  const launch = () =>
    promisify(execFile)(process.execPath, [bin, "--launch"], {
      timeout: 7000,
      env: {
        ...process.env,
        XDG_STATE_HOME: sandbox,
        EGO_LINUX_CDP_URL: "ws://127.0.0.1:1/spaces-launch-must-not-connect",
        EGO_BROWSER_ARTIFACT_TTL_HOURS: "1",
        TMPDIR: sandbox,
        TMP: sandbox,
        TEMP: sandbox,
      },
    });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await mkdir(stateDir);
    await writeFile(expired, "");
    await utimes(expired, 1, 1);
    await writeFile(
      join(stateDir, "spaces-server.json"),
      JSON.stringify({
        port: server.address().port,
        shutdownToken: token,
      }),
    );
    const { stderr } = await launch();
    assert.match(stderr, /Spaces panel:/);
    await access(expired); // The desktop launch must not sweep temporary files.
    assert.deepEqual(requests.splice(0), ["GET /api/health", "POST /api/open"]);

    buildId = "stale-build";
    await assert.rejects(launch(), /refused restart \(503\)/);
    assert.deepEqual(requests, ["GET /api/health", "POST /api/shutdown"]);
  } finally {
    server.close();
    await rm(sandbox, { recursive: true, force: true });
  }
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

test("the daemon only opens the Spaces panel on an authenticated request", async () => {
  let opens = 0;
  const server = await startSpacesServer(fakeShim(), {
    shutdownToken: "secret-under-test",
    onOpen: async () => {
      opens += 1;
    },
  });
  const url = `http://127.0.0.1:${server.port}/api/open`;
  const headers = { "x-ego-daemon-token": "secret-under-test" };
  try {
    assert.equal(opens, 0);
    assert.equal((await fetch(url, { method: "POST" })).status, 403);
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, origin: "https://example.com" },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(url, { headers })).status, 404);
    assert.equal(opens, 0);
    assert.equal((await fetch(url, { method: "POST", headers })).status, 200);
    assert.equal(opens, 1);
  } finally {
    server.close();
  }
});
