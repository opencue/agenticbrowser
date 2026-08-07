import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-closure-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

const MINUTE = 60000;

/** Only "t-live" is open; anything else a space points at is already gone. */
function fakeCdp(liveUrl = "https://foxglove.example/a") {
  return {
    async call(method) {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [{ type: "page", targetId: "t-live", url: liveUrl }],
        };
      }
      if (method === "Target.createTarget") return { targetId: "new-tab" };
      if (method === "Target.createBrowserContext") {
        return { browserContextId: "ctx" };
      }
      return {};
    },
  };
}

async function seed(spaces) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({ spaces, selectedId: null, nextId: 99, closedSpaces: [] }),
  );
}

// The idle sweep already left a trail. These are the other two ways a space
// ends, and they are the ordinary ones — a space usually dies because its tabs
// went away, not because it sat untouched for half an hour.
describe("every way a space ends leaves something to come back to", () => {
  it("records a space whose last tab the user closed", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";
    const at = Date.now() - 5 * MINUTE;
    await seed([
      {
        id: 1,
        taskId: 1,
        name: "lifted editorial card redesign",
        createdAt: at,
        touchedAt: at,
        // Held a real page, so the abandoned reaper leaves it alone.
        lastContentAt: at,
        ownership: "agent",
        targetIds: ["t-closed-by-hand"],
        urls: ["https://shop.example/editorial", "about:blank"],
      },
    ]);

    await createTaskSpacesApi(fakeCdp()).listTaskSpaces();

    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    assert.equal(state.spaces.length, 0, "the space is gone");
    assert.equal(state.closedSpaces.length, 1, "and no longer silently");

    const [closure] = state.closedSpaces;
    assert.equal(closure.name, "lifted editorial card redesign");
    assert.equal(closure.reason, "tabs-closed");
    assert.deepEqual(
      closure.urls,
      ["https://shop.example/editorial"],
      "about:blank is not worth handing back",
    );
  });

  it("records a space reaped as abandoned", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";
    const at = Date.now() - 5 * MINUTE;
    await seed([
      {
        id: 1,
        taskId: 1,
        name: "opened and forgotten",
        createdAt: at,
        touchedAt: at,
        // Never held content, so the reaper claims it.
        ownership: "agent",
        targetIds: ["t-live"],
        urls: ["about:blank"],
      },
    ]);

    await createTaskSpacesApi(fakeCdp("about:blank")).listTaskSpaces();

    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    assert.equal(state.spaces.length, 0);
    assert.equal(state.closedSpaces.length, 1);
    assert.equal(state.closedSpaces[0].reason, "abandoned");
  });

  it("phrases each reason for whoever asks for the name again", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";
    const at = Date.now() - 5 * MINUTE;
    await seed([
      {
        id: 1,
        taskId: 1,
        name: "lifted editorial card redesign",
        createdAt: at,
        touchedAt: at,
        lastContentAt: at,
        ownership: "agent",
        targetIds: ["t-closed-by-hand"],
        urls: ["https://shop.example/editorial"],
      },
    ]);
    const api = createTaskSpacesApi(fakeCdp());
    await api.listTaskSpaces();

    const space = await api.createTaskSpace("lifted editorial card redesign");
    assert.ok(space.previously, "the new space knows it is a replacement");
    assert.match(space.previously.note, /was closed with its last tab/);
    assert.match(space.previously.note, /this is a new, empty one/);
    // The idle wording would have read "undefined minutes idle" here.
    assert.doesNotMatch(space.previously.note, /undefined/);
  });

  it("reports the trail alongside the live list, without spending it", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";
    const at = Date.now() - 5 * MINUTE;
    await seed([
      {
        id: 1,
        taskId: 1,
        name: "gone",
        createdAt: at,
        touchedAt: at,
        lastContentAt: at,
        ownership: "agent",
        targetIds: ["t-closed-by-hand"],
        urls: ["https://shop.example/x"],
      },
    ]);
    const api = createTaskSpacesApi(fakeCdp());

    const first = await api.listTaskSpaces();
    assert.equal(first.closedSpaces.length, 1, "a lookup can explain the miss");

    // Reading it must not consume it — a later useOrCreate still wants the entry.
    const second = await api.listTaskSpaces();
    assert.equal(second.closedSpaces.length, 1);
  });
});
