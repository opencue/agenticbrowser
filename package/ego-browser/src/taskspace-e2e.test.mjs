import test from "node:test";
import assert from "node:assert/strict";

import { runMain } from "../dist/src/run.js";

class FakeEgo {
  constructor(taskSpaces = []) {
    this.taskSpaces = taskSpaces.map((space) => ({ ...space }));
    this.calls = [];
    this.selectedId = null;
    this.nextId =
      Math.max(
        0,
        ...this.taskSpaces.map((space) =>
          typeof space.id === "number" ? space.id : 0,
        ),
      ) + 1;
  }

  async listTaskSpaces() {
    this.calls.push(["listTaskSpaces"]);
    return { taskSpaces: this.taskSpaces.map((space) => ({ ...space })) };
  }

  useTaskSpace(id) {
    if (typeof id !== "number") {
      throw new TypeError("useTaskSpace requires numeric id");
    }
    this.calls.push(["useTaskSpace", id]);
    const space = this.taskSpaces.find((candidate) => candidate.id === id);
    if (space && space.ownership === "user") {
      this.selectedId = id;
      return { done: true, readOnly: true };
    }
    this.selectedId = id;
    return id;
  }

  async createTaskSpace(name) {
    this.calls.push(["createTaskSpace", name]);
    if (
      this.taskSpaces.some(
        (space) => space.taskId === name || space.name === name,
      )
    ) {
      return { error: `Task space already exists: ${name}` };
    }
    const created = {
      taskId: name,
      id: this.nextId++,
      name,
      createdBy: "agent",
      ownership: "agent",
      recentTabTitles: [],
    };
    this.taskSpaces.push(created);
    return { ...created };
  }

  async claimTaskSpace(id, name) {
    if (typeof id !== "number") {
      throw new TypeError("claimTaskSpace requires numeric id");
    }
    this.calls.push(["claimTaskSpace", id, name]);
    const space = this.taskSpaces.find((candidate) => candidate.id === id);
    if (!space || space.ownership !== "user") {
      return { error: `Task space not found: ${id}` };
    }
    if (name !== undefined) {
      space.name = name;
      space.taskId = name;
    }
    space.createdBy = "agent";
    space.ownership = "agent";
    return { ...space };
  }

  async closeTaskSpace() {
    this.calls.push(["closeTaskSpace", this.selectedId]);
    this.taskSpaces = this.taskSpaces.filter(
      (space) => space.id !== this.selectedId,
    );
    this.selectedId = null;
    return { done: true };
  }

  async presentTaskSpace(id) {
    if (typeof id !== "number") {
      throw new TypeError("presentTaskSpace requires numeric id");
    }
    this.calls.push(["presentTaskSpace", id]);
    return { done: true, visible: true };
  }

  async takeOverTaskSpace() {
    this.calls.push(["takeOverTaskSpace", this.selectedId]);
    return { done: true };
  }
}

async function runTaskspaceScript(ego, code) {
  const previous = globalThis.ego;
  globalThis.ego = ego;
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const exitCode = await runMain({
      argv: [],
      stdinText: code,
      stdout,
      stderr,
      services: { printUpdateBanner() {} },
    });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
}

function captureStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
    },
    text() {
      return chunks.join("");
    },
  };
}

function firstJsonLine(output) {
  return JSON.parse(output.trim().split(/\r?\n/)[0]);
}

test("taskspace e2e creates and selects a missing task space", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(
    ego,
    `
    const task = await taskSpaces.useOrCreate("checkout-flow");
    console.log(JSON.stringify({ task, selected: ego.selectedId }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    task: {
      taskId: "checkout-flow",
      id: 1,
      name: "checkout-flow",
      createdBy: "agent",
      ownership: "agent",
      recentTabTitles: [],
    },
    selected: 1,
  });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 1],
  ]);
});

test("taskspace e2e reuses an existing agent-owned task space", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "Checkout flow",
      createdBy: "agent",
      ownership: "agent",
    },
  ]);
  const result = await runTaskspaceScript(
    ego,
    `
    const task = await taskSpaces.useOrCreate(7);
    console.log(JSON.stringify({ task, selected: ego.selectedId }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    task: {
      taskId: "checkout-flow",
      id: 7,
      name: "Checkout flow",
      createdBy: "agent",
      ownership: "agent",
    },
    selected: 7,
  });
  assert.deepEqual(ego.calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("taskspace e2e claims and selects an existing user-owned task space", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  ]);
  const result = await runTaskspaceScript(
    ego,
    `
    const task = await taskSpaces.claim("checkout-flow");
    console.log(JSON.stringify({ task, selected: ego.selectedId }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    task: {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "agent",
      ownership: "agent",
    },
    selected: 7,
  });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
  ]);
});

test("taskspace e2e takeOver claims and selects a user-owned task space by id", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  ]);
  const result = await runTaskspaceScript(
    ego,
    `
    await taskSpaces.takeOver(7);
    console.log(JSON.stringify({
      selected: ego.selectedId,
      space: ego.taskSpaces.find((space) => space.id === 7)
    }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    selected: 7,
    space: {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "agent",
      ownership: "agent",
    },
  });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
    ["takeOverTaskSpace", 7],
  ]);
});

