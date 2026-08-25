import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-active-tab-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

function fakeCdp(liveIds = ["tab-a", "tab-b"]) {
  return {
    selectedTargetId: null,
    selectTarget(targetId) {
      this.selectedTargetId = targetId;
    },
    async call(method) {
      if (method === "Target.getTargets") {
        return {
          targetInfos: liveIds.map((targetId) => ({
            type: "page",
            targetId,
            url: `https://${targetId}.example`,
          })),
        };
      }
      return {};
    },
  };
}

async function seed(activeTargetId = "tab-b") {
  const now = Date.now();
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({
      spaces: [
        {
          id: 1,
          taskId: 1,
          name: "two-tab goal",
          createdAt: now,
          touchedAt: now,
          lastContentAt: now,
          ownership: "agent",
          targetIds: ["tab-a", "tab-b"],
          activeTargetId,
        },
      ],
      selectedId: 1,
      nextId: 2,
    }),
  );
}

async function storedSpace() {
  return JSON.parse(await readFile(TASK_SPACE_FILE, "utf8")).spaces[0];
}

describe("per-space active tab persistence", () => {
  it("resumes the stored active tab in a fresh task-space API", async () => {
    await seed("tab-b");
    const cdp = fakeCdp();

    await createTaskSpacesApi(cdp).useTaskSpace(1);

    assert.equal(cdp.selectedTargetId, "tab-b");
  });

  it("persists a logical switch for the next heredoc", async () => {
    await seed("tab-b");
    const first = createTaskSpacesApi(fakeCdp());
    await first.useTaskSpace(1);
    await first.noteActiveTarget("tab-a");
    assert.equal((await storedSpace()).activeTargetId, "tab-a");

    const nextCdp = fakeCdp();
    await createTaskSpacesApi(nextCdp).useTaskSpace(1);
    assert.equal(nextCdp.selectedTargetId, "tab-a");
  });

  it("falls back and repairs state when the active tab was closed", async () => {
    await seed("tab-b");

    await createTaskSpacesApi(fakeCdp(["tab-a"])).listTaskSpaces();

    const stored = await storedSpace();
    assert.deepEqual(stored.targetIds, ["tab-a"]);
    assert.equal(stored.activeTargetId, "tab-a");
  });
});
