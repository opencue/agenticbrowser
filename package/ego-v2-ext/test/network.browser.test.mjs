/**
 * Real-browser integration tests for network.mjs:
 * page.waitForRequest() and page.waitForResponse().
 *
 * An in-process HTTP server serves the fixture and the /api/* endpoints so
 * real network requests exist for the browser to make. The browser CLI is
 * launched with a fully sandboxed environment (own temp profile/state dirs).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "..", "ego-linux", "bin", "ego-browser.mjs");
const FIXTURE_PATH = join(HERE, "fixtures", "net-fetch.html");

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-net-browser-test-"));
const TEST_ENV = {
  XDG_STATE_HOME: join(SANDBOX, "state"),
  XDG_DATA_HOME: join(SANDBOX, "data"),
  EGO_LINUX_HEADLESS: "1",
  EGO_LINUX_NOTIFY: "0",
  EGO_BROWSER_STATE_DIR: join(SANDBOX, "ego"),
  EGO_LINUX_PROFILE: join(SANDBOX, "profile"),
  EGO_LINUX_CURSOR_NAME: "NetTestBot",
};

// ---------------------------------------------------------------------------
// Local HTTP server
// ---------------------------------------------------------------------------

let server;
let baseUrl;

before(async () => {
  const fixtureHtml = await readFile(FIXTURE_PATH, "utf8");
  server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/fixture.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fixtureHtml);
    } else if (req.url === "/api/data") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end('{"ok":true}');
    } else if (req.url === "/api/submit" && req.method === "POST") {
      res.writeHead(201, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end('{"created":true}');
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Stop the browser instance.
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
  await new Promise((resolve) => server.close(resolve));
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

describe("waitForRequest — URL string — triggered after the call", () => {
  it("resolves with the matching request facade", async () => {
    const fixtureUrl = `${baseUrl}/fixture.html`;
    const apiUrl = `${baseUrl}/api/data`;
    const out = await runScript(`
const task = await taskSpace('net-req-str');
const page = task.page('p1');
await page.goto(${JSON.stringify(fixtureUrl)}, { waitUntil: 'load' });
const reqP = page.waitForRequest(${JSON.stringify(apiUrl)}, { timeout: 10000 });
await page.click('#fetch-btn');
const req = await reqP;
console.log('METHOD:' + req.method());
console.log('URL:' + req.url());
console.log('RESOURCE_TYPE:' + req.resourceType());
await task.finish({ keep: [] });
`);
    assert.match(out, /METHOD:GET/);
    assert.match(out, new RegExp("URL:" + apiUrl.replace(/[.]/g, "\\.")));
  });
});

describe("waitForRequest — predicate — triggered after the call", () => {
  it("resolves when predicate returns true for the fetch URL", async () => {
    const fixtureUrl = `${baseUrl}/fixture.html`;
    const apiUrl = `${baseUrl}/api/data`;
    const out = await runScript(`
const task = await taskSpace('net-req-pred');
const page = task.page('p1');
await page.goto(${JSON.stringify(fixtureUrl)}, { waitUntil: 'load' });
const reqP = page.waitForRequest(
  req => req.url().includes('/api/data'),
  { timeout: 10000 }
);
await page.click('#fetch-btn');
const req = await reqP;
console.log('URL_MATCH:' + req.url().includes('/api/data'));
await task.finish({ keep: [] });
`);
    assert.match(out, /URL_MATCH:true/);
  });
});

describe("waitForResponse — status check", () => {
  it("resolves with status 200 for the /api/data response", async () => {
    const fixtureUrl = `${baseUrl}/fixture.html`;
    const apiUrl = `${baseUrl}/api/data`;
    const out = await runScript(`
const task = await taskSpace('net-resp-status');
const page = task.page('p1');
await page.goto(${JSON.stringify(fixtureUrl)}, { waitUntil: 'load' });
const respP = page.waitForResponse(${JSON.stringify(apiUrl)}, { timeout: 10000 });
await page.click('#fetch-btn');
const resp = await respP;
console.log('STATUS:' + resp.status());
console.log('OK:' + resp.ok());
console.log('URL:' + resp.url());
await task.finish({ keep: [] });
`);
    assert.match(out, /STATUS:200/);
    assert.match(out, /OK:true/);
    assert.match(out, new RegExp("URL:" + apiUrl.replace(/[.]/g, "\\.")));
  });
});

describe("waitForRequest — timeout error", () => {
  it("throws with the expected message when no matching request arrives", async () => {
    const fixtureUrl = `${baseUrl}/fixture.html`;
    // Expect the script to exit non-zero because of the unhandled error —
    // catch it and verify the message text.
    let errorOut = "";
    try {
      await runScript(`
const task = await taskSpace('net-req-timeout');
const page = task.page('p1');
await page.goto(${JSON.stringify(fixtureUrl)}, { waitUntil: 'load' });
await page.waitForRequest('https://no-such-host.example.invalid/nope', { timeout: 400 });
await task.finish({ keep: [] });
`);
    } catch (err) {
      errorOut = err.message;
    }
    assert.match(
      errorOut,
      /waitForRequest timed out after 400ms/,
      "timeout message present in error output",
    );
  });
});