test("taskspace e2e takeOver resolves digit strings by id", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  ]);
  const result = await runTaskspaceScript(
    ego,
    `
    await taskSpaces.takeOver("7");
    console.log(JSON.stringify({ selected: ego.selectedId }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), { selected: 7 });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
    ["takeOverTaskSpace", 7],
  ]);
});

test("taskspace e2e useOrCreateTaskSpace selects user-owned spaces read-only without claiming", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  ]);

  const result = await runTaskspaceScript(
    ego,
    `
    const task = await taskSpaces.useOrCreate("checkout-flow");
    console.log(JSON.stringify({ id: task.id, ownership: task.ownership }));
  `,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    id: 7,
    ownership: "user",
  });
  assert.equal(ego.selectedId, 7);
  assert.deepEqual(ego.calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("taskspace e2e bringToFront raises user-owned spaces without taking control", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  ]);

  const result = await runTaskspaceScript(
    ego,
    `
    const out = await taskSpaces.bringToFront("checkout-flow");
    console.log(JSON.stringify({
      out,
      selected: ego.selectedId,
      space: ego.taskSpaces.find((space) => space.id === 7)
    }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    out: { done: true, visible: true },
    selected: null,
    space: {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  });
  assert.deepEqual(ego.calls, [["listTaskSpaces"], ["presentTaskSpace", 7]]);
});

test("taskspace e2e exposes taskSpaces facade", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(
    ego,
    `
    console.log(JSON.stringify({
      taskSpacesType: typeof taskSpaces,
      newType: typeof taskSpaces.new,
      runType: typeof taskSpaces.run,
      switchType: typeof taskSpaces.switch,
      claimType: typeof taskSpaces.claim,
      bringToFrontType: typeof taskSpaces.bringToFront,
      isHardStopErrorType: typeof taskSpaces.isHardStopError,
      oldNewType: typeof newTaskSpace,
      rawClaimType: typeof ego.claimTaskSpace
    }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    taskSpacesType: "object",
    newType: "function",
    runType: "function",
    switchType: "function",
    claimType: "function",
    bringToFrontType: "function",
    isHardStopErrorType: "function",
    oldNewType: "undefined",
    rawClaimType: "function",
  });
});

test("taskspace e2e taskSpaces.run completes a successful one-round task", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(
    ego,
    `
    const out = await taskSpaces.run("checkout-flow", async (task) => {
      return { taskId: task.id, selected: ego.selectedId };
    }, { timeout: 1234 });
    console.log(JSON.stringify({
      result: out.result,
      completion: out.completion,
      remaining: ego.taskSpaces.length
    }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    result: { taskId: 1, selected: 1 },
    completion: { done: true },
    remaining: 0,
  });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 1],
    ["listTaskSpaces"],
    ["useTaskSpace", 1],
    ["closeTaskSpace", 1],
  ]);
});

test("taskspace e2e taskSpaces.execute verifies before completing", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(
    ego,
    `
    const out = await taskSpaces.execute("verified-search", {
      risk: "read-only",
      retries: { max: 1, delay: 0, on: ["verification"] },
      async work({ attempt }) {
        return { attempt, selected: ego.selectedId };
      },
      async verify({ result }) {
        return { ok: result.attempt === 2, selected: result.selected };
      }
    });
    console.log(JSON.stringify({
      result: out.result,
      verification: out.verification,
      attempts: out.attempts,
      status: out.receipt.status,
      completion: out.completion,
      remaining: ego.taskSpaces.length
    }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    result: { attempt: 2, selected: 1 },
    verification: { ok: true, selected: 1 },
    attempts: 2,
    status: "verified",
    completion: { done: true },
    remaining: 0,
  });
});

test("cli e2e exposes the unified helperContext surface (help present, internals hidden)", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(
    ego,
    `
    console.log(JSON.stringify({
      helpType: typeof help,
      helpResultType: typeof help("page"),
      takeOverHelp: help("taskSpaces.takeOver").includes("claims that space"),
      bringToFrontHelp: help("taskSpaces.bringToFront").includes("without selecting"),
      executeHelp: help("taskSpaces.execute").includes("Automatic retries"),
      newTabType: typeof newTab,
      pageType: typeof page,
      oldClickType: typeof click,
      helperContextType: typeof helperContext,
      loadAgentHelpersType: typeof loadAgentHelpers
    }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    helpType: "function",
    helpResultType: "string",
    takeOverHelp: true,
    bringToFrontHelp: true,
    executeHelp: true,
    newTabType: "undefined",
    pageType: "object",
    oldClickType: "undefined",
    helperContextType: "undefined",
    loadAgentHelpersType: "undefined",
  });
});

test("taskspace e2e rejects explicit use of a user-owned task space", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  ]);

  await assert.rejects(
    () => runTaskspaceScript(ego, `await taskSpaces.switch("checkout-flow")`),
    /switchTaskSpace requires an agent-owned task space/,
  );
  assert.deepEqual(ego.calls, [["listTaskSpaces"]]);
});

test("taskspace e2e rejects unknown task space ownership", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      ownership: "shared",
    },
  ]);

  await assert.rejects(
    () =>
      runTaskspaceScript(ego, `await taskSpaces.useOrCreate("checkout-flow")`),
    /ownership "shared"/,
  );
  assert.deepEqual(ego.calls, [["listTaskSpaces"]]);
});

test("taskspace e2e surfaces newTaskSpace binding errors", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      ownership: "agent",
    },
  ]);

  await assert.rejects(
    () => runTaskspaceScript(ego, `await taskSpaces.new("checkout-flow")`),
    /newTaskSpace: Task space already exists: checkout-flow/,
  );
  assert.deepEqual(ego.calls, [["createTaskSpace", "checkout-flow"]]);
});
