import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own state dir, for the reason the other suites have one: `npm test` must
// not read — or sweep — the task spaces a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-idle-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");

// Imported after that assignment: paths.mjs resolves its directories at module
// load, so a static import would bind the real ones first.
const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

const MINUTE = 60000;

/** Every space's tab is alive, so nothing but the idle rule can remove them. */
function fakeCdp(closed) {
  return {
    async call(method, params) {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { type: "page", targetId: "t-live", url: "https://example.com/a" },
            { type: "page", targetId: "t-idle", url: "https://example.com/b" },
            { type: "page", targetId: "t-other", url: "https://example.com/c" },
          ],
        };
      }
      if (method === "Target.closeTarget") closed.push(params.targetId);
      return {};
    },
  };
}

function space(id, targetId, touchedAt) {
  const at = Date.now() - 90 * MINUTE;
  return {
    id,
    taskId: id,
    name: `space ${id}`,
    createdAt: at,
    // Set, so pruneAbandoned leaves these alone and only the idle rule applies.
    lastContentAt: at,
    ...(touchedAt === undefined ? {} : { touchedAt }),
    ownership: "agent",
    targetIds: [targetId],
  };
}

async function seed(spaces, selectedId = null) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({ spaces, selectedId, nextId: 99 }),
  );
}

/** Read state back without a reconcile of its own colouring the result. */
async function storedSpaces() {
  return JSON.parse(await readFile(TASK_SPACE_FILE, "utf8")).spaces;
}

/** The sweep runs when a session commits to a space, so that is how it is driven. */
async function selectSpace(cdp, id) {
  await createTaskSpacesApi(cdp).useTaskSpace(id);
  return storedSpaces();
}

describe("idle task space sweep", () => {
  it("closes a space nobody came back to, and leaves a live one alone", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    const now = Date.now();
    await seed([
      space(1, "t-live", now - 5 * MINUTE),
      space(2, "t-idle", now - 31 * MINUTE),
    ]);

    const closed = [];
    const spaces = await selectSpace(fakeCdp(closed), 1);

    assert.deepEqual(
      spaces.map((s) => s.id),
      [1],
      "the space touched five minutes ago survives",
    );
    assert.deepEqual(closed, ["t-idle"], "and the idle one's tab is closed");
  });

  it("keeps the space a session is coming back to, however long it sat", async () => {
    // The regression: resuming starts by listing — useOrCreate(id) resolves the
    // id against the list before it selects — so a sweep on the read path closed
    // the space one call before the touch that would have spared it, and the
    // resume failed with "task space not found".
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    const now = Date.now();
    await seed([space(2, "t-idle", now - 300 * MINUTE)]);

    const closed = [];
    const api = createTaskSpacesApi(fakeCdp(closed));

    const listed = await api.listTaskSpaces();
    assert.deepEqual(
      listed.taskSpaces.map((s) => s.id),
      [2],
      "the space is still there to be resolved",
    );

    await api.useTaskSpace(2);
    assert.deepEqual((await storedSpaces()).map((s) => s.id), [2]);
    assert.deepEqual(closed, [], "and nothing was closed on the way back in");
  });

  it("never sweeps the selected space, however long it has sat", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    const now = Date.now();
    await seed([space(2, "t-idle", now - 300 * MINUTE)], 2);

    const closed = [];
    const spaces = await selectSpace(fakeCdp(closed), 2);

    assert.deepEqual(spaces.map((s) => s.id), [2]);
    assert.deepEqual(closed, [], "the space someone is on is not swept");
  });

  it("gives a space with no idle history a full window instead of sweeping it", async () => {
    // The migration case: every space that predates touchedAt would otherwise be
    // judged by createdAt and swept the first time this ran — including one a
    // colleague session is halfway through.
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    await seed([space(1, "t-live", undefined), space(2, "t-idle", undefined)]);

    const closed = [];
    const spaces = await selectSpace(fakeCdp(closed), 1);

    assert.deepEqual(
      spaces.map((s) => s.id),
      [1, 2],
      "an unstamped space is stamped, not closed",
    );
    assert.deepEqual(closed, []);

    // The stamp has to persist, or every run would re-stamp and nothing would
    // ever reach the threshold.
    for (const s of await selectSpace(fakeCdp([]), 1)) {
      assert.ok(s.touchedAt, `space ${s.id} kept its stamp`);
    }
  });

  it("leaves a space the user was given, however long it has sat", async () => {
    // The keep: true path sets ownership "user" precisely to say "leave this
    // page open", and a handoff sets "agentDelegatedToUser" while a person is
    // logging in. Neither produces an API call, so both would look idle.
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    const long = Date.now() - 300 * MINUTE;
    await seed([
      { ...space(1, "t-live", long), ownership: "user" },
      { ...space(2, "t-idle", long), ownership: "agentDelegatedToUser" },
      space(3, "t-other", Date.now()),
    ]);

    const closed = [];
    const spaces = await selectSpace(fakeCdp(closed), 3);

    assert.deepEqual(
      spaces.map((s) => s.id),
      [1, 2, 3],
      "a space in a person's hands is never swept",
    );
    assert.deepEqual(closed, []);
  });

  it("can be turned off entirely", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";
    const now = Date.now();
    await seed([
      space(1, "t-live", now),
      space(2, "t-idle", now - 5000 * MINUTE),
    ]);

    const closed = [];
    const spaces = await selectSpace(fakeCdp(closed), 1);

    assert.deepEqual(spaces.map((s) => s.id), [1, 2]);
    assert.deepEqual(closed, [], "nothing is swept when the sweep is disabled");
  });
});
