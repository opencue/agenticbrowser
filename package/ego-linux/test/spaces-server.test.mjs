import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { APP_DIR, terminateProcess } from "../src/platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ego-browser.mjs");
const FIXTURE_URL = `file://${join(HERE, "fixture", "index.html")}`;
const DAEMON_TOKEN = "spaces-server-test-token";

// Its own profile and state dir, for the reason port.test.mjs has one: `npm test`
// must not hijack — and on teardown kill — the browser a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-spaces-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_PROFILE = join(SANDBOX, "profile");
process.env.EGO_LINUX_COLLABORATION_INBOX = "1";

// Imported after that assignment on purpose: paths.mjs resolves its directories
// at module load, so a static import would bind the real ones first.
const { createEgoShim } = await import("../src/shim.mjs");
const { startSpacesServer } = await import("../src/spaces-server.mjs");

const shim = await createEgoShim({ headless: true });
const server = await startSpacesServer(shim, {
  shutdownToken: DAEMON_TOKEN,
});
const BASE = `http://127.0.0.1:${server.port}`;

/** The panel's own window is 1280 wide; an active card is cropped to 16/10. */
const FOLLOW_CROP = { width: 760, height: 475 };

async function api(path, options) {
  const response = await fetch(BASE + path, {
    ...options,
    headers: {
      ...options?.headers,
      "x-ego-daemon-token": DAEMON_TOKEN,
    },
  });
  return { status: response.status, body: await response.json() };
}

/** Run a heredoc through the real CLI, against the browser this suite started. */
function runScript(source, { timeout = 120000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      // Pinned so the activity assertions read the same under every harness —
      // the badge otherwise names whichever agent ran the suite.
      env: {
        ...process.env,
        FIXTURE_URL,
        EGO_LINUX_CURSOR_NAME: "Testbot",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeout}ms\n${stdout}\n${stderr}`));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}\n${stdout}\n${stderr}`));
      else resolve(stdout);
    });
    child.stdin.end(source);
  });
}

async function visibilityState(targetId) {
  const { sessionId } = await shim.cdp.call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  shim.cdp.claimSession(sessionId);
  try {
    const result = await shim.cdp.call(
      "Runtime.evaluate",
      {
        expression: "document.visibilityState",
        returnByValue: true,
      },
      sessionId,
    );
    return result.result?.value;
  } finally {
    await shim.cdp
      .call("Target.detachFromTarget", { sessionId })
      .catch(() => {});
    shim.cdp.releaseSession(sessionId);
  }
}

/**
 * Wait for a space, or for the agent script to die trying.
 *
 * Racing the two matters more than it looks. The script runs in another
 * process, and when it fails the space simply never appears -- so waiting alone
 * reports "timed out waiting for space", which says nothing about why, and the
 * child's own error is never read because the timeout throws first. On Windows
 * that cost a full CI round: the real error was in the child, and the log had
 * only the timeout.
 */
async function waitForSpaceOrFailure(name, running, timeoutMs) {
  const died = running.then(
    (output) => {
      throw new Error(
        `the agent script exited before the space appeared:\n${output}`,
      );
    },
    (error) => {
      throw error;
    },
  );
  // The race may settle on the space instead, leaving this rejection unclaimed.
  died.catch(() => {});
  return Promise.race([waitForSpace(name, timeoutMs), died]);
}

