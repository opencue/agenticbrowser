/**
 * Real-browser integration tests for page.fastObserve() / page.fastAct().
 *
 * Each test spawns the ego-browser CLI with a v2 script on stdin and runs
 * in a fully sandboxed environment (own temp profile, state, and data dirs).
 * The browser is stopped once at the end via --stop.
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
const FIXTURE = `file://${join(HERE, "fixtures", "fast.html")}`;

// Own sandbox so this suite does not share state with any real agent session.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-fast-browser-test-"));
const TEST_ENV = {
  XDG_STATE_HOME: join(SANDBOX, "state"),
  XDG_DATA_HOME: join(SANDBOX, "data"),
  EGO_LINUX_HEADLESS: "1",
  EGO_LINUX_NOTIFY: "0",
  EGO_BROWSER_STATE_DIR: join(SANDBOX, "ego"),
  EGO_LINUX_PROFILE: join(SANDBOX, "profile"),
  // Suppress any existing cursor-name so assertions do not encode who ran it.
  EGO_LINUX_CURSOR_NAME: "FastTestBot",
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
  // Best-effort stop; if it was never started, --stop just says so and exits 0.
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
// Tests
// ---------------------------------------------------------------------------

describe("fastObserve — real browser", () => {
  it("lists search/button/select/checkbox with ids, skips password/file/hidden", async () => {
    const out = await runScript(`
const task = await taskSpace('obs-kinds');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const obs = await page.fastObserve();
console.log('TABLE:' + obs.table);
console.log('URL:' + obs.url);
console.log('TITLE:' + obs.title);
await task.finish({keep:[]});
`);
    // searchbox present
    assert.match(
      out,
      /searchbox|fill searchbox|fill.*Search/i,
      "search input listed",
    );
    // button present
    assert.match(out, /button.*Go|Go.*button/i, "Go button listed");
    // select/combobox present
    assert.match(out, /combobox|select.*Color/i, "color select listed");
    // checkbox present
    assert.match(out, /checkbox.*Accept|Accept.*checkbox/i, "checkbox listed");
    // password / file / hidden must not appear
    assert.doesNotMatch(
      out,
      /password|type.*file/i,
      "password/file not listed",
    );
    // the page URL and title should be present
    assert.match(out, /fast-loop fixture/, "title is correct");
  });

  it("actions have ids like e1, e2, …", async () => {
    const out = await runScript(`
const task = await taskSpace('obs-ids');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const obs = await page.fastObserve();
const ids = obs.actions.map(a => a.id);
console.log('IDS:' + JSON.stringify(ids));
await task.finish({keep:[]});
`);
    const match = out.match(/IDS:(\[.*?\])/);
    assert.ok(match, "IDS line found");
    const ids = JSON.parse(match[1]);
    assert.ok(
      ids.some((id) => /^e\d+$/.test(id)),
      `at least one e-numbered id in ${JSON.stringify(ids)}`,
    );
    assert.ok(ids.includes("wait"), "wait sentinel present");
  });
});

describe("fastAct — real browser", () => {
  it("fill via fastAct — value is visible in a re-observe", async () => {
    const out = await runScript(`
const task = await taskSpace('act-fill');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
let obs = await page.fastObserve();
// Find the fill action for the search box
const fillAction = obs.actions.find(a => a.kind === 'fill' && /search/i.test(a.label));
if (!fillAction) throw new Error('fill action for Search not found in: ' + obs.table);
await page.fastAct(obs, fillAction.id, 'Zurich');
// Re-observe and check the value is visible
obs = await page.fastObserve();
const refill = obs.actions.find(a => a.id === fillAction.id);
console.log('REFILL_VALUE:' + (refill ? refill.value : 'NOT_FOUND'));
await task.finish({keep:[]});
`);
    assert.match(
      out,
      /REFILL_VALUE:Zurich/,
      "typed value visible in re-observe",
    );
  });

  it("click button changes page text", async () => {
    const out = await runScript(`
const task = await taskSpace('act-click');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
let obs = await page.fastObserve();
const btn = obs.actions.find(a => a.kind === 'click' && /^Go$/i.test(a.label));
if (!btn) throw new Error('Go button not found in: ' + obs.table);
await page.fastAct(obs, btn.id);
// Wait for DOM update then read text
await new Promise(r => setTimeout(r, 200));
const text = await page.evaluate("document.getElementById('output').textContent");
console.log('OUTPUT:' + text);
await task.finish({keep:[]});
`);
    assert.match(out, /OUTPUT:clicked/, "button click updated the DOM");
  });

  it("select option via fastAct", async () => {
    const out = await runScript(`
const task = await taskSpace('act-select');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
let obs = await page.fastObserve();
// Find a select action for 'Blue'
const sel = obs.actions.find(a => a.kind === 'select' && a.value === 'blue');
if (!sel) throw new Error('blue select action not found in: ' + obs.table);
await page.fastAct(obs, sel.id);
const val = await page.evaluate("document.getElementById('color').value");
console.log('COLOR:' + val);
await task.finish({keep:[]});
`);
    assert.match(out, /COLOR:blue/, "select option applied");
  });

  it("scroll_down action is listed and executes on a tall page", async () => {
    // Navigate with ?tall=1 so the page loads already tall — no DOM mutation
    // needed after load, which avoids a Chrome layout-event misdetected as a
    // navigation that would stall Input.dispatchMouseEvent.
    const tallFixture = FIXTURE.includes("?")
      ? FIXTURE + "&tall=1"
      : FIXTURE + "?tall=1";
    const out = await runScript(`
const task = await taskSpace('act-scroll');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE + "?tall=1")}, {waitUntil:'load'});
let obs = await page.fastObserve();
const hasScrollDown = obs.actions.some(a => a.id === 'scroll_down');
console.log('HAS_SCROLL_DOWN:' + hasScrollDown);
if (hasScrollDown) {
  await page.fastAct(obs, 'scroll_down');
  console.log('SCROLL_OK:true');
}
await task.finish({keep:[]});
`);
    assert.match(
      out,
      /HAS_SCROLL_DOWN:true/,
      "scroll_down listed on tall page",
    );
    assert.match(out, /SCROLL_OK:true/, "scroll_down executed without error");
  });

  it("StalePageError is thrown when the page changes between observe and act", async () => {
    const out = await runScript(`
const task = await taskSpace('act-stale');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
let obs = await page.fastObserve();
const btn = obs.actions.find(a => a.kind === 'click' && /^Go$/i.test(a.label));
if (!btn) throw new Error('Go button not found in: ' + obs.table);
// Mutate the DOM so the guard/marker changes, then try to act on the stale obs
await page.evaluate("document.getElementById('go-btn').remove()");
let threw = '';
try {
  await page.fastAct(obs, btn.id);
} catch (e) {
  threw = e.name;
}
console.log('THREW:' + threw);
await task.finish({keep:[]});
`);
    assert.match(
      out,
      /THREW:StalePageError/,
      "StalePageError thrown on stale observation",
    );
  });

  it("password, file, and hidden inputs are not listed", async () => {
    const out = await runScript(`
const task = await taskSpace('act-hidden');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const obs = await page.fastObserve();
const kinds = obs.actions.map(a => JSON.stringify({id:a.id, kind:a.kind, label:a.label}));
console.log('ACTIONS:' + JSON.stringify(obs.actions.map(a => a.label)));
await task.finish({keep:[]});
`);
    // "secret", "upload", or the hidden csrf value must not appear
    assert.doesNotMatch(
      out,
      /secret|csrf|upload/i,
      "sensitive inputs not listed",
    );
  });
});
