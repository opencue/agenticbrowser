import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own state dir: this suite writes task spaces, and must never do that to
// the spaces a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-observe-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
// The idle sweep is a separate concern; keep it out of these assertions.
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");
const { isObserverBlocked } = await import("../src/transport.mjs");
const { createCursorApi } = await import("../src/cursor.mjs");

/** A browser that records what was asked of it. */
function fakeCdp() {
  const calls = [];
  return {
    calls,
    methods: () => calls.map((call) => call.method),
    async call(method, params) {
      calls.push({ method, params });
      switch (method) {
        case "Target.getTargets":
          return {
            targetInfos: [{ type: "page", targetId: "t-a", url: "https://a.example" }],
          };
        case "Browser.getVersion":
          return {
            product: "Chrome/148.0.7778.167",
            userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/148.0.0.0 Safari/537.36",
          };
        case "Browser.getWindowForTarget":
          return { windowId: 7 };
        case "Browser.getWindowBounds":
          return { bounds: { windowState: "normal", left: 0, top: 0, width: 1280, height: 900 } };
        case "Target.attachToTarget":
          return { sessionId: "s-1" };
        default:
          return {};
      }
    },
  };
}

/** One space, owned and being driven by somebody else. */
async function seed() {
  const at = Date.now();
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({
      spaces: [
        {
          id: 1,
          taskId: 1,
          name: "someone else's work",
          createdAt: at,
          touchedAt: at,
          lastContentAt: at,
          ownership: "agent",
          targetIds: ["t-a"],
        },
      ],
      selectedId: 1,
      nextId: 2,
    }),
  );
  return readFile(TASK_SPACE_FILE, "utf8");
}

describe("observing a task space leaves it alone", () => {
  it("does not write the shared state file", async () => {
    // The state file is an unlocked read-modify-write shared with the agent that
    // is actively working in this space. An observer writing it is a lost update
    // waiting to happen, so the guarantee is that it writes nothing at all.
    const before = await seed();
    const cdp = fakeCdp();

    const result = await createTaskSpacesApi(cdp).observeTaskSpace(1);

    assert.deepEqual(result, {
      done: true,
      observing: true,
      id: 1,
      name: "someone else's work",
    });
    assert.equal(await readFile(TASK_SPACE_FILE, "utf8"), before, "byte-identical");
  });

  it("does not touch the driver's window or tab", async () => {
    await seed();
    const cdp = fakeCdp();

    await createTaskSpacesApi(cdp).observeTaskSpace(1);

    const methods = cdp.methods();
    for (const stealer of [
      "Target.activateTarget",
      "Page.bringToFront",
      "Browser.setWindowBounds",
    ]) {
      assert.ok(!methods.includes(stealer), `${stealer} would yank the window`);
    }
  });

  it("leaves ownership with the agent that is driving", async () => {
    await seed();
    const spaces = createTaskSpacesApi(fakeCdp());

    await spaces.observeTaskSpace(1);

    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    assert.equal(state.spaces[0].ownership, "agent", "the driver is still the owner");
    assert.equal(spaces.isObserving(), true);
  });

  it("observes a user-owned space too", async () => {
    // Watching a space the user owns is as legitimate as watching another
    // agent's; observing asserts nothing about who is responsible for the page.
    await seed();
    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    state.spaces[0].ownership = "user";
    await writeFile(TASK_SPACE_FILE, JSON.stringify(state));

    const spaces = createTaskSpacesApi(fakeCdp());
    await spaces.observeTaskSpace(1);

    assert.equal(spaces.isObserving(), true);
  });

  it("reports not-observing until asked to observe", async () => {
    await seed();
    assert.equal(createTaskSpacesApi(fakeCdp()).isObserving(), false);
  });
});

describe("taking control ends observation", () => {
  it("takeOverTaskSpace stops observing and claims ownership", async () => {
    await seed();
    const spaces = createTaskSpacesApi(fakeCdp());
    await spaces.observeTaskSpace(1);

    await spaces.takeOverTaskSpace(1);

    assert.equal(spaces.isObserving(), false, "input is allowed again");
    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    assert.equal(state.spaces[0].ownership, "agent");
  });

  it("useTaskSpace and claimTaskSpace also end it", async () => {
    for (const method of ["useTaskSpace", "claimTaskSpace"]) {
      await seed();
      const spaces = createTaskSpacesApi(fakeCdp());
      await spaces.observeTaskSpace(1);

      await spaces[method](1);

      assert.equal(spaces.isObserving(), false, `${method} means driving`);
    }
  });
});

describe("what an observer may not send", () => {
  it("blocks input, navigation, tab churn and window grabs", () => {
    for (const method of [
      "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent",
      "Input.insertText",
      "Input.dispatchTouchEvent",
      "Page.navigate",
      "Page.reload",
      "Page.navigateToHistoryEntry",
      "Target.createTarget",
      "Target.closeTarget",
      "Page.bringToFront",
      "Target.activateTarget",
      "Browser.setWindowBounds",
    ]) {
      assert.ok(isObserverBlocked(method), `${method} must be refused`);
    }
  });

  it("allows the reads an observer exists to make", () => {
    // Runtime.evaluate is deliberately allowed: the shim's own snapshot runs
    // through it. That is the documented limit of the read-only promise at this
    // layer — the harness blocks the public page.evaluate() instead.
    for (const method of [
      "Page.captureScreenshot",
      "Runtime.evaluate",
      "DOM.getDocument",
      "Target.getTargets",
      "Browser.getVersion",
    ]) {
      assert.ok(!isObserverBlocked(method), `${method} must still pass`);
    }
  });
});

describe("an observer draws no cursor", () => {
  const listTabs = async () => ({
    tabs: [{ targetId: "t-a", url: "https://a.example", active: true }],
  });

  it("renders nothing while observing", async () => {
    // The overlay is a singleton in the page, so a watcher that rendered would
    // overwrite the driver's cursor rather than appear beside it — and the badge
    // would then name the wrong agent for whatever the driver did next.
    const cdp = fakeCdp();
    const cursor = createCursorApi(cdp, { listTabs, isObserving: () => true });

    cursor.reading("watching");
    cursor.moveTo(10, 20);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(
      !cdp.methods().includes("Runtime.evaluate"),
      "no overlay render reached the page",
    );
  });

  it("still renders when driving", async () => {
    const cdp = fakeCdp();
    const cursor = createCursorApi(cdp, { listTabs, isObserving: () => false });

    cursor.reading("working");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(
      cdp.methods().includes("Runtime.evaluate"),
      "a driver's cursor is drawn as before",
    );
  });
});
