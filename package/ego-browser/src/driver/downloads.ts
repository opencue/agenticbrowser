import { mkdirSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cdp } from "../cdp-eval.js";
import { ensureSession, subscribeBrowserEvent } from "../browser-runtime.js";
import { state } from "../state.js";

type WaitForEventOptions = {
  timeout?: number;
};

type DownloadWillBegin = {
  method: "Page.downloadWillBegin";
  params?: {
    guid?: string;
    url?: string;
    suggestedFilename?: string;
  };
};

type DownloadProgress = {
  method: "Page.downloadProgress";
  params?: {
    guid?: string;
    state?: string;
  };
};

/**
 * Wait for a Playwright-style page event. Currently supports "download".
 * @param {"download"} eventName Event name.
 * @param {{timeout?: number}} [options] Timeout in milliseconds.
 * @returns {Promise<object>} Download facade with suggestedFilename(), path(), saveAs(path), url().
 */
export async function waitForEvent(
  eventName,
  options: WaitForEventOptions = {},
) {
  if (eventName !== "download") {
    throw new Error(
      `page.waitForEvent currently supports only "download", got ${JSON.stringify(eventName)}`,
    );
  }
  return waitForDownload(options);
}

async function waitForDownload(options: WaitForEventOptions = {}) {
  const timeout = options.timeout ?? state.defaultTimeout;
  const downloadDir = join(
    tmpdir(),
    `ego-browser-downloads-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(downloadDir, { recursive: true });
  const events = waitForDownloadEvents(timeout);
  try {
    const [, , { willBegin, progress }] = await Promise.all([
      ensureSession(),
      setDownloadBehavior(downloadDir),
      events.promise,
    ]);
    const guid = willBegin.params?.guid;
    const suggestedFilename =
      willBegin.params?.suggestedFilename || guid || "download";
    if (progress.params?.state === "canceled") {
      throw new Error(`Download canceled: ${suggestedFilename}`);
    }
    const downloadedPath = join(downloadDir, suggestedFilename);
    return {
      suggestedFilename: () => suggestedFilename,
      url: () => willBegin.params?.url || "",
      path: async () => downloadedPath,
      saveAs: async (targetPath) => {
        await copyFile(downloadedPath, targetPath);
        return targetPath;
      },
    };
  } finally {
    events.dispose();
  }
}

function waitForDownloadEvents(timeout: number) {
  let willBegin: DownloadWillBegin | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subscriptions: (() => unknown)[] = [];
  const dispose = () => {
    clearTimeout(timer);
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  };
  const promise = new Promise<{
    willBegin: DownloadWillBegin;
    progress: DownloadProgress;
  }>((resolve, reject) => {
    subscriptions.push(
      subscribeBrowserEvent("Page.downloadWillBegin", undefined, (event) => {
        // Select the GUID in the event callback: a completion can arrive in
        // the same turn, before an awaiting caller has resumed.
        if (!willBegin) willBegin = event;
      }),
      subscribeBrowserEvent("Page.downloadProgress", undefined, (event) => {
        if (!willBegin || event.params?.guid !== willBegin.params?.guid) return;
        if (
          event.params?.state !== "completed" &&
          event.params?.state !== "canceled"
        )
          return;
        dispose();
        resolve({ willBegin, progress: event });
      }),
    );
    timer = setTimeout(() => {
      dispose();
      reject(new Error("page.waitForEvent timed out"));
    }, timeout);
  });
  return { promise, dispose };
}

async function setDownloadBehavior(downloadDir) {
  try {
    await cdp("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
  } catch (error) {
    if (
      !/Browser\.setDownloadBehavior.*wasn't found|wasn't found/i.test(
        error?.message || "",
      )
    ) {
      throw error;
    }
    await cdp("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
    });
  }
}
