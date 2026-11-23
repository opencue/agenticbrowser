/**
 * Real-browser integration tests for locator.mjs.
 *
 * Each test spawns the ego-browser CLI with a v2 script on stdin and runs
 * in a fully sandboxed environment. The browser is stopped once at the end.
 *
 * Covers: getByRole click, getByText exact/substring, getByLabel fill +
 * inputValue, getByTestId, locator(css).nth, chained locator + filter,
 * count(), strictness error with candidates, waitFor visible (delayed),
 * check/isChecked, selectOption, getAttribute, evaluateAll.
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
const FIXTURE = `file://${join(HERE, "fixtures", "locator.html")}`;

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-loc-browser-test-"));
const TEST_ENV = {
  XDG_STATE_HOME: join(SANDBOX, "state"),
  XDG_DATA_HOME: join(SANDBOX, "data"),
  EGO_LINUX_HEADLESS: "1",
  EGO_LINUX_NOTIFY: "0",
  EGO_BROWSER_STATE_DIR: join(SANDBOX, "ego"),
  EGO_LINUX_PROFILE: join(SANDBOX, "profile"),
  EGO_LINUX_CURSOR_NAME: "LocTestBot",
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

describe("getByRole — click and read", () => {
  it("clicks a button by role and name, DOM updates", async () => {
    const out = await runScript(`
const task = await taskSpace('role-click');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
await page.getByRole('button', {name: 'Submit'}).click();
const text = await page.evaluate("document.getElementById('output').textContent");
console.log('OUTPUT:' + text);
await task.finish({keep:[]});
`);
    assert.match(out, /OUTPUT:submitted/);
  });

  it("getByRole without name returns multiple — count works", async () => {
    const out = await runScript(`
const task = await taskSpace('role-count');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const n = await page.getByRole('button').count();
console.log('COUNT:' + n);
await task.finish({keep:[]});
`);
    assert.match(out, /COUNT:[3-9]|COUNT:[1-9]\d/); // at least 3 buttons
  });
});

describe("getByText — exact and substring", () => {
  it("exact match fills input and reads value", async () => {
    const out = await runScript(`
const task = await taskSpace('text-exact');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
// Exact text: 'Submit' button exists
const n = await page.getByText('Submit', {exact: true}).count();
console.log('EXACT:' + n);
// Substring 'ancel' (case-insensitive) matches 'Cancel'
const n2 = await page.getByText('ancel').count();
console.log('SUBSTR:' + n2);
await task.finish({keep:[]});
`);
    assert.match(out, /EXACT:[1-9]/);
    assert.match(out, /SUBSTR:[1-9]/);
  });
});

describe("getByLabel — fill + inputValue", () => {
  it("fills via label text, reads inputValue back", async () => {
    const out = await runScript(`
const task = await taskSpace('label-fill');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
await page.getByLabel('Email').fill('user@example.com');
const val = await page.getByLabel('Email').inputValue();
console.log('VAL:' + val);
await task.finish({keep:[]});
`);
    assert.match(out, /VAL:user@example\.com/);
  });
});

describe("getByTestId", () => {
  it("locates element by data-testid and clicks it", async () => {
    const out = await runScript(`
const task = await taskSpace('testid');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
await page.getByTestId('submit-btn').click();
const text = await page.evaluate("document.getElementById('output').textContent");
console.log('OUTPUT:' + text);
await task.finish({keep:[]});
`);
    assert.match(out, /OUTPUT:submitted/);
  });
});

describe("locator(css).nth()", () => {
  it("nth(1) selects the second list item", async () => {
    const out = await runScript(`
const task = await taskSpace('nth');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const text = await page.locator('#items .item').nth(1).textContent();
console.log('ITEM:' + text.trim());
await task.finish({keep:[]});
`);
    assert.match(out, /ITEM:Banana/);
  });

  it("last() selects the last item", async () => {
    const out = await runScript(`
const task = await taskSpace('last');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const text = await page.locator('#items .item').last().textContent();
console.log('LAST:' + text.trim());
await task.finish({keep:[]});
`);
    assert.match(out, /LAST:Cherry/);
  });
});

describe("chained locator + filter({hasText})", () => {
  it("locator scoped to parent, filter by hasText", async () => {
    const out = await runScript(`
const task = await taskSpace('filter');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
// All .card divs that contain text 'Open' — should be 1 (not 'Closed')
const cards = page.locator('.card').filter({hasText: 'Open'});
const n = await cards.count();
console.log('COUNT:' + n);
// Get text of the status span inside the open card
const text = await cards.locator('.status').textContent();
console.log('STATUS:' + text.trim());
await task.finish({keep:[]});
`);
    assert.match(out, /COUNT:1/);
    assert.match(out, /STATUS:Open/);
  });
});

describe("count()", () => {
  it("returns 0 for a missing selector without throwing", async () => {
    const out = await runScript(`
const task = await taskSpace('count-zero');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const n = await page.locator('.nonexistent-xyz').count();
console.log('COUNT:' + n);
await task.finish({keep:[]});
`);
    assert.match(out, /COUNT:0/);
  });

  it("returns exact count for multiple matches", async () => {
    const out = await runScript(`
const task = await taskSpace('count-many');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const n = await page.locator('#fruits .fruit').count();
console.log('COUNT:' + n);
await task.finish({keep:[]});
`);
    assert.match(out, /COUNT:3/);
  });
});

describe("strictness error with candidates", () => {
  it("throws LocatorError listing candidates when >1 match", async () => {
    const out = await runScript(`
const task = await taskSpace('strict-err');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
let threw = '';
try {
  // Multiple .card-btn elements — strict action must fail
  await page.locator('.card-btn').click();
} catch (e) {
  threw = e.message || String(e);
}
console.log('THREW:' + (threw ? 'yes' : 'no'));
console.log('MSG:' + threw.slice(0, 200));
await task.finish({keep:[]});
`).catch((e) => e.message || String(e));
    // Either the script output or the error message should mention multiple elements
    assert.ok(
      /THREW:yes|2 elements|multiple|strictness|LocatorError/i.test(out),
      `Expected strictness error, got: ${out.slice(0, 300)}`,
    );
  });
});

describe("waitFor visible — delayed element", () => {
  it("resolves once a delayed element becomes visible", async () => {
    const out = await runScript(`
const task = await taskSpace('waitfor');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
// #delayed-msg appears after 500ms
await page.locator('#delayed-msg').waitFor({state: 'visible', timeout: 5000});
const text = await page.locator('#delayed-msg').textContent();
console.log('MSG:' + text.trim());
await task.finish({keep:[]});
`);
    assert.match(out, /MSG:I appeared!/);
  });
});

describe("check / isChecked", () => {
  it("check() checks the checkbox, isChecked() returns true", async () => {
    const out = await runScript(`
const task = await taskSpace('check');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const loc = page.locator('#agree');
const before = await loc.isChecked();
await loc.check();
const after = await loc.isChecked();
console.log('BEFORE:' + before);
console.log('AFTER:' + after);
await task.finish({keep:[]});
`);
    assert.match(out, /BEFORE:false/);
    assert.match(out, /AFTER:true/);
  });

  it("uncheck() unchecks a checked checkbox", async () => {
    const out = await runScript(`
const task = await taskSpace('uncheck');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const loc = page.locator('#agree');
await loc.check();
await loc.uncheck();
const checked = await loc.isChecked();
console.log('CHECKED:' + checked);
await task.finish({keep:[]});
`);
    assert.match(out, /CHECKED:false/);
  });
});

describe("selectOption", () => {
  it("selects an option by value", async () => {
    const out = await runScript(`
const task = await taskSpace('select');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
await page.getByLabel('Color').selectOption('blue');
const val = await page.evaluate("document.getElementById('color').value");
console.log('COLOR:' + val);
await task.finish({keep:[]});
`);
    assert.match(out, /COLOR:blue/);
  });
});

describe("getAttribute", () => {
  it("returns the attribute value", async () => {
    const out = await runScript(`
const task = await taskSpace('attr');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const val = await page.locator('#link').getAttribute('data-custom');
console.log('ATTR:' + val);
await task.finish({keep:[]});
`);
    assert.match(out, /ATTR:hello/);
  });
});

describe("evaluateAll", () => {
  it("maps all matching elements to their text content", async () => {
    const out = await runScript(`
const task = await taskSpace('evalall');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const texts = await page.locator('#fruits .fruit').evaluateAll(
  els => els.map(el => el.textContent.trim())
);
console.log('FRUITS:' + JSON.stringify(texts));
await task.finish({keep:[]});
`);
    const m = out.match(/FRUITS:(\[.*?\])/);
    assert.ok(m, "FRUITS line found");
    const fruits = JSON.parse(m[1]);
    assert.deepEqual(fruits, ["Mango", "Papaya", "Lychee"]);
  });
});

describe("allInnerTexts and allTextContents", () => {
  it("allInnerTexts returns array of innerText strings", async () => {
    const out = await runScript(`
const task = await taskSpace('allinner');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
const texts = await page.locator('#items .item').allInnerTexts();
console.log('TEXTS:' + JSON.stringify(texts));
await task.finish({keep:[]});
`);
    const m = out.match(/TEXTS:(\[.*?\])/);
    assert.ok(m, "TEXTS line found");
    const texts = JSON.parse(m[1]);
    assert.ok(texts.includes("Apple") && texts.includes("Banana"));
  });
});

describe("snapshot selectors and nested text", () => {
  it("reads through the loc=role / loc=testid / text= selectors a snapshot prints", async () => {
    const out = await runScript(`
const task = await taskSpace('locsel');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
console.log('ROLE:' + await page.locator('loc=role:button[name="Submit"]').textContent());
console.log('ROLESUB:' + await page.locator('loc=role:button[name*="ance"]').count());
console.log('TESTID:' + await page.locator('loc=testid:submit-btn').innerText());
console.log('TEXT:' + await page.locator('text="Cancel"').count());
console.log('SUB:' + await page.getByText('cancel').count());
await task.finish({keep:[]});
`);
    assert.match(out, /ROLE:Submit/);
    assert.match(out, /ROLESUB:1/);
    assert.match(out, /TESTID:Submit/);
    assert.match(out, /TEXT:1/);
    // Substring text matches the button, not every ancestor whose text contains it.
    assert.match(out, /SUB:1/);
  });
});

describe("DOM-API locator methods on role/text locators", () => {
  it("scrollIntoViewIfNeeded, blur and dispatchEvent work on getByRole/getByText", async () => {
    const out = await runScript(`
const task = await taskSpace('domapi');
const page = task.page('p1');
await page.goto(${JSON.stringify(FIXTURE)}, {waitUntil:'load'});
await page.getByRole('button', { name: 'Submit' }).scrollIntoViewIfNeeded();
await page.getByText('Cancel', { exact: true }).dispatchEvent('click');
await page.getByRole('button', { name: 'Submit' }).blur();
console.log('MARKS:' + await page.evaluate(() => document.querySelectorAll('[data-ego-loc]').length));
console.log('QUOTED:' + await page.getByText('"no such quoted text"').count());
await task.finish({keep:[]});
`);
    assert.match(out, /MARKS:0/);
    assert.match(out, /QUOTED:0/);
  });
});

describe("getByLabel beyond <label>", () => {
  it("finds controls named by aria-label and aria-labelledby", async () => {
    const page = `data:text/html;charset=utf-8,${encodeURIComponent(
      '<span id="lbl">Telefonszám</span><input aria-labelledby="lbl"><input aria-label="Név"><label for="c">Cím</label><input id="c">',
    )}`;
    const out = await runScript(`
const task = await taskSpace('aria-label');
const page = task.page('p1');
await page.goto(${JSON.stringify(page)}, {waitUntil:'load'});
console.log('ARIA:' + await page.getByLabel('Név').count());
console.log('BY:' + await page.getByLabel('Telefonszám').count());
console.log('LABEL:' + await page.getByLabel('Cím').count());
await page.getByLabel('Név', { exact: true }).fill('Vikt');
console.log('VAL:' + await page.getByLabel('Név').inputValue());
await task.finish({keep:[]});
`);
    assert.match(out, /ARIA:1/);
    assert.match(out, /BY:1/);
    assert.match(out, /LABEL:1/);
    assert.match(out, /VAL:Vikt/);
  });
});
