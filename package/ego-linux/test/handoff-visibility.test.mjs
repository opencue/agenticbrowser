import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own state dir: this suite writes task spaces, and must never do that to
// the spaces a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-handoff-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
// The idle sweep is a separate concern; keep it out of these assertions.
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

const VISIBLE_UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/148.0.0.0 Safari/537.36";
// What --headless=new answers. Note the product string does not say headless —
// "Chrome/148.0.7778.167" — which is why the port reads the user agent instead.
const HEADLESS_UA =
  "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/148.0.0.0 Safari/537.36";

/**
 * A browser that records what was asked of it.
 * @param {{userAgent?: string, windowState?: string, failBringToFront?: boolean}} options
 */
function fakeCdp({
  userAgent = VISIBLE_UA,
  windowState = "normal",
  failBringToFront = false,
  targetInfos = [
    { type: "page", targetId: "t-a", url: "https://a.example" },
  ],
} = {}) {
  const calls = [];
  return {
    calls,
    claimSession(sessionId) {
      calls.push({ method: "claimSession", params: { sessionId } });
    },
    releaseSession(sessionId) {
      calls.push({ method: "releaseSession", params: { sessionId } });
    },
    async call(method, params) {
      calls.push({ method, params });
      switch (method) {
        case "Target.getTargets":
          return { targetInfos };
        case "Browser.getVersion":
          return { product: "Chrome/148.0.7778.167", userAgent };
        case "Browser.getWindowForTarget":
          return { windowId: 7 };
        case "Browser.getWindowBounds":
          return { bounds: { windowState, left: 0, top: 0, width: 1280, height: 900 } };
        case "Target.attachToTarget":
          return { sessionId: "s-1" };
        case "Page.bringToFront":
          if (failBringToFront) throw new Error("raise failed");
          return {};
        default:
          return {};
      }
    },
  };
}

async function seed(targetIds = ["t-a"]) {
  const at = Date.now();
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({
      spaces: [
        {
          id: 1,
          taskId: 1,
          name: "space 1",
          createdAt: at,
          touchedAt: at,
          lastContentAt: at,
          ownership: "agent",
          targetIds,
        },
      ],
      selectedId: 1,
      nextId: 2,
    }),
  );
}

async function ownership() {
  const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
  return state.spaces[0].ownership;
}

/** Collect what the port wrote to stderr while running `run`. */
async function captureStderr(run) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk, ...rest) => {
    captured += String(chunk);
    return original(chunk, ...rest);
  };
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

describe("handing a space to the user puts it where they can see it", () => {
  it("raises the window, not just the tab", async () => {
    await seed();
    const cdp = fakeCdp();
    const result = await createTaskSpacesApi(cdp).handOffTaskSpace(1);

    assert.deepEqual(result, { done: true, visible: true });
    assert.equal(await ownership(), "agentDelegatedToUser", "control moved to the user");

    const methods = cdp.calls.map((call) => call.method);
    assert.ok(methods.includes("Target.activateTarget"), "the space's tab is selected");
    assert.ok(
      methods.includes("Page.bringToFront"),
      "and the window itself is raised — selecting a tab in a buried window shows nobody anything",
    );
  });

  it("raises real content instead of a stranded ready-page anchor", async () => {
    await seed(["t-ready", "t-content"]);
    const cdp = fakeCdp({
      targetInfos: [
        { type: "page", targetId: "t-ready", url: "about:blank" },
        {
          type: "page",
          targetId: "t-content",
          url: "https://business.example/settings",
        },
      ],
    });

    await createTaskSpacesApi(cdp).handOffTaskSpace(1);

    const activation = cdp.calls.find(
      (call) => call.method === "Target.activateTarget",
    );
    assert.equal(
      activation?.params.targetId,
      "t-content",
      "the user should see the task's real page, not its initial ready page",
    );
    const attachment = cdp.calls.find(
      (call) => call.method === "Target.attachToTarget",
    );
    assert.equal(attachment?.params.targetId, "t-content");
  });

  it("restores a minimized window", async () => {
    await seed();
    const cdp = fakeCdp({ windowState: "minimized" });
    await createTaskSpacesApi(cdp).handOffTaskSpace(1);

    const restore = cdp.calls.find((call) => call.method === "Browser.setWindowBounds");
    assert.deepEqual(restore?.params, { windowId: 7, bounds: { windowState: "normal" } });
  });

  it("leaves a maximized window maximized", async () => {
    await seed();
    const cdp = fakeCdp({ windowState: "maximized" });
    await createTaskSpacesApi(cdp).handOffTaskSpace(1);

    assert.equal(
      cdp.calls.find((call) => call.method === "Browser.setWindowBounds"),
      undefined,
      "handing the browser over must not resize a window the user sized themselves",
    );
  });

  it("reports a headless browser as invisible, and says so on stderr", async () => {
    await seed();
    const cdp = fakeCdp({ userAgent: HEADLESS_UA });
    let result;
    const warning = await captureStderr(async () => {
      result = await createTaskSpacesApi(cdp).handOffTaskSpace(1);
    });

    assert.deepEqual(result, { done: true, visible: false, reason: "headless" });
    // Still a real handoff: headless CI hands off with nobody watching, and the
    // e2e suite drives the port with --headless.
    assert.equal(await ownership(), "agentDelegatedToUser");
    assert.match(warning, /no window/i);
    assert.match(warning, /EGO_LINUX_HEADLESS/);
    assert.ok(
      !cdp.calls.some((call) => call.method === "Page.bringToFront"),
      "nothing to raise",
    );
  });

  it("says nothing about visibility when there is a window", async () => {
    await seed();
    const warning = await captureStderr(async () => {
      await createTaskSpacesApi(fakeCdp()).handOffTaskSpace(1);
    });
    assert.equal(warning, "");
  });

  it("detaches and reports invisible when raising the window fails", async () => {
    await seed();
    const cdp = fakeCdp({ failBringToFront: true });
    const result = await createTaskSpacesApi(cdp).handOffTaskSpace(1);

    assert.deepEqual(result, { done: true, visible: false, reason: "raise-failed" });
    assert.ok(cdp.calls.some((call) => call.method === "Target.detachFromTarget"));
    assert.ok(cdp.calls.some((call) => call.method === "releaseSession"));
  });

  it("raises the page a kept space leaves behind", async () => {
    await seed();
    const cdp = fakeCdp();
    const result = await createTaskSpacesApi(cdp).completeTaskSpace(1);

    assert.deepEqual(result, { done: true, visible: true });
    assert.equal(await ownership(), "user");
    assert.ok(cdp.calls.map((call) => call.method).includes("Page.bringToFront"));
  });

  it("reports a space whose tabs are gone as invisible", async () => {
    await seed();
    const closed = {
      async call(method) {
        if (method === "Target.getTargets") return { targetInfos: [] };
        return {};
      },
    };
    let result;
    const warning = await captureStderr(async () => {
      result = await createTaskSpacesApi(closed).handOffTaskSpace(1);
    });

    assert.deepEqual(result, { done: true, visible: false, reason: "no-live-tab" });
    assert.match(warning, /no live tab/i);
    assert.doesNotMatch(warning, /EGO_LINUX_HEADLESS/);
  });
});
