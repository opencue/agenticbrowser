import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-anchor-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

/** A browser holding one tab for the space, at whatever url the test sets. */
function fakeCdp(anchorUrl) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              type: "page",
              targetId: "anchor",
              url: anchorUrl,
              browserContextId: "ctx",
            },
          ],
        };
      }
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Target.createTarget") return { targetId: "fresh-tab" };
      return {};
    },
  };
}

function fakeCreateSpaceCdp() {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "Target.createBrowserContext") {
        return { browserContextId: "ctx" };
      }
      if (method === "Storage.getCookies") {
        return { cookies: [] };
      }
      if (method === "Target.createTarget") {
        return { targetId: "anchor" };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: "s1" };
      }
      return {};
    },
  };
}

function fakeSyncedStorageCdp() {
  const calls = [];
  let session = 0;
  return {
    calls,
    claimSession() {},
    releaseSession() {},
    selectTarget() {},
    async call(method, params, sessionId, options) {
      calls.push({ method, params, sessionId, options });
      if (method === "Target.createBrowserContext") {
        return { browserContextId: "ctx" };
      }
      if (method === "Storage.getCookies") return { cookies: [] };
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { type: "page", targetId: "default-page", url: "about:blank" },
          ],
        };
      }
      if (method === "Target.attachToTarget") {
        session += 1;
        return { sessionId: `session-${session}` };
      }
      if (method === "DOMStorage.getDOMStorageItems") {
        return { entries: [["auth-token", "secret-value"]] };
      }
      if (
        method === "Runtime.evaluate" &&
        params.expression === "location.origin"
      ) {
        return { result: { value: "https://example.com" } };
      }
      if (method === "Target.createTarget") {
        return { targetId: "synced-target" };
      }
      return {};
    },
  };
}

const tabsApi = (cdp) => ({
  async createTab(url, browserContextId) {
    return cdp.call("Target.createTarget", { url, browserContextId });
  },
});

async function seed(space) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({ spaces: [space], selectedId: 1, nextId: 2 }),
  );
}

const baseSpace = {
  id: 1,
  taskId: 1,
  name: "work",
  createdAt: Date.now(),
  touchedAt: Date.now(),
  ownership: "agent",
  browserContextId: "ctx",
  targetIds: ["anchor"],
};

