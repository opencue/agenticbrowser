import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-private-state-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

function modeOf(stats) {
  return stats.mode & 0o777;
}

test(
  "task-space state tightens permissive directories and files",
  { skip: process.platform === "win32" },
  async () => {
    const cdp = {
      async call(method) {
        if (method === "Target.createTarget") return { targetId: "tab-1" };
        if (method === "Target.attachToTarget") {
          return { sessionId: "session-1" };
        }
        return {};
      },
    };

    try {
      const api = createTaskSpacesApi(cdp);
      await api.createTaskSpace("private state");
      assert.equal(modeOf(await stat(STATE_DIR)), 0o700);
      assert.equal(modeOf(await stat(TASK_SPACE_FILE)), 0o600);

      await chmod(STATE_DIR, 0o775);
      await chmod(TASK_SPACE_FILE, 0o664);
      await api.createTaskSpace("tightened again");
      assert.equal(modeOf(await stat(STATE_DIR)), 0o700);
      assert.equal(modeOf(await stat(TASK_SPACE_FILE)), 0o600);
    } finally {
      await rm(SANDBOX, { recursive: true, force: true });
    }
  },
);
