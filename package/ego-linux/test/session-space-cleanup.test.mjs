import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-session-space-cleanup-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_SPACE_ABANDONED_SEC = "0";
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

function fakeCdp(calls) {
  return {
    async call(method, params) {
      calls.push([method, params]);
      return {};
    },
  };
}

async function seed() {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({
      spaces: [
        {
          id: 1,
          taskId: 1,
          name: "owned by this session",
          ownership: "agent",
          createdBy: "agent",
          session: "session-a",
          targetIds: ["target-a"],
          browserContextId: "context-a",
        },
        {
          id: 2,
          taskId: 2,
          name: "handed to the user",
          ownership: "agentDelegatedToUser",
          createdBy: "agent",
          session: "session-a",
          targetIds: ["target-user"],
        },
        {
          id: 3,
          taskId: 3,
          name: "owned by another session",
          ownership: "agent",
          createdBy: "agent",
          session: "session-b",
          targetIds: ["target-b"],
        },
        {
          id: 4,
          taskId: 4,
          name: "created by the user",
          ownership: "agent",
          createdBy: "user",
          session: "session-a",
          targetIds: ["target-created-by-user"],
        },
        {
          id: 5,
          taskId: 5,
          name: "completed and kept for the user",
          ownership: "user",
          createdBy: "agent",
          session: "session-a",
          targetIds: ["target-kept"],
        },
      ],
      selectedId: 1,
      nextId: 6,
      closedSpaces: [],
    }),
  );
}

describe("session cleanup: task-space ownership", () => {
  it("closes only agent-owned spaces created by the exact session", async () => {
    await seed();
    const calls = [];
    const api = createTaskSpacesApi(fakeCdp(calls));

    assert.deepEqual(await api.cleanupAgentSessionSpaces("session-a"), {
      closed: 1,
      skipped: 3,
    });

    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    assert.deepEqual(
      state.spaces.map((space) => space.id),
      [2, 3, 4, 5],
    );
    assert.equal(state.selectedId, null);
    assert.deepEqual(state.closedSpaces, [], "completion is not an idle sweep");
    assert.deepEqual(calls, [
      ["Target.closeTarget", { targetId: "target-a" }],
      ["Target.disposeBrowserContext", { browserContextId: "context-a" }],
    ]);
  });

  it("is idempotent and refuses an empty session id", async () => {
    await seed();
    const calls = [];
    const api = createTaskSpacesApi(fakeCdp(calls));

    assert.deepEqual(await api.cleanupAgentSessionSpaces(null), {
      closed: 0,
      skipped: 0,
      reason: "no-session",
    });
    assert.deepEqual(calls, []);

    await api.cleanupAgentSessionSpaces("session-a");
    assert.deepEqual(await api.cleanupAgentSessionSpaces("session-a"), {
      closed: 0,
      skipped: 3,
    });
  });
});
