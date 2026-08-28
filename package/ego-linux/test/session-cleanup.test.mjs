import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SESSION_ENV_NAMES,
  isRecognizedDevServer,
  stopSessionDevServers,
} from "../src/session-cleanup.mjs";

describe("session cleanup: dev-server ownership", () => {
  it("recognises only explicit Next, Vite, and React development servers", () => {
    assert.equal(
      isRecognizedDevServer([
        "/usr/bin/node",
        "/repo/node_modules/next/dist/bin/next",
        "dev",
      ]),
      true,
    );
    assert.equal(
      isRecognizedDevServer([
        "/usr/bin/node",
        "/repo/node_modules/.bin/next",
        "dev",
      ]),
      true,
      "npm may preserve the .bin symlink in argv",
    );
    assert.equal(
      isRecognizedDevServer([
        "/usr/bin/node",
        "/repo/node_modules/vite/bin/vite.js",
        "--host",
      ]),
      true,
    );
    assert.equal(
      isRecognizedDevServer([
        "/usr/bin/node",
        "/repo/node_modules/react-scripts/bin/react-scripts.js",
        "start",
      ]),
      true,
    );

    assert.equal(
      isRecognizedDevServer(["npm", "run", "dev"]),
      false,
      "a generic package script is not enough proof to terminate a process",
    );
    assert.equal(
      isRecognizedDevServer(["node", "server.mjs"]),
      false,
    );
    assert.equal(
      isRecognizedDevServer([
        "/usr/bin/node",
        "/repo/node_modules/next/dist/bin/next",
        "build",
      ]),
      false,
      "a Next production build is not a development server",
    );
  });

  it("signals and confirms only recognised processes carrying the exact session", async () => {
    const terminated = [];
    const alive = new Set([101, 102]);
    const platform = {
      async listProcessesByEnvironment(query) {
        assert.deepEqual(query, {
          names: SESSION_ENV_NAMES,
          value: "session-a",
        });
        return [
          {
            pid: 101,
            argv: [
              "/usr/bin/node",
              "/repo/node_modules/next/dist/bin/next",
              "dev",
            ],
          },
          { pid: 102, argv: ["node", "server.mjs"] },
        ];
      },
      async terminateProcess(pid) {
        terminated.push(pid);
        alive.delete(pid);
        return true;
      },
      processIsAlive(pid) {
        return alive.has(pid);
      },
    };

    const receipt = await stopSessionDevServers("session-a", {
      platform,
      timeoutMs: 0,
    });

    assert.deepEqual(terminated, [101]);
    assert.deepEqual(receipt, {
      matched: 1,
      signaled: 1,
      stopped: 1,
      pids: [101],
      remaining: [],
    });
    assert.equal(alive.has(102), true, "an unrecognised process is untouched");
  });

  it("does nothing when there is no attributable agent session", async () => {
    let listed = false;
    const receipt = await stopSessionDevServers(null, {
      platform: {
        async listProcessesByEnvironment() {
          listed = true;
          return [];
        },
      },
    });

    assert.equal(listed, false);
    assert.deepEqual(receipt, {
      matched: 0,
      signaled: 0,
      stopped: 0,
      pids: [],
      remaining: [],
      skipped: "no-session",
    });
  });
});
