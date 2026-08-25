import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_DIR } from "../src/platform.mjs";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-state-race-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "fixture", "task-space-state-worker.mjs");

let nextTarget = 1;
function fakeCdp() {
  return {
    async call(method) {
      if (method === "Target.createTarget") {
        return { targetId: `target-${nextTarget++}` };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: `session-${nextTarget}` };
      }
      return {};
    },
  };
}

function runWorker(index, stateHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, String(index)], {
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        EGO_LINUX_SPACE_IDLE_MIN: "0",
        EGO_BROWSER_SESSION_ID: `${index.toString(16).padStart(8, "0")}-worker`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${index} exited ${code}: ${stderr}`));
    });
  });
}

describe("task-space state transactions", () => {
  it("preserves 50 concurrent space creations with unique ids", async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        createTaskSpacesApi(fakeCdp()).createTaskSpace(`parallel-${index}`),
      ),
    );

    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    assert.equal(state.spaces.length, 50);
    assert.equal(new Set(state.spaces.map((space) => space.id)).size, 50);
    assert.equal(new Set(state.spaces.map((space) => space.name)).size, 50);
    assert.equal(state.nextId, 51);
  });

  it("preserves 50 concurrent creations from separate agent processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-state-process-race-"));
    const stateHome = join(root, "state");

    await Promise.all(
      Array.from({ length: 50 }, (_, index) => runWorker(index, stateHome)),
    );

    const file = join(stateHome, APP_DIR, "task-spaces.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    assert.equal(state.spaces.length, 50);
    assert.equal(new Set(state.spaces.map((space) => space.id)).size, 50);
    assert.equal(new Set(state.spaces.map((space) => space.session)).size, 50);
    assert.equal(state.nextId, 51);
  });

  it("refuses to overwrite corrupt task-space state", async () => {
    const corrupt =
      '{"spaces":[{"id":99,"name":"valuable"}],"nextId":100,BROKEN';
    await writeFile(TASK_SPACE_FILE, corrupt);
    const api = createTaskSpacesApi(fakeCdp());

    await assert.rejects(
      () => api.createTaskSpace("new"),
      (error) => {
        assert.equal(error.error_code, "EGO_TASK_SPACE_STATE_UNAVAILABLE");
        assert.match(error.message, /invalid JSON/);
        assert.match(error.message, /refusing to overwrite/);
        return true;
      },
    );
    assert.equal(await readFile(TASK_SPACE_FILE, "utf8"), corrupt);

    const guard = api.pageControlErrorSync();
    assert.equal(guard.error_code, "EGO_TASK_SPACE_STATE_UNAVAILABLE");
    assert.match(guard.error, /refusing to overwrite/);
  });
});
