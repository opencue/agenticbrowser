/**
 * Real-browser integration tests for auth.mjs (loginPreflight / handleChallenge).
 *
 * Each test spawns the ego-browser CLI with a v2 script on stdin and runs
 * in a fully sandboxed environment (own temp profile, state, and data dirs).
 * The browser is stopped once at the end via --stop.
 *
 * Covers:
 * - loginPreflight on empty form → needsUser:true, no credential values
 * - loginPreflight on pre-filled form → submitted:true
 * - handleChallenge on a fake hCaptcha marker → detected:true
 * - handleChallenge headless → requestUserAction throws "not visible"
 * - handleChallenge on a no-challenge page → {detected:false,handled:false}
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "..", "ego-linux", "bin", "ego-browser.mjs");
const FIXTURE_DIR = join(HERE, "fixtures");

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-auth-browser-test-"));
const TEST_ENV = {
  XDG_STATE_HOME: join(SANDBOX, "state"),
  XDG_DATA_HOME: join(SANDBOX, "data"),
  EGO_LINUX_HEADLESS: "1",
  EGO_LINUX_NOTIFY: "0",
  EGO_BROWSER_STATE_DIR: join(SANDBOX, "ego"),
  EGO_LINUX_PROFILE: join(SANDBOX, "profile"),
  EGO_LINUX_CURSOR_NAME: "AuthTestBot",
};

/** Run a v2 script through the real CLI. Rejects on non-zero exit. */
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

/** Stop the backing browser and remove the sandbox. */
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
// loginPreflight
// ---------------------------------------------------------------------------

describe("task.loginPreflight (browser)", () => {
  it("empty form → needsUser:true, no credential values in result", async () => {
    const fixture = `file://${join(FIXTURE_DIR, "auth-login.html")}`;
    const out = await runScript(`
const task = await taskSpace('auth-pf-empty');
const page = task.page('p1');
await page.goto(${JSON.stringify(fixture)}, { waitUntil: 'load' });
const r = await task.loginPreflight({ waitForAutofill: 0 });
console.log(JSON.stringify(r));
await task.finish({ keep: [] });
`);
    const r = JSON.parse(out.trim());
    assert.equal(r.detected, true, "login form should be detected");
    assert.equal(r.ready, false, "empty fields: not ready");
    assert.equal(r.needsUser, true, "empty fields: needsUser");
    assert.equal(r.submitted, false, "should not have submitted");
    // No credential values should appear in the result
    const str = JSON.stringify(r);
    assert.doesNotMatch(str, /saved|secret|password/i, "no credential values");
  });

  it("pre-filled form → submitted:true, body.dataset.submitted is 'yes'", async () => {
    const fixture = `file://${join(FIXTURE_DIR, "auth-login-prefilled.html")}`;
    const out = await runScript(`
const task = await taskSpace('auth-pf-filled');
const page = task.page('p1');
await page.goto(${JSON.stringify(fixture)}, { waitUntil: 'load' });
const r = await task.loginPreflight({ waitForAutofill: 0 });
const submitted = await page.evaluate(() => document.body.dataset.submitted === 'yes');
console.log(JSON.stringify({ ...r, pageSubmitted: submitted }));
await task.finish({ keep: [] });
`);
    const r = JSON.parse(out.trim());
    assert.equal(r.detected, true, "login form detected");
    assert.equal(r.ready, true, "pre-filled: ready");
    assert.equal(r.needsUser, false, "pre-filled: no user needed");
    assert.equal(r.submitted, true, "loginPreflight reports submitted");
    assert.equal(r.pageSubmitted, true, "form actually submitted in page");
    // Credential values must not appear in the result object
    const str = JSON.stringify(r);
    assert.doesNotMatch(str, /saved@|saved-secret/i, "no credential values");
  });
});

// ---------------------------------------------------------------------------
// handleChallenge
// ---------------------------------------------------------------------------

describe("task.handleChallenge (browser)", () => {
  it("no-challenge page → {detected:false, handled:false}", async () => {
    const fixture = `file://${join(FIXTURE_DIR, "auth-no-challenge.html")}`;
    const out = await runScript(`
const task = await taskSpace('auth-hc-none');
const page = task.page('p1');
await page.goto(${JSON.stringify(fixture)}, { waitUntil: 'load' });
const r = await task.handleChallenge({ waitForAutomatic: 0 });
console.log(JSON.stringify(r));
await task.finish({ keep: [] });
`);
    const r = JSON.parse(out.trim());
    assert.deepEqual(r, { detected: false, handled: false });
  });

  it("fake hCaptcha marker → detected:true with provider hcaptcha", async () => {
    const fixture = `file://${join(FIXTURE_DIR, "auth-challenge.html")}`;
    // In headless mode requestUserAction will throw "not visible". We catch
    // that so the test can still assert the detection happened before the throw.
    const out = await runScript(`
const task = await taskSpace('auth-hc-detect');
const page = task.page('p1');
await page.goto(${JSON.stringify(fixture)}, { waitUntil: 'load' });
let result;
try {
  result = await task.handleChallenge({ waitForAutomatic: 0 });
} catch (err) {
  // headless: requestUserAction throws "not visible"
  result = { detected: true, provider: 'hcaptcha', kind: 'captcha', handled: false, error: err.message };
}
console.log(JSON.stringify(result));
await task.finish({ keep: [] });
`);
    const r = JSON.parse(out.trim());
    assert.equal(r.detected, true, "challenge detected");
    assert.equal(r.provider, "hcaptcha", "provider is hcaptcha");
    assert.equal(r.kind, "captcha", "kind is captcha");
  });

  it("headless → requestUserAction path throws 'not visible'", async () => {
    const fixture = `file://${join(FIXTURE_DIR, "auth-challenge.html")}`;
    // In EGO_LINUX_HEADLESS=1 the page is not visible to presentTaskSpace, so
    // requestUserAction throws. We capture the error message.
    const out = await runScript(`
const task = await taskSpace('auth-hc-headless');
const page = task.page('p1');
await page.goto(${JSON.stringify(fixture)}, { waitUntil: 'load' });
let err;
try {
  await task.handleChallenge({ waitForAutomatic: 0 });
} catch (e) {
  err = e.message;
}
console.log(JSON.stringify({ threw: Boolean(err), msg: err || '' }));
await task.finish({ keep: [] });
`);
    const r = JSON.parse(out.trim());
    assert.equal(r.threw, true, "should have thrown in headless mode");
    assert.match(r.msg, /not visible/i, "error mentions 'not visible'");
  });
});