describe("the space's blank anchor tab is used, not stranded", () => {
  it("defers the shared profile's first tab until the destination is known", async () => {
    const previous = process.env.EGO_LINUX_TASK_SPACE_STORAGE;
    delete process.env.EGO_LINUX_TASK_SPACE_STORAGE;
    const cdp = fakeCreateSpaceCdp();
    try {
      const api = createTaskSpacesApi(cdp);
      const space = await api.createTaskSpace("work");

      assert.ok(
        !cdp.calls.some(
          (call) => call.method === "Target.createBrowserContext",
        ),
        "shared storage is the default, so no isolated context is created",
      );
      assert.equal(
        cdp.calls.some((call) => call.method === "Target.createTarget"),
        false,
        "no ready page is opened before the requested URL is known",
      );
      assert.deepEqual(space.targetIds, []);
      assert.equal(space.pendingFirstTab, true);

      await api.createTabInSelectedSpace(
        tabsApi(cdp),
        "https://example.com/requested",
      );
      const create = cdp.calls.find(
        (call) => call.method === "Target.createTarget",
      );
      assert.deepEqual(create?.params, {
        url: "https://example.com/requested",
        browserContextId: null,
      });
    } finally {
      if (previous === undefined)
        delete process.env.EGO_LINUX_TASK_SPACE_STORAGE;
      else process.env.EGO_LINUX_TASK_SPACE_STORAGE = previous;
    }
  });

  it("defers an isolated context's first tab until the destination is known", async () => {
    const previous = process.env.EGO_LINUX_TASK_SPACE_STORAGE;
    process.env.EGO_LINUX_TASK_SPACE_STORAGE = "isolated";
    const cdp = fakeCreateSpaceCdp();
    try {
      const api = createTaskSpacesApi(cdp);
      const space = await api.createTaskSpace("work");

      assert.ok(
        cdp.calls.some((call) => call.method === "Storage.getCookies"),
        "the default jar is read for the isolated cookie-copy mode",
      );
      assert.equal(
        cdp.calls.some((call) => call.method === "Target.createTarget"),
        false,
        "no ready-page window is opened before the requested URL is known",
      );
      assert.deepEqual(space.targetIds, []);
      const listed = await api.listTaskSpaces();
      assert.equal(
        listed.taskSpaces.some((candidate) => candidate.id === space.id),
        true,
        "the targetless space remains selectable until its first navigation",
      );

      await api.createTabInSelectedSpace(
        tabsApi(cdp),
        "https://example.com/requested",
      );
      const create = cdp.calls.find(
        (call) => call.method === "Target.createTarget",
      );
      assert.deepEqual(create?.params, {
        url: "https://example.com/requested",
        browserContextId: "ctx",
      });
    } finally {
      if (previous === undefined)
        delete process.env.EGO_LINUX_TASK_SPACE_STORAGE;
      else process.env.EGO_LINUX_TASK_SPACE_STORAGE = previous;
    }
  });

  it("seeds localStorage before an isolated-sync space loads the site", async () => {
    const previous = process.env.EGO_LINUX_TASK_SPACE_STORAGE;
    process.env.EGO_LINUX_TASK_SPACE_STORAGE = "isolated-sync";
    const cdp = fakeSyncedStorageCdp();
    try {
      const api = createTaskSpacesApi(cdp);
      const space = await api.createTaskSpace("signed-in work");
      assert.equal(space.storageSeed, "localStorage");

      const result = await api.createTabInSelectedSpace(
        tabsApi(cdp),
        "https://example.com/dashboard",
      );
      assert.equal(result.targetId, "synced-target");

      const storageRead = cdp.calls.find(
        (call) => call.method === "DOMStorage.getDOMStorageItems",
      );
      assert.deepEqual(storageRead?.params.storageId, {
        securityOrigin: "https://example.com",
        isLocalStorage: true,
      });

      const created = cdp.calls.find(
        (call) =>
          call.method === "Target.createTarget" &&
          call.params.browserContextId === "ctx",
      );
      assert.equal(created?.params.url, "about:blank");
      assert.equal(created?.params.browserContextId, "ctx");
      const injection = cdp.calls.find(
        (call) => call.method === "Page.addScriptToEvaluateOnNewDocument",
      );
      assert.match(injection?.params.source, /auth-token/);
      assert.match(injection?.params.source, /secret-value/);
      assert.ok(
        cdp.calls.some(
          (call) =>
            call.method === "Page.navigate" &&
            call.params.url === "https://example.com/dashboard",
        ),
        "the destination is loaded only after the storage seed is installed",
      );
    } finally {
      if (previous === undefined)
        delete process.env.EGO_LINUX_TASK_SPACE_STORAGE;
      else process.env.EGO_LINUX_TASK_SPACE_STORAGE = previous;
    }
  });

  it("does not focus a never-used blank anchor when selecting a space", async () => {
    await seed({ ...baseSpace });
    const cdp = fakeCdp("about:blank");

    await createTaskSpacesApi(cdp).useTaskSpace(1);

    assert.ok(
      !cdp.calls.some((call) => call.method === "Target.activateTarget"),
      "selecting a new blank space is enough for CDP scope but should not flash a blank page",
    );
  });

  it("keeps a used space in the background when the overview owns focus", async () => {
    await seed({ ...baseSpace, lastContentAt: Date.now() });
    const cdp = fakeCdp("https://example.com");

    await createTaskSpacesApi(cdp, {
      shouldAutoFocus: async () => false,
    }).useTaskSpace(1);

    assert.ok(
      !cdp.calls.some((call) => call.method === "Target.activateTarget"),
      "selecting agent work must not replace the Spaces overview",
    );
  });

  it("navigates the anchor instead of opening a second tab", async () => {
    await seed({ ...baseSpace });
    const cdp = fakeCdp("about:blank");
    const api = createTaskSpacesApi(cdp);

    const result = await api.createTabInSelectedSpace(
      tabsApi(cdp),
      "https://example.com",
    );

    assert.equal(result.targetId, "anchor", "the anchor is what comes back");
    assert.ok(
      cdp.calls.some(
        (c) =>
          c.method === "Page.navigate" &&
          c.params.url === "https://example.com",
      ),
      "the anchor is navigated",
    );
    assert.ok(
      !cdp.calls.some((c) => c.method === "Target.createTarget"),
      "and no second tab is opened — this is the blank tab people were seeing",
    );
    assert.ok(
      cdp.calls.some((c) => c.method === "Target.detachFromTarget"),
      "the temporary navigation session is always detached",
    );
  });

  it("navigates the first tab in the background while Spaces is open", async () => {
    await seed({ ...baseSpace });
    const cdp = fakeCdp("about:blank");
    const api = createTaskSpacesApi(cdp, {
      shouldAutoFocus: async () => false,
    });

    await api.createTabInSelectedSpace(tabsApi(cdp), "https://example.com");

    assert.ok(
      cdp.calls.some((call) => call.method === "Page.navigate"),
      "the background tab still navigates",
    );
    assert.ok(
      !cdp.calls.some((call) => call.method === "Target.activateTarget"),
      "background navigation does not steal the foreground",
    );
  });

  it("opens a new tab once the space has started work", async () => {
    // A tab is about:blank for a moment during every navigation, so reusing on
    // url alone would hijack a tab already carrying work. lastContentAt is what
    // separates "not started" from "between pages".
    await seed({ ...baseSpace, lastContentAt: Date.now() });
    const cdp = fakeCdp("about:blank");
    const api = createTaskSpacesApi(cdp);

    const result = await api.createTabInSelectedSpace(
      tabsApi(cdp),
      "https://example.com",
    );

    assert.equal(result.targetId, "fresh-tab");
    assert.ok(!cdp.calls.some((c) => c.method === "Page.navigate"));
  });

  it("opens a new tab when the anchor already holds a page", async () => {
    await seed({ ...baseSpace });
    const cdp = fakeCdp("https://already.example");
    const api = createTaskSpacesApi(cdp);

    const result = await api.createTabInSelectedSpace(
      tabsApi(cdp),
      "https://example.com",
    );

    assert.equal(
      result.targetId,
      "fresh-tab",
      "an occupied tab is never taken",
    );
  });
});
