import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearPreferredTarget,
  drainBrowserEvents,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import { waitForEvent } from "../../dist/src/driver/downloads.js";

const downloadDirs = new Set();

function installAutoEgo(options = {}) {
  const calls = [];
  calls.unanswered = 0;
  globalThis.ego = {
    async listTabs() {
      return { tabs: [{ targetId: "tab-1", active: true }] };
    },
    sendCDPMessage(payload) {
      const parsed = JSON.parse(payload);
      calls.push(parsed);
      calls.unanswered += 1;
      if (parsed.params.downloadPath)
        downloadDirs.add(parsed.params.downloadPath);
      setTimeout(() => {
        calls.unanswered -= 1;
        if (
          options.browserSetDownloadBehaviorError &&
          parsed.method === "Browser.setDownloadBehavior"
        ) {
          globalThis.ego?.onCDPMessage?.(
            JSON.stringify({
              id: parsed.id,
              error: { message: "'Browser.setDownloadBehavior' wasn't found" },
            }),
          );
          return;
        }
        const result =
          parsed.method === "Target.attachToTarget"
            ? { sessionId: `sess-${parsed.id}` }
            : {};
        globalThis.ego?.onCDPMessage?.(
          JSON.stringify({ id: parsed.id, result }),
        );
      }, 0);
    },
  };
  return calls;
}

// Resolves once the wait has sent setDownloadBehavior and every CDP request
// has its reply, that is, once ensureSession() and the download setup are done.
async function setupSettled(calls) {
  while (
    calls.unanswered > 0 ||
    !calls.some((call) => call.method === "Browser.setDownloadBehavior")
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function fireEvent(method, params = {}, sessionId = "sess-1") {
  globalThis.ego.onCDPMessage(JSON.stringify({ method, params, sessionId }));
}

function cleanup() {
  delete globalThis.ego;
  invalidateSession();
  clearPreferredTarget();
  drainBrowserEvents();
  for (const path of downloadDirs)
    rmSync(path, { recursive: true, force: true });
  downloadDirs.clear();
}

test("waitForEvent('download') returns a Playwright-style download facade", async () => {
  const calls = installAutoEgo();
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.downloadWillBegin", {
      guid: "download-1",
      url: "https://example.com/file.png",
      suggestedFilename: "file.png",
    });
    fireEvent("Page.downloadProgress", {
      guid: "download-1",
      state: "completed",
    });
    const download = await promise;
    assert.equal(download.suggestedFilename(), "file.png");
    assert.equal(download.url(), "https://example.com/file.png");
    assert.match(await download.path(), /file\.png$/);
    assert.ok(
      calls.some((call) => call.method === "Browser.setDownloadBehavior"),
      "enables browser download behavior",
    );
  } finally {
    cleanup();
  }
});

test("waitForEvent('download') rejects when the download is canceled", async () => {
  installAutoEgo();
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.downloadWillBegin", {
      guid: "download-1",
      suggestedFilename: "file.png",
    });
    fireEvent("Page.downloadProgress", {
      guid: "download-1",
      state: "canceled",
    });
    await assert.rejects(promise, /Download canceled: file\.png/);
  } finally {
    cleanup();
  }
});

test("waitForEvent('download') falls back to Page.setDownloadBehavior", async () => {
  const calls = installAutoEgo({ browserSetDownloadBehaviorError: true });
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.downloadWillBegin", {
      guid: "download-1",
      suggestedFilename: "file.png",
    });
    fireEvent("Page.downloadProgress", {
      guid: "download-1",
      state: "completed",
    });
    await promise;
    assert.ok(
      calls.some((call) => call.method === "Page.setDownloadBehavior"),
      "uses page-level download behavior when browser-level command is missing",
    );
  } finally {
    cleanup();
  }
});

test("delete() removes the temp download dir", async () => {
  installAutoEgo();
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.downloadWillBegin", {
      guid: "download-del-1",
      url: "https://example.com/report.pdf",
      suggestedFilename: "report.pdf",
    });
    fireEvent("Page.downloadProgress", {
      guid: "download-del-1",
      state: "completed",
    });
    const download = await promise;
    const downloadedPath = await download.path();
    const tmpDir = dirname(downloadedPath);
    assert.ok(existsSync(tmpDir), "temp dir exists before delete");
    await download.delete();
    assert.ok(!existsSync(tmpDir), "temp dir removed after delete()");
  } finally {
    cleanup();
  }
});

