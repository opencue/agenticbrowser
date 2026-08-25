import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpaceManager, writePersistAtomically } from "./space-manager.js";

test("bootstraps user space id 1", () => {
  const sm = new SpaceManager();
  const user = sm.list().find((s) => s.id === 1);
  assert.equal(user?.ownership, "user");
  assert.equal(user?.name, "user");
});

test("createAgentSpace assigns tabs independently", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("job-a");
  const b = sm.createAgentSpace("job-b");
  sm.use(a.id);
  sm.assignTarget("t1");
  sm.use(b.id);
  sm.assignTarget("t2");
  sm.use(a.id);
  assert.deepEqual(sm.targetsForSelected(), ["t1"]);
  sm.use(b.id);
  assert.deepEqual(sm.targetsForSelected(), ["t2"]);
});

test("use on user space selects but marks user control for page ops", () => {
  const sm = new SpaceManager();
  const result = sm.use(1);
  assert.equal(result.ok, true);
  assert.equal(sm.selected()?.ownership, "user");
  assert.equal(sm.isPageControlBlocked(), true);
});

test("handOff then takeOver", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("x");
  sm.use(a.id);
  sm.handOff();
  assert.equal(sm.selected()?.ownership, "agentDelegatedToUser");
  assert.equal(sm.isPageControlBlocked(), true);
  sm.takeOver();
  assert.equal(sm.selected()?.ownership, "agent");
  assert.equal(sm.isPageControlBlocked(), false);
});

test("claim moves user space to agent", () => {
  const sm = new SpaceManager();
  sm.claim(1);
  assert.equal(sm.list().find((s) => s.id === 1)?.ownership, "agent");
});

test("use missing space returns not found", () => {
  const sm = new SpaceManager();
  const result = sm.use(999);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_FOUND");
  }
});

test("isPageControlBlocked false only for agent ownership", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("agent-job");
  sm.use(a.id);
  assert.equal(sm.selected()?.ownership, "agent");
  assert.equal(sm.isPageControlBlocked(), false);
});

test("listPublic strips targetIds", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("pub");
  sm.use(a.id);
  sm.assignTarget("t-pub");
  const pub = sm.listPublic().find((s) => s.id === a.id);
  assert.ok(pub);
  assert.equal("targetIds" in (pub as object), false);
  assert.equal(pub?.name, "pub");
  const internal = sm.list().find((s) => s.id === a.id);
  assert.deepEqual(internal?.targetIds, ["t-pub"]);
});

test("assignTarget moves tab between spaces", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("a");
  const b = sm.createAgentSpace("b");
  sm.assignTarget("shared", a.id);
  assert.equal(sm.spaceIdForTarget("shared"), a.id);
  sm.assignTarget("shared", b.id);
  assert.equal(sm.spaceIdForTarget("shared"), b.id);
  assert.equal(sm.list().find((s) => s.id === a.id)?.targetIds.includes("shared"), false);
});

test("useOrCreateAgentSpace reuses the same goal instead of multiplying spaces", () => {
  let now = 1_000;
  const sm = new SpaceManager(undefined, { now: () => now });
  const first = sm.useOrCreateAgentSpace("same goal");
  now = 2_000;
  const second = sm.useOrCreateAgentSpace("same goal");

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.space.id, first.space.id);
  assert.equal(
    sm.list().filter((space) => space.name === "same goal").length,
    1,
  );
  assert.equal(second.space.touchedAt, now);
});

test("tracks the active target independently for each space", () => {
  const sm = new SpaceManager();
  const space = sm.createAgentSpace("tabs");
  sm.use(space.id);
  sm.assignTarget("first");
  sm.assignTarget("second");
  sm.setActiveTarget("first");

  assert.equal(sm.activeTargetForSelected(), "first");
  assert.equal(sm.list().find((item) => item.id === space.id)?.activeTargetId, "first");
});

test("prunes abandoned and idle agent spaces but protects selected and user spaces", () => {
  let now = 0;
  const sm = new SpaceManager(undefined, { now: () => now });
  const abandoned = sm.createAgentSpace("abandoned");
  const idle = sm.createAgentSpace("idle");
  sm.assignTarget("idle-tab", idle.id);
  sm.reconcileTargets([
    { targetId: "idle-tab", title: "Worked", url: "https://example.com" },
  ]);
  const selected = sm.createAgentSpace("selected");
  sm.use(selected.id);

  now = 31 * 60_000;
  const removed = sm.prune({
    abandonedAfterMs: 2 * 60_000,
    idleAfterMs: 30 * 60_000,
  });

  assert.deepEqual(
    removed.map(({ id, reason }) => [id, reason]),
    [
      [abandoned.id, "abandoned"],
      [idle.id, "idle"],
    ],
  );
  assert.ok(sm.list().some((space) => space.id === selected.id));
  assert.ok(sm.list().some((space) => space.id === 1));
  assert.ok(sm.listEvents().some((event) => event.type === "space.pruned.abandoned"));
});

