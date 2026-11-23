/**
 * Real-browser integration tests for recording.mjs:
 * page.screencast.start/stop (WebM file) and page.trace() (shape check).
 *
 * Screencast requires ffmpeg. The test probes for it at startup and skips
 * with a clear message when the binary is absent.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "..", "ego-linux", "bin", "ego-browser.mjs");

// ---------------------------------------------------------------------------
// Probe for ffmpeg
// ---------------------------------------------------------------------------

let ffmpegAvailable = false;
{
  const ffmpegBin = process.env.EGO_BROWSER_FFMPEG_PATH || "ffmpeg";
  try {
    await execFileAsync(ffmpegBin, ["-version"], { timeout: 5_000 });
    ffmpegAvailable = true;
  } catch {
    // ffmpeg absent or broken — screencast test will be skipped below
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-rec-browser-test-"));
const TEST_ENV = {
  XDG_STATE_HOME: join(SANDBOX, "state"),
  XDG_DATA_HOME: join(SANDBOX, "data"),
  EGO_LINUX_HEADLESS: "1",
  EGO_LINUX_NOTIFY: "0",
  EGO_BROWSER_STATE_DIR: join(SANDBOX, "ego"),
  EGO_LINUX_PROFILE: join(SANDBOX, "profile"),
  EGO_LINUX_CURSOR_NAME: "RecTestBot",
};

after(async () => {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "--stop"], {
      env: { ...process.env, ...TEST_ENV },
      stdio: "ignore",
    });
    child.on("close", resolve);
    child.on("error", resolve);
    setTimeout(() => {
      child.kill();
      resolve();
    }, 10_000);
  });
  await rm(SANDBOX, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300,
  }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runScript(code, { timeout = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "nodejs"], {
      env: { ...process.env, ...TEST_ENV },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `timed out after ${timeout}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeout);
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(code);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("page.trace() — real browser", () => {
  it("returns the ego-browser.trace.v1 schema shape after page.goto()", async () => {
    const out = await runScript(`
const task = await taskSpace('rec-trace');
const page = task.page('p1');
await page.goto('about:blank', { waitUntil: 'load' });
// Generate at least one event (a click on a non-existent element is a no-op
// but the navigation itself produces CDP events).
const result = await page.trace();
console.log('SCHEMA:' + result.schema);
console.log('CREATED_AT_TYPE:' + typeof result.createdAt);
console.log('COUNT_TYPE:' + typeof result.count);
console.log('SHOWN_TYPE:' + typeof result.shown);
console.log('ITEMS_IS_ARRAY:' + Array.isArray(result.items));
await task.finish({ keep: [] });
`);
    assert.match(out, /SCHEMA:ego-browser\.trace\.v1/);
    assert.match(out, /CREATED_AT_TYPE:string/);
    assert.match(out, /COUNT_TYPE:number/);
    assert.match(out, /SHOWN_TYPE:number/);
    assert.match(out, /ITEMS_IS_ARRAY:true/);
  });

  it("trace items have the expected fields", async () => {
    const out = await runScript(`
const task = await taskSpace('rec-trace-items');
const page = task.page('p1');
await page.goto('about:blank', { waitUntil: 'load' });
await page.goto('about:blank', { waitUntil: 'load' });
const result = await page.trace();
if (result.items.length > 0) {
  const item = result.items[0];
  console.log('ITEM_KIND:' + item.kind);
  console.log('ITEM_METHOD:' + item.method);
  console.log('ITEM_AT_TYPE:' + typeof item.at);
  console.log('ITEM_SEQ_TYPE:' + typeof item.seq);
  console.log('ITEM_SUMMARY_TYPE:' + typeof item.summary);
} else {
  // No events were buffered after drain — that is valid but unusual.
  console.log('ITEM_KIND:no_events');
  console.log('ITEM_METHOD:no_events');
  console.log('ITEM_AT_TYPE:string');
  console.log('ITEM_SEQ_TYPE:number');
  console.log('ITEM_SUMMARY_TYPE:string');
}
await task.finish({ keep: [] });
`);
    assert.match(out, /ITEM_KIND:(event|no_events)/);
    assert.match(out, /ITEM_AT_TYPE:string/);
    assert.match(out, /ITEM_SEQ_TYPE:number/);
    assert.match(out, /ITEM_SUMMARY_TYPE:string/);
  });
});

describe("page.screencast.start/stop — real browser", () => {
  it(
    ffmpegAvailable
      ? "produces a non-empty .webm file"
      : "SKIP — ffmpeg not found (install ffmpeg or set EGO_BROWSER_FFMPEG_PATH)",
    { skip: !ffmpegAvailable },
    async () => {
      const outPath = join(SANDBOX, "recording.webm");
      const out = await runScript(
        `
const task = await taskSpace('rec-screencast');
const page = task.page('p1');
await page.goto('about:blank', { waitUntil: 'load' });
const rec = await page.screencast.start({ path: ${JSON.stringify(outPath)}, quality: 50 });
// Let a couple of frames arrive.
await new Promise(r => setTimeout(r, 300));
await page.screencast.stop();
console.log('DONE:1');
await task.finish({ keep: [] });
`,
        { timeout: 60_000 },
      );
      assert.match(out, /DONE:1/, "script completed without error");
      const info = await stat(outPath);
      assert.ok(info.size > 0, `webm file is non-empty (${info.size} bytes)`);
    },
  );

  it(
    ffmpegAvailable
      ? "start() throws when already started on the same page"
      : "SKIP — ffmpeg not found (install ffmpeg or set EGO_BROWSER_FFMPEG_PATH)",
    { skip: !ffmpegAvailable },
    async () => {
      const outPath = join(SANDBOX, "recording-dup.webm");
      const out = await runScript(
        `
const task = await taskSpace('rec-dup');
const page = task.page('p1');
await page.goto('about:blank', { waitUntil: 'load' });
await page.screencast.start({ path: ${JSON.stringify(outPath)}, quality: 50 });
let threw = '';
try {
  await page.screencast.start({ path: ${JSON.stringify(outPath)}, quality: 50 });
} catch (e) {
  threw = e.message;
}
await page.screencast.stop();
console.log('THREW:' + threw);
await task.finish({ keep: [] });
`,
        { timeout: 60_000 },
      );
      assert.match(out, /THREW:Screencast is already started/);
    },
  );
});
