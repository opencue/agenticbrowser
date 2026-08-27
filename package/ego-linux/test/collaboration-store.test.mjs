import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-collaboration-store-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_COLLABORATION_INBOX = "1";

const { COLLABORATION_REQUEST_FILE, STATE_DIR } =
  await import("../src/paths.mjs");
const { createCollaborationStore } =
  await import("../src/collaboration-store.mjs");

function modeOf(stats) {
  return stats.mode & 0o777;
}

function manualAction(overrides = {}) {
  return {
    actionKey: "confirm-login",
    taskSpaceId: 7,
    taskSpaceName: "hostinger",
    agentProfile: "core+gstack",
    agentSession: "session-1",
    instruction: "Confirm the login, then choose Done.",
    target: { selector: "button.confirm", text: "Confirm" },
    doneLabel: "Done",
    cancelLabel: "Cancel",
    ...overrides,
  };
}

test("persists one private, idempotent pending request per action key and space", async () => {
  const store = createCollaborationStore();
  const created = await store.create(manualAction());

  assert.equal(created.status, "pending");
  assert.equal(created.version, 1);
  assert.equal(created.taskSpaceId, 7);
  assert.equal(created.actionKey, "confirm-login");
  assert.equal(created.target.description, "Confirm");
  assert.equal(
    "locator" in created.target,
    false,
    "selectors are not persisted",
  );
  assert.equal(modeOf(await stat(STATE_DIR)), 0o700);
  assert.equal(modeOf(await stat(COLLABORATION_REQUEST_FILE)), 0o600);

  const duplicate = await store.create(
    manualAction({ agentSession: "retry-session" }),
  );
  assert.equal(duplicate.id, created.id);
  assert.equal(duplicate.version, 1);

  await assert.rejects(
    store.create(manualAction({ instruction: "A different request." })),
    (error) => error?.status === 409 && error?.code === "EGO_COLLAB_CONFLICT",
  );

  const reloaded = createCollaborationStore();
  const pending = await reloaded.list({ view: "pending" });
  assert.deepEqual(
    pending.map(({ id }) => id),
    [created.id],
  );
});

test("commits a response once and makes identical retries idempotent", async () => {
  const store = createCollaborationStore();
  const request = await store.create(
    manualAction({ actionKey: "confirm-purchase", taskSpaceId: 8 }),
  );

  const resolved = await store.respond(request.id, {
    requestVersion: request.version,
    result: "done",
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.version, 2);
  assert.equal(resolved.response.result, "done");
  assert.equal(resolved.response.resumed, false);

  const retried = await store.respond(request.id, {
    requestVersion: request.version,
    result: "done",
  });
  assert.equal(retried.id, request.id);
  assert.equal(retried.version, 2);

  await assert.rejects(
    store.respond(request.id, {
      requestVersion: request.version,
      result: "cancel",
    }),
    (error) => error?.status === 409 && error?.request?.id === request.id,
  );

  const resumed = await store.markResume(request.id, {
    resumed: true,
    expectedResult: "done",
  });
  assert.equal(resumed.response.resumed, true);
  assert.equal(resumed.version, 3);
});

test("lets exactly one conflicting concurrent response win", async () => {
  const store = createCollaborationStore();
  const request = await store.create(
    manualAction({ actionKey: "concurrent-answer", taskSpaceId: 12 }),
  );

  const outcomes = await Promise.allSettled([
    store.respond(request.id, {
      requestVersion: request.version,
      result: "done",
    }),
    store.respond(request.id, {
      requestVersion: request.version,
      result: "cancel",
    }),
  ]);

  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(
      (outcome) =>
        outcome.status === "rejected" && outcome.reason?.status === 409,
    ).length,
    1,
  );
  const stored = await store.get(request.id);
  assert.ok(["done", "cancel"].includes(stored.response.result));
  assert.equal(stored.version, 2);
});

test("keeps pending requests while pruning terminal history by age", async () => {
  let now = Date.parse("2026-08-28T12:00:00Z");
  const store = createCollaborationStore({ now: () => now });
  const pending = await store.create(
    manualAction({ actionKey: "still-waiting", taskSpaceId: 9 }),
  );
  const terminal = await store.create(
    manualAction({ actionKey: "old-answer", taskSpaceId: 10 }),
  );
  await store.respond(terminal.id, {
    requestVersion: terminal.version,
    result: "cancel",
  });

  now += 25 * 60 * 60 * 1000;
  await store.create(
    manualAction({ actionKey: "trigger-retention", taskSpaceId: 11 }),
  );

  assert.ok(await store.get(pending.id));
  assert.equal(await store.get(terminal.id), null);
});

test("quarantines corrupt state instead of overwriting it silently", async () => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(COLLABORATION_REQUEST_FILE, "{not-json", { mode: 0o600 });

  const store = createCollaborationStore();
  assert.deepEqual(await store.list({ view: "pending" }), []);

  const files = await readdir(STATE_DIR);
  assert.ok(
    files.some((name) =>
      name.startsWith("collaboration-requests.json.corrupt-"),
    ),
  );
});

test.after(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
});
