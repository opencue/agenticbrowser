import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearPreferredTarget,
  drainBrowserEvents,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import { waitForEvent } from "../../dist/src/driver/downloads.js";

function installAutoEgo(options = {}) {
  const calls = [];
  globalThis.ego = {
    async listTabs() {
      return { tabs: [{ targetId: "tab-1", active: true }] };
    },
    sendCDPMessage(payload) {
      const parsed = JSON.parse(payload);
      calls.push(parsed);
      setTimeout(() => {
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

function fireEvent(method, params = {}, sessionId = "sess-1") {
  globalThis.ego.onCDPMessage(JSON.stringify({ method, params, sessionId }));
}

function cleanup() {
  delete globalThis.ego;
  invalidateSession();
  clearPreferredTarget();
  drainBrowserEvents();
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

test("saveAs cleans up the temp dir even when copyFile throws (nonexistent target parent)", async () => {
  installAutoEgo();
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.downloadWillBegin", {
      guid: "download-sa-err-1",
      url: "https://example.com/data.bin",
      suggestedFilename: "data.bin",
    });
    fireEvent("Page.downloadProgress", {
      guid: "download-sa-err-1",
      state: "completed",
    });
    const download = await promise;
    const downloadedPath = await download.path();
    const tmpDir = dirname(downloadedPath);
    // Seed a real file so the download path exists.
    writeFileSync(downloadedPath, "dummy");
    // Target inside a directory that does not exist — copyFile will throw ENOENT.
    const badTarget = join(
      tmpdir(),
      `ego-nonexistent-${Date.now()}`,
      "out.bin",
    );
    await assert.rejects(
      () => download.saveAs(badTarget),
      /ENOENT/,
      "saveAs must reject when the target parent dir is missing",
    );
    assert.ok(
      !existsSync(tmpDir),
      "temp dir must be removed even after a failed copy",
    );
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
