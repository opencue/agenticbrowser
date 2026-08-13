import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-trail-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

const MINUTE = 60000;

function fakeCdp() {
  return {
    async call(method) {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { type: "page", targetId: "t-1", url: "https://foxglove.example/a" },
            { type: "page", targetId: "t-2", url: "https://foxglove.example/b" },
          ],
        };
      }
      if (method === "Target.createTarget") return { targetId: "new-tab" };
      if (method === "Target.createBrowserContext") return { browserContextId: "ctx" };
      return {};
    },
  };
}

function space(id, name, targetId, touchedAt) {
  const at = Date.now() - 90 * MINUTE;
  return {
    id,
    taskId: id,
    name,
    createdAt: at,
    touchedAt,
    lastContentAt: at,
    ownership: "agent",
    targetIds: [targetId],
    urls: [`https://foxglove.example/${targetId}`, "about:blank"],
  };
}

/**
 * The idle space, plus the space whose selection runs the sweep — that is where
 * it runs now, so a seed of one space would have nothing to sweep it.
 */
async function seedIdleSpace() {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({
      spaces: [
        {
          ...space(1, "long running work", "t-1", Date.now() - 90 * MINUTE),
          urls: ["https://foxglove.example/a", "about:blank"],
        },
        space(2, "the work in hand", "t-2", Date.now()),
      ],
      selectedId: null,
      nextId: 3,
      closedSpaces: [],
    }),
  );
}

/** Sweep the way a session does: by settling into a space of its own. */
async function sweep(api) {
  await api.useTaskSpace(2);
}

describe("an idle-closed space leaves something to come back to", () => {
  it("records what it held when the sweep closes it", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    await seedIdleSpace();

    await sweep(createTaskSpacesApi(fakeCdp()));

    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    assert.deepEqual(
      state.spaces.map((s) => s.id),
      [2],
      "the idle space is closed",
    );
    assert.equal(state.closedSpaces.length, 1, "and remembered");

    const [closure] = state.closedSpaces;
    assert.equal(closure.name, "long running work");
    assert.deepEqual(
      closure.urls,
      ["https://foxglove.example/a"],
      "about:blank is not worth handing back",
    );
    assert.ok(closure.idleMinutes >= 89, "with how long it had sat");
  });

  it("hands that back to whoever asks for the name again", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    await seedIdleSpace();
    const api = createTaskSpacesApi(fakeCdp());
    await sweep(api);

    // What useOrCreate does once it cannot find the name it was given.
    const space = await api.createTaskSpace("long running work");

    assert.ok(space.previously, "the new space knows it is a replacement");
    assert.deepEqual(space.previously.urls, ["https://foxglove.example/a"]);
    assert.match(space.previously.note, /closed after \d+ minutes idle/);
    assert.match(space.previously.note, /this is a new, empty one/);

    // Reported once: a later space of the same name is simply a new space.
    const again = await api.createTaskSpace("long running work");
    assert.equal(again.previously, undefined);
  });

  it("says nothing for a name that was never closed", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";
    await seedIdleSpace();
    const api = createTaskSpacesApi(fakeCdp());

    const space = await api.createTaskSpace("something else entirely");
    assert.equal(space.previously, undefined);
  });
});
