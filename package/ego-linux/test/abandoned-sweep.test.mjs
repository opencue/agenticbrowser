import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own state dir, for the reason the other suites have one: `npm test` must
// not read — or sweep — the task spaces a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-abandoned-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");

// Imported after that assignment: paths.mjs resolves its directories at module
// load, so a static import would bind the real ones first.
const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

const SECOND = 1000;

// This suite is about one rule, so the other sweep stays out of it.
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

/**
 * The anchor tab is still on about:blank and the working tab is not, which is
 * the whole distinction the sweep turns on.
 */
function fakeCdp(closed = []) {
  return {
    async call(method, params) {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { type: "page", targetId: "t-anchor", url: "about:blank" },
            { type: "page", targetId: "t-work", url: "https://example.com/a" },
          ],
        };
      }
      if (method === "Target.closeTarget") closed.push(params.targetId);
      if (method === "Target.createTarget") return { targetId: "t-new" };
      if (method === "Target.attachToTarget") return { sessionId: "s-1" };
      return {};
    },
  };
}

const ANCHOR = "opc diagnozis UX review";

/**
 * The unused space, plus the one holding the session — a seed of one space
 * would leave the sweep nothing to spare, and sparing is half the rule.
 */
async function seed(createdAgo) {
  const at = Date.now() - createdAgo;
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({
      spaces: [
        {
          id: 44,
          taskId: 44,
          name: ANCHOR,
          createdAt: at,
          touchedAt: at,
          ownership: "agent",
          targetIds: ["t-anchor"],
          urls: ["about:blank"],
        },
        {
          id: 48,
          taskId: 48,
          name: "the work in hand",
          createdAt: at,
          touchedAt: Date.now(),
          // Ever held a page, so only the abandoned rule is under test.
          lastContentAt: at,
          ownership: "agent",
          targetIds: ["t-work"],
          urls: ["https://example.com/a"],
        },
      ],
      selectedId: 48,
      nextId: 49,
      closedSpaces: [],
    }),
  );
}

/** Sweep the way anything touching the browser does: by listing the spaces. */
async function sweep(api) {
  await api.listTaskSpaces();
  return JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
}

describe("a space swept for never being used says so", () => {
  it("closes it and records why", async () => {
    delete process.env.EGO_LINUX_SPACE_ABANDONED_SEC;
    await seed(5 * 60 * SECOND);
    const closed = [];

    const state = await sweep(createTaskSpacesApi(fakeCdp(closed)));

    assert.deepEqual(
      state.spaces.map((space) => space.id),
      [48],
      "the unused space is closed",
    );
    assert.deepEqual(closed, ["t-anchor"], "and its tab with it");

    assert.equal(state.closedSpaces.length, 1, "the closure is remembered");
    const [closure] = state.closedSpaces;
    assert.equal(closure.name, ANCHOR);
    assert.equal(closure.reason, "abandoned", "named apart from an idle one");
    assert.ok(
      closure.unusedSeconds >= 300,
      `how long it sat unused, got ${closure.unusedSeconds}`,
    );
  });

  it("hands that back in its own words, not the idle sweep's", async () => {
    delete process.env.EGO_LINUX_SPACE_ABANDONED_SEC;
    await seed(5 * 60 * SECOND);
    const api = createTaskSpacesApi(fakeCdp());
    await sweep(api);

    // What useOrCreate does once it cannot find the name it was given.
    const space = await api.createTaskSpace(ANCHOR);

    assert.ok(space.previously, "the new space knows it is a replacement");
    assert.equal(space.previously.reason, "abandoned");
    assert.match(space.previously.note, /having never loaded a page/);
    assert.match(space.previously.note, /stopped before navigating anywhere/);
    assert.doesNotMatch(
      space.previously.note,
      /minutes idle/,
      "an unused space did not go idle; saying so sends the agent looking " +
        "for the wrong problem",
    );

    // Reported once: a later space of the same name is simply a new space.
    const again = await api.createTaskSpace(ANCHOR);
    assert.equal(again.previously, undefined);
  });

  it("spares a space still inside its grace period", async () => {
    delete process.env.EGO_LINUX_SPACE_ABANDONED_SEC;
    await seed(5 * SECOND);

    const state = await sweep(createTaskSpacesApi(fakeCdp()));

    assert.deepEqual(
      state.spaces.map((space) => space.id),
      [44, 48],
      "a space that has just opened has not given up yet",
    );
    assert.deepEqual(state.closedSpaces, []);
  });

  it("takes the grace period from the environment", async () => {
    process.env.EGO_LINUX_SPACE_ABANDONED_SEC = "600";
    await seed(5 * 60 * SECOND);

    const state = await sweep(createTaskSpacesApi(fakeCdp()));

    assert.deepEqual(
      state.spaces.map((space) => space.id),
      [44, 48],
      "five minutes is inside a ten-minute grace period",
    );
  });

  it("can be turned off entirely", async () => {
    process.env.EGO_LINUX_SPACE_ABANDONED_SEC = "0";
    await seed(60 * 60 * SECOND);

    const state = await sweep(createTaskSpacesApi(fakeCdp()));

    assert.deepEqual(
      state.spaces.map((space) => space.id),
      [44, 48],
      "nothing is swept for anyone who would rather clean up by hand",
    );
  });
});
