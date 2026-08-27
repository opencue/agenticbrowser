import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-storage-sync-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_PROFILE = join(SANDBOX, "profile");

const { createEgoShim } = await import("../src/shim.mjs");
const { stopBrowser } = await import("../src/chrome.mjs");

function serveFixture() {
  const server = createServer((_request, response) => {
    const html = `<!doctype html><script>
      window.initialAuth = localStorage.getItem("auth-token");
    </script><title>storage seed</title>`;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
    });
    response.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/`,
      });
    });
  });
}

async function evaluate(cdp, targetId, expression) {
  const { sessionId } = await cdp.call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  cdp.claimSession(sessionId);
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const result = await cdp.call(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          sessionId,
          { timeoutMs: 1000 },
        );
        if (result.result?.value !== undefined) return result.result.value;
      } catch {
        // The document may still be swapping execution contexts.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`evaluation did not settle: ${expression}`);
  } finally {
    await cdp.call("Target.detachFromTarget", { sessionId }).catch(() => {});
    cdp.releaseSession(sessionId);
  }
}

test("isolated-sync exposes the localStorage seed to the site's first script", async () => {
  const fixture = await serveFixture();
  const shim = await createEgoShim({ headless: true });
  const storageReads = [];
  const injections = [];
  const observedCalls = [];
  const originalCall = shim.cdp.call.bind(shim.cdp);
  shim.cdp.call = async (...args) => {
    observedCalls.push(args[0]);
    const result = await originalCall(...args);
    if (args[0] === "DOMStorage.getDOMStorageItems") {
      storageReads.push(result);
    }
    if (args[0] === "Page.addScriptToEvaluateOnNewDocument") {
      injections.push({ params: args[1], result });
    }
    return result;
  };
  const previous = process.env.EGO_LINUX_TASK_SPACE_STORAGE;
  try {
    delete process.env.EGO_LINUX_TASK_SPACE_STORAGE;
    const shared = await shim.ego.createTaskSpace("storage source");
    const sourceTab = await shim.ego.createTab(fixture.url);
    await evaluate(
      shim.cdp,
      sourceTab.targetId,
      `localStorage.setItem("auth-token", "copied-login"); "ready"`,
    );
    await shim.ego.closeTaskSpace(shared.id);

    process.env.EGO_LINUX_TASK_SPACE_STORAGE = "isolated-sync";
    const isolated = await shim.ego.createTaskSpace("storage destination");
    assert.equal(isolated.storageSeed, "localStorage");
    assert.ok(isolated.browserContextId);
    const isolatedTab = await shim.ego.createTab(fixture.url);
    const observed = await evaluate(
      shim.cdp,
      isolatedTab.targetId,
      `document.title === "storage seed" ? ({
        initial: window.initialAuth ?? null,
        current: localStorage.getItem("auth-token"),
      }) : undefined`,
    );

    assert.deepEqual(
      storageReads.at(-1)?.entries,
      [["auth-token", "copied-login"]],
      observedCalls.join(", "),
    );
    assert.ok(injections.at(-1)?.result?.identifier);
    assert.match(injections.at(-1)?.params?.source, /copied-login/);
    assert.deepEqual(observed, {
      initial: "copied-login",
      current: "copied-login",
    });
    await shim.ego.closeTaskSpace(isolated.id);
  } finally {
    if (previous === undefined) delete process.env.EGO_LINUX_TASK_SPACE_STORAGE;
    else process.env.EGO_LINUX_TASK_SPACE_STORAGE = previous;
    shim.close();
    fixture.server.close();
    await stopBrowser().catch(() => {});
    await rm(SANDBOX, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => {});
  }
});