async function waitForSpace(name, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api("/api/spaces");
    const space = body.spaces.find((candidate) => candidate.name === name);
    if (space?.title === "ego linux port fixture") return space;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for space ${name}`);
}

async function waitForActiveSpace(name, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { body } = await api("/api/spaces");
    const space = body.spaces.find((candidate) => candidate.name === name);
    last = space || null;
    if (space?.activity?.label === label && space.trail?.length) {
      return space;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `timed out waiting for activity in space ${name}: ${JSON.stringify(last)}`,
  );
}

/**
 * Width and height from a JPEG's start-of-frame marker. Enough to tell an
 * active space's crop from a whole-page thumbnail without a decoder.
 */
function jpegSize(dataUri) {
  const buffer = Buffer.from(String(dataUri).split(",")[1], "base64");
  for (let i = 2; i < buffer.length - 9; ) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1];
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        width: buffer.readUInt16BE(i + 7),
        height: buffer.readUInt16BE(i + 5),
      };
    }
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  return null;
}

after(async () => {
  // close() stops new connections but waits on live ones, and the panel holds a
  // keep-alive connection for its screencast. Without this the server handle
  // outlives the suite and node never exits.
  server.closeAllConnections?.();
  server.close();
  shim.close();
  try {
    const state = JSON.parse(
      await readFile(join(SANDBOX, "state", APP_DIR, "browser.json"), "utf8"),
    );
    // Not process.kill: on Windows that terminates only the browser process,
    // and Chrome's renderer and GPU children survive holding the profile
    // directory open -- which is what left four orphan chrome processes and a
    // node that would not exit behind the first Windows CI run.
    if (state.pid) await terminateProcess(state.pid);
  } catch {
    // nothing running
  }
  // Chrome keeps writing to its profile while shutting down, so a removal racing
  // that hits ENOTEMPTY. A leftover temp dir is not a test failure.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await rm(SANDBOX, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300,
  }).catch(() => {});
});

describe("Spaces overview server", () => {
  it("refuses every API route without the daemon token", async () => {
    for (const path of [
      "/api/health",
      "/api/spaces",
      "/api/events",
      "/api/collaboration/requests",
    ]) {
      const response = await fetch(BASE + path);
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), {
        error: "invalid daemon token",
      });
    }
  });

  it("answers a health probe, which is how the CLI finds a live daemon", async () => {
    const { status, body } = await api("/api/health");
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
  });

  it("lists and resolves a durable manual collaboration request exactly once", async () => {
    const { body: created } = await api("/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "inbox response space" }),
    });
    const request = await shim.collaborationStore.create({
      actionKey: "inbox-response",
      taskSpaceId: created.space.id,
      taskSpaceName: created.space.name,
      instruction: "Confirm the manual step.",
      doneLabel: "Done",
      cancelLabel: "Cancel",
    });

    const listed = await api("/api/collaboration/requests");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.enabled, true);
    assert.equal(listed.body.pendingCount, 1);
    assert.equal(listed.body.requests[0].id, request.id);

    const answered = await api(
      `/api/collaboration/requests/${request.id}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          requestVersion: request.version,
          response: { kind: "cancel" },
        }),
      },
    );
    assert.equal(answered.status, 200);
    assert.equal(answered.body.accepted, true);
    assert.equal(answered.body.resumed, false);
    assert.equal(answered.body.request.status, "cancelled");

    const retry = await api(
      `/api/collaboration/requests/${request.id}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          requestVersion: request.version,
          response: { kind: "cancel" },
        }),
      },
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.body.request.id, request.id);

    const conflict = await api(
      `/api/collaboration/requests/${request.id}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          requestVersion: request.version,
          response: { kind: "done" },
        }),
      },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.request.id, request.id);
  });

  it("rejects unsupported responses and keeps the request pending", async () => {
    const { body: created } = await api("/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "invalid inbox response space" }),
    });
    const request = await shim.collaborationStore.create({
      actionKey: "invalid-inbox-response",
      taskSpaceId: created.space.id,
      taskSpaceName: created.space.name,
      instruction: "This request only accepts Done or Cancel.",
    });

    const invalid = await api(
      `/api/collaboration/requests/${request.id}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          requestVersion: request.version,
          response: { kind: "approve" },
        }),
      },
    );
    assert.equal(invalid.status, 422);
    assert.equal(
      (await shim.collaborationStore.get(request.id)).status,
      "pending",
    );
  });

  it("keeps a no-page request pending when Open cannot present it", async () => {
    const { body: created } = await api("/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "inbox without a page" }),
    });
    const request = await shim.collaborationStore.create({
      actionKey: "open-missing-page",
      taskSpaceId: created.space.id,
      taskSpaceName: created.space.name,
      instruction: "Open a page that no longer exists.",
    });

    const opened = await api(`/api/collaboration/requests/${request.id}/open`, {
      method: "POST",
      body: JSON.stringify({ requestVersion: request.version }),
    });
    assert.equal(opened.status, 410);
    assert.equal(opened.body.reason, "no-live-tab");
    const stored = await shim.collaborationStore.get(request.id);
    assert.equal(stored.status, "pending");
    assert.equal(stored.version, request.version);
  });

  it("opens request context explicitly and resumes ownership only after Done", async () => {
    const { body: created } = await api("/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "inbox done space" }),
    });
    await shim.ego.useTaskSpace(created.space.id);
    await shim.ego.createTab(FIXTURE_URL);
    await shim.ego.handOffTaskSpace(created.space.id);
    const request = await shim.collaborationStore.create({
      actionKey: "inbox-done",
      taskSpaceId: created.space.id,
      taskSpaceName: created.space.name,
      instruction: "Complete the highlighted step.",
      doneLabel: "Done",
      cancelLabel: "Cancel",
    });

    const opened = await api(`/api/collaboration/requests/${request.id}/open`, {
      method: "POST",
      body: JSON.stringify({ requestVersion: request.version }),
    });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.request.status, "pending");
    assert.equal(opened.body.request.version, 2);
    assert.equal(opened.body.visible, false);
    assert.equal(opened.body.reason, "headless");

    const beforeDone = await api("/api/spaces");
    assert.equal(
      beforeDone.body.spaces.find((space) => space.id === created.space.id)
        .ownership,
      "agentDelegatedToUser",
    );

    const answered = await api(
      `/api/collaboration/requests/${request.id}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          requestVersion: opened.body.request.version,
          response: { kind: "done" },
        }),
      },
    );
    assert.equal(answered.status, 200);
    assert.equal(answered.body.resumed, true);
    assert.equal(answered.body.request.status, "resolved");

    const afterDone = await api("/api/spaces");
    assert.equal(
      afterDone.body.spaces.find((space) => space.id === created.space.id)
        .ownership,
      "agent",
    );
  });

  it("keeps a low-level user-action request after its CLI process exits", async () => {
    const output = await runScript(`
      const task = await taskSpaces.useOrCreate("persisted inbox bridge");
      await page.goto(process.env.FIXTURE_URL, { waitUntil: "load" });
      const shown = await ego.showUserAction({
        key: "persist-after-exit",
        instruction: "Confirm this request from Spaces.",
        doneLabel: "Done",
        cancelLabel: "Cancel",
      });
      console.log(JSON.stringify({ taskId: task.id, shown }));
    `);
    assert.match(output, /"alreadyVisible":false/);

    const listed = await api("/api/collaboration/requests");
    const request = listed.body.requests.find(
      (candidate) => candidate.actionKey === "persist-after-exit",
    );
    assert.ok(request, "the daemon sees the request after the CLI exits");
    assert.equal(request.taskSpaceName, "persisted inbox bridge");

    const cancelled = await api(
      `/api/collaboration/requests/${request.id}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          requestVersion: request.version,
          response: { kind: "cancel" },
        }),
      },
    );
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.request.status, "cancelled");
  });

  it("creates a targetless space without an empty thumbnail tab", async () => {
    const created = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "idle space" }),
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.space.name, "idle space");

    const { body } = await api("/api/spaces");
    const space = body.spaces.find(
      (candidate) => candidate.name === "idle space",
    );
    assert.ok(space, "the new space is listed");
    assert.equal(space.ownership, "agent");
    assert.equal(space.tabCount, 0);
    assert.equal(space.title, "");
    assert.equal(space.url, "");
    assert.equal(space.thumbnail, null);
    // Nothing has acted in it, so there is nothing to report.
    assert.equal(space.activity, null);
  });

  it("reports what an agent is doing, and where on the card it is working", async () => {
    const releaseFile = join(SANDBOX, "release-busy-space");
    await rm(releaseFile, { force: true });
    const running = runScript(
      `
      await taskSpaces.useOrCreate("busy space");
      await page.goto(process.env.FIXTURE_URL);
      await page.waitForLoadState();
      const point = await page.elementCenter("loc=css:#click-button");
      await page.mouse.click(point.x, point.y, { label: "counting clicks" });
      const { access } = await import("node:fs/promises");
      while (true) {
        try {
          await access(process.env.RELEASE_FILE);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    `,
      { env: { RELEASE_FILE: releaseFile } },
    );

    try {
      const space = await waitForActiveSpace("busy space", "counting clicks");

      // The panel and the agent are separate processes with separate CDP
      // connections; this only works because the live overlay leaves its state in
      // the page, where the server reads it back while the agent is still active.
      assert.equal(space.activity?.name, "Testbot");
      assert.equal(
        space.agent,
        "Testbot",
        "the card keeps its concise agent label",
      );
      assert.equal(space.activity?.label, "counting clicks");
      assert.ok(space.activity.ageMs >= 0 && space.activity.ageMs < 30000);

      // Frames now arrive by screencast, which delivers the whole viewport and
      // cannot crop. The card zooms to the cursor itself, so what the server has
      // to supply is where the cursor is — as a fraction of the viewport, which
      // survives whatever size the frame happens to be.
      const { fx, fy } = space.activity;
      assert.ok(
        typeof fx === "number" && fx >= 0 && fx <= 1,
        "the cursor's horizontal position travels with the card",
      );
      assert.ok(
        typeof fy === "number" && fy >= 0 && fy <= 1,
        "the cursor's vertical position travels with the card",
      );

      if (space.thumbnail) {
        const size = jpegSize(space.thumbnail);
        assert.ok(
          size && size.width > 0 && size.height > 0,
          "a frame is served",
        );
      }

      // The trail travels the same way and outlives the activity window, so a
      // space that has gone quiet still says what it did.
      assert.ok(
        space.trail?.length,
        "the card carries a trail of what happened",
      );
      assert.match(space.trail[0].text, /^clicked /, "newest first");
      assert.ok(space.trail[0].ageMs >= 0, "aged, not timestamped");
    } finally {
      await writeFile(releaseFile, "done");
      await running;
    }

    const { body: afterExit } = await api("/api/spaces");
    const stopped = afterExit.spaces.find(
      (candidate) => candidate.name === "busy space",
    );
    assert.equal(
      stopped?.activity?.name,
      "Testbot",
      "the card keeps the last agent visible between CLI processes",
    );
    assert.equal(stopped?.activity?.label, "counting clicks");
    assert.ok(
      stopped.activity.ageMs >= 0 && stopped.activity.ageMs < 30000,
      "the retained activity still ages out through the normal activity window",
    );
  });

  it("refuses a cross-origin caller", async () => {
    // Loopback is not a boundary here: any page in the agent's own browser can
    // reach this server, and it can create and close spaces.
    const { status } = await api("/api/spaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ name: "not yours" }),
    });
    assert.equal(status, 403);
  });

  it("refuses a different loopback origin", async () => {
    const { status } = await api("/api/spaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:1",
      },
      body: JSON.stringify({ name: "wrong local origin" }),
    });
    assert.equal(status, 403);
  });

  it("rejects malformed JSON instead of creating a default space", async () => {
    const { status, body } = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(status, 400);
    assert.deepEqual(body, { error: "invalid JSON body" });
  });

  it("rejects a non-object body and a non-string space name", async () => {
    const nonObject = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    assert.equal(nonObject.status, 400);
    assert.deepEqual(nonObject.body, { error: "body must be a JSON object" });

    const invalidName = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    assert.equal(invalidName.status, 400);
    assert.deepEqual(invalidName.body, {
      error: "space name must be a string",
    });
  });

  it("rejects an oversized request body", async () => {
    const { status, body } = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(65 * 1024) }),
    });
    assert.equal(status, 413);
    assert.deepEqual(body, { error: "request body too large" });
  });

  it("keeps a recent cursor visible while a stalled screenshot is isolated", async () => {
    const calls = [];
    const stalledServer = await startSpacesServer(
      {
        ego: {
          async listTaskSpaces() {
            return {
              taskSpaces: [
                {
                  id: 1,
                  name: "stalled card",
                  ownership: "agent",
                  targetIds: ["t-stalled"],
                },
              ],
            };
          },
        },
        cdp: {
          onShimEvent() {},
          claimSession() {},
          releaseSession() {},
          async call(method) {
            calls.push(method);
            if (method === "Target.getTargets") {
              return {
                targetInfos: [
                  {
                    type: "page",
                    targetId: "t-stalled",
                    title: "Stalled",
                    url: "https://example.com",
                  },
                ],
              };
            }
            if (method === "Target.attachToTarget") {
              const attaches = calls.filter(
                (candidate) => candidate === "Target.attachToTarget",
              ).length;
              return { sessionId: `s-${attaches}` };
            }
            if (method === "Page.captureScreenshot") {
              return new Promise(() => {});
            }
            if (method === "Runtime.evaluate") {
              return {
                result: {
                  value: {
                    name: "Testbot",
                    label: "still responsive",
                    ageMs: 45_000,
                    x: 10,
                    y: 10,
                    viewportWidth: 100,
                    viewportHeight: 100,
                    trail: [],
                  },
                },
              };
            }
            return {};
          },
        },
      },
      { shutdownToken: DAEMON_TOKEN },
    );

    try {
      const response = await fetch(
        `http://127.0.0.1:${stalledServer.port}/api/spaces`,
        {
          headers: { "x-ego-daemon-token": DAEMON_TOKEN },
          signal: AbortSignal.timeout(2500),
        },
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.spaces[0].name, "stalled card");
      assert.equal(body.spaces[0].thumbnail, null);
      assert.equal(
        body.spaces[0].activity?.name,
        "Testbot",
        "a thinking agent's cursor must not vanish after only 30 seconds",
      );
      assert.equal(
        body.spaces[0].activity?.live,
        false,
        "recent cursor presence stays visible without being called live",
      );
      assert.equal(
        calls.filter((method) => method === "Target.attachToTarget").length,
        3,
        "priming, screencast, and cursor reads use independent sessions",
      );
    } finally {
      stalledServer.close();
    }
  });

  it("returns a structured 500 when a browser operation fails", async () => {
    const failingServer = await startSpacesServer(
      {
        ...shim,
        ego: {
          ...shim.ego,
          async createTaskSpace() {
            throw new Error("internal browser detail");
          },
        },
      },
      { shutdownToken: DAEMON_TOKEN },
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${failingServer.port}/api/spaces`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-ego-daemon-token": DAEMON_TOKEN,
          },
          body: JSON.stringify({ name: "will fail" }),
          signal: AbortSignal.timeout(1000),
        },
      );
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "internal server error",
      });
    } finally {
      failingServer.close();
    }
  });

  it("passes handoff visibility through to the panel", async () => {
    const { body: created } = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "handoff visibility space" }),
    });
    const target = created.space;
    await shim.ego.useTaskSpace(target.id);
    await shim.ego.createTab(FIXTURE_URL);

    const stopped = await api(`/api/spaces/${target.id}/stop`, {
      method: "POST",
    });
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopped.body, {
      done: true,
      visible: false,
      reason: "headless",
    });

    await api(`/api/spaces/${target.id}/close`, { method: "POST" });
  });

  it("explicitly presents a space when Open is used", async () => {
    const { body: created } = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "open visibility space" }),
    });
    const target = created.space;
    await shim.ego.useTaskSpace(target.id);
    await shim.ego.createTab(FIXTURE_URL);

    const opened = await api(`/api/spaces/${target.id}/use`, {
      method: "POST",
    });
    assert.equal(opened.status, 200);
    assert.deepEqual(opened.body, {
      done: true,
      visible: false,
      reason: "headless",
    });

    await api(`/api/spaces/${target.id}/close`, { method: "POST" });
  });

  it("keeps an unrelated user view visible during background input and screenshots until Open", async () => {
    const name = "background foreground e2e";
    const { targetId: userViewId } = await shim.cdp.call(
      "Target.createTarget",
      {
        url: "data:text/html,<title>User%20view</title><h1>Do%20not%20steal%20this%20view</h1>",
      },
    );
    await shim.cdp.call("Target.activateTarget", { targetId: userViewId });

    let space;
    try {
      const running = runScript(`
        const task = await taskSpaces.useOrCreate(${JSON.stringify(name)});
        await page.goto(process.env.FIXTURE_URL, { waitUntil: "load" });
        await page.locator("#name-input").fill("background-ok");
        await page.locator("#click-button").click();
        await browser.switchTab((await browser.currentTab()).targetId);
        const shot = await page.screenshot();
        console.log(JSON.stringify({
          id: task.id,
          name: await page.locator("#name-input").inputValue(),
          count: await page.locator("#count").textContent(),
          shot,
        }));
        await new Promise((resolve) => setTimeout(resolve, 1200));
      `);

      space = await waitForSpaceOrFailure(name, running);
      const taskId = space.id;
      const { taskSpaces } = await shim.ego.listTaskSpaces();
      const target = taskSpaces.find((candidate) => candidate.id === taskId);
      const agentId = target?.targetIds?.[0];
      assert.ok(agentId, "the agent task owns a live tab");
      assert.equal(await visibilityState(userViewId), "visible");
      assert.equal(await visibilityState(agentId), "hidden");

      const output = await running;
      assert.match(output, /"name":"background-ok"/);
      assert.match(output, /"count":"clicked"/);
      const screenshotPath = output.match(/"shot":"([^"]+)"/)?.[1];
      assert.ok(
        screenshotPath,
        "the background page returned a screenshot path",
      );
      const screenshot = await readFile(screenshotPath);
      assert.deepEqual(
        [...screenshot.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
        "the hidden agent page produced a PNG",
      );
      assert.equal(
        await visibilityState(userViewId),
        "visible",
        "typing, clicking and screenshot capture did not steal the user view",
      );

      const opened = await api(`/api/spaces/${taskId}/use`, {
        method: "POST",
      });
      assert.equal(opened.status, 200);
      assert.equal(await visibilityState(agentId), "visible");
      assert.equal(await visibilityState(userViewId), "hidden");
    } finally {
      if (space?.id) {
        await api(`/api/spaces/${space.id}/close`, { method: "POST" }).catch(
          () => {},
        );
      }
      await shim.cdp
        .call("Target.closeTarget", { targetId: userViewId })
        .catch(() => {});
    }
  });

  it("closes a space and forgets it", async () => {
    // Creates its own rather than reusing another case's, so this still means
    // something when run alone through --test-name-pattern.
    const { body: created } = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "closeable space" }),
    });
    const target = created.space;

    const closed = await api(`/api/spaces/${target.id}/close`, {
      method: "POST",
    });
    assert.equal(closed.status, 200);

    const { body: after } = await api("/api/spaces");
    assert.ok(
      !after.spaces.some((candidate) => candidate.id === target.id),
      "the closed space is gone from the overview",
    );
  });

  it("404s an unknown route", async () => {
    const { status } = await api("/api/nope");
    assert.equal(status, 404);
  });
});
