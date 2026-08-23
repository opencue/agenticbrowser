import test from "node:test";
import assert from "node:assert/strict";
import { startControlCenter } from "./control-center.js";

test("control center serves token-protected state and actions", async () => {
  const calls: Array<[string, number]> = [];
  const center = await startControlCenter(
    {
      snapshot: () => ({
        selectedId: 2,
        spaces: [
          {
            id: 2,
            name: "test task",
            ownership: "agent",
            createdBy: "agent",
            tabCount: 1,
            createdAt: 1,
            touchedAt: 2,
          },
        ],
        events: [],
      }),
      async select(id) {
        calls.push(["select", id]);
        return { done: true };
      },
      async present(id) {
        calls.push(["present", id]);
        return { done: true, visible: true };
      },
      async close(id) {
        calls.push(["close", id]);
        return { done: true };
      },
    },
    { token: "secret" },
  );

  try {
    const root = new URL(center.url);
    const forbidden = await fetch(`${root.origin}/api/state`);
    assert.equal(forbidden.status, 403);

    const state = await fetch(
      `${root.origin}/api/state?token=${root.searchParams.get("token")}`,
    );
    assert.equal(state.status, 200);
    assert.equal((await state.json()).spaces[0].name, "test task");

    const action = await fetch(
      `${root.origin}/api/spaces/2/present?token=${root.searchParams.get("token")}`,
      { method: "POST" },
    );
    assert.equal(action.status, 200);
    assert.deepEqual(calls, [["present", 2]]);

    const html = await fetch(center.url).then((response) => response.text());
    assert.match(html, /Ego Lite Task Spaces/);
    assert.match(html, /automatic cleanup/);
  } finally {
    await center.close();
  }
});