test("reconcileTargets records first content and falls back when the active tab closes", () => {
  let now = 5_000;
  const sm = new SpaceManager(undefined, { now: () => now });
  const space = sm.createAgentSpace("reconcile");
  sm.use(space.id);
  sm.assignTarget("blank");
  sm.assignTarget("content");
  sm.setActiveTarget("blank");

  sm.reconcileTargets([
    { targetId: "content", title: "Dashboard", url: "https://example.com" },
  ]);

  const current = sm.selected();
  assert.deepEqual(current?.targetIds, ["content"]);
  assert.equal(current?.activeTargetId, "content");
  assert.equal(current?.lastContentAt, now);
  assert.deepEqual(current?.recentTabTitles, ["Dashboard"]);
});

test("adoptOrphanTargets puts unknowns on user space", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("known");
  sm.assignTarget("known-t", a.id);
  sm.adoptOrphanTargets(["known-t", "orphan-1", "orphan-2"]);
  assert.equal(sm.spaceIdForTarget("known-t"), a.id);
  assert.equal(sm.spaceIdForTarget("orphan-1"), 1);
  assert.equal(sm.spaceIdForTarget("orphan-2"), 1);
});

test("closeSelected returns targetIds and removes agent space", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("to-close");
  sm.use(a.id);
  sm.assignTarget("c1");
  sm.assignTarget("c2");
  const closed = sm.closeSelected();
  assert.deepEqual(closed.sort(), ["c1", "c2"]);
  assert.equal(sm.list().find((s) => s.id === a.id), undefined);
  assert.equal(sm.selected(), null);
});

test("completeKeep transfers selected agent space to user ownership", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("done-keep");
  sm.use(a.id);
  sm.assignTarget("keep-tab");
  sm.completeKeep();
  const space = sm.list().find((s) => s.id === a.id);
  assert.equal(space?.ownership, "user");
  assert.deepEqual(space?.targetIds, ["keep-tab"]);
});

test("claim selects space and can rename", () => {
  const sm = new SpaceManager();
  const claimed = sm.claim(1, "claimed-user");
  assert.equal(claimed.ownership, "agent");
  assert.equal(claimed.name, "claimed-user");
  assert.equal(sm.selected()?.id, 1);
  assert.equal(sm.isPageControlBlocked(), false);
});

test("persist save/load round-trips spaces and selection", async () => {
  const dir = join(tmpdir(), `ego-space-mgr-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "spaces.json");
  try {
    const sm = new SpaceManager(path);
    const a = sm.createAgentSpace("persisted");
    sm.use(a.id);
    sm.assignTarget("pt1");
    sm.handOff();
    await sm.save();

    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(typeof raw.nextId, "number");
    assert.equal(raw.selectedId, a.id);
    assert.ok(Array.isArray(raw.spaces));

    const sm2 = new SpaceManager(path);
    await sm2.load();
    assert.equal(sm2.selected()?.id, a.id);
    assert.equal(sm2.selected()?.ownership, "agentDelegatedToUser");
    assert.deepEqual(sm2.targetsForSelected(), ["pt1"]);
    assert.ok(sm2.list().find((s) => s.id === 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persist save writes with restricted file mode", async () => {
  const dir = join(tmpdir(), `ego-space-mgr-mode-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "spaces.json");
  try {
    const sm = new SpaceManager(path);
    sm.createAgentSpace("secure");
    await sm.save();

    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed atomic commit preserves the previous valid state", async () => {
  const dir = join(tmpdir(), `ego-space-mgr-atomic-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "spaces.json");
  const original = JSON.stringify({ version: "original" });
  try {
    await writeFile(path, original, { encoding: "utf8", mode: 0o600 });

    await assert.rejects(
      () =>
        writePersistAtomically(
          path,
          {
            nextId: 2,
            selectedId: null,
            spaces: [],
          },
          {
            async beforeRename() {
              throw new Error("injected failure before rename");
            },
          },
        ),
      /injected failure/,
    );

    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load missing file keeps bootstrap user space", async () => {
  const path = join(
    tmpdir(),
    `ego-space-missing-${process.pid}-${Date.now()}.json`,
  );
  const sm = new SpaceManager(path);
  await sm.load();
  assert.equal(sm.list().find((s) => s.id === 1)?.name, "user");
});

test("load recovers corrupt file to bootstrap", async () => {
  const dir = join(tmpdir(), `ego-space-bad-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "spaces.json");
  try {
    await writeFile(path, "not-json{{{", "utf8");
    const sm = new SpaceManager(path);
    await sm.load();
    assert.equal(sm.list().find((s) => s.id === 1)?.ownership, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