test("saveAs deletes the temp download dir after a successful copy", async () => {
  installAutoEgo();
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.downloadWillBegin", {
      guid: "download-sa-1",
      url: "https://example.com/image.png",
      suggestedFilename: "image.png",
    });
    fireEvent("Page.downloadProgress", {
      guid: "download-sa-1",
      state: "completed",
    });
    const download = await promise;
    const downloadedPath = await download.path();
    const tmpDir = dirname(downloadedPath);
    // Seed a real file so copyFile succeeds
    writeFileSync(downloadedPath, "dummy");
    const targetPath = join(tmpdir(), `ego-saveas-test-${Date.now()}.png`);
    try {
      await download.saveAs(targetPath);
      assert.ok(!existsSync(tmpDir), "temp dir removed after saveAs");
    } finally {
      try {
        unlinkSync(targetPath);
      } catch {}
    }
  } finally {
    cleanup();
  }
});

test("waitForEvent('download') ignores unrelated completion before and after its begin event", async () => {
  const calls = installAutoEgo();
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Only the events below may hold the wait open once setup is done.
    await setupSettled(calls);
    fireEvent("Page.downloadProgress", {
      guid: "unrelated-before",
      state: "completed",
    });
    fireEvent("Page.downloadWillBegin", {
      guid: "download-1",
      suggestedFilename: "file.png",
    });
    fireEvent("Page.downloadProgress", {
      guid: "unrelated-after",
      state: "canceled",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      settled,
      false,
      "only the selected download may finish the wait",
    );
    fireEvent("Page.downloadProgress", {
      guid: "download-1",
      state: "completed",
    });
    const download = await promise;
    assert.equal(download.suggestedFilename(), "file.png");
  } finally {
    cleanup();
  }
});

function runDownloadFailureChild(setup, timeout) {
  const moduleUrl = new URL(
    "../../dist/src/driver/downloads.js",
    import.meta.url,
  ).href;
  const script = `
    import assert from "node:assert/strict";
    import { rmSync } from "node:fs";
    import { waitForEvent } from ${JSON.stringify(moduleUrl)};
    const setup = ${JSON.stringify(setup)};
    const directories = new Set();
    globalThis.ego = {
      async listTabs() {
        if (setup === "session") throw new Error("session setup failed");
        return { tabs: [{ targetId: "tab-1", active: true }] };
      },
      sendCDPMessage(payload) {
        const request = JSON.parse(payload);
        if (request.params.downloadPath) directories.add(request.params.downloadPath);
        queueMicrotask(() => {
          const response = setup === "behavior" && request.method === "Browser.setDownloadBehavior"
            ? { error: { message: "download setup failed" } }
            : { result: request.method === "Target.attachToTarget" ? { sessionId: "session-1" } : {} };
          globalThis.ego.onCDPMessage(JSON.stringify({ id: request.id, ...response }));
        });
      },
    };
    await assert.rejects(waitForEvent("download", { timeout: ${timeout} }), /${setup ? "setup failed" : "timed out"}/);
    for (const path of directories) rmSync(path, { recursive: true, force: true });
    ${setup ? "" : "await new Promise((resolve) => setTimeout(resolve, 30));"}
  `;
  // Shorter than the 30 s wait the setup cases use: a wait left behind keeps
  // the child alive past this limit.
  return spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10000 },
  );
}

test("waitForEvent('download') timeout has no orphan rejection after the caller catches it", () => {
  const result = runDownloadFailureChild(null, 20);
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

test("waitForEvent('download') releases its event wait when setup fails", () => {
  for (const setup of ["session", "behavior"]) {
    const result = runDownloadFailureChild(setup, 30000);
    assert.equal(
      result.status,
      0,
      `${setup}: ${result.stderr || result.error}`,
    );
  }
});
