import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The claim observer mode actually makes is a cross-process one: agent B watches
 * a space agent A is driving, in a different OS process, against the same
 * browser. The unit suites all run in one process and cannot show that — this
 * one spawns the real CLI twice, exactly as two agents would.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ego-browser.mjs");
const FIXTURE_URL = `file://${join(HERE, "fixture", "index.html")}`;

// Its own profile and state dir, for the reason port.test.mjs has one: `npm test`
// must not hijack — and on teardown kill — the browser a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-observe-e2e-"));
const TEST_ENV = {
  XDG_STATE_HOME: join(SANDBOX, "state"),
  EGO_LINUX_PROFILE: join(SANDBOX, "profile"),
};
const TEST_BROWSER_STATE = join(SANDBOX, "state", "ego-lite-linux", "browser.json");

/** Run a heredoc through the real CLI, exactly as an agent would. */
function run(code, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "--headless"], {
      env: { ...process.env, ...TEST_ENV, FIXTURE_URL },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeout}ms\n${stdout}\n${stderr}`));
    }, timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code2) => {
      clearTimeout(timer);
      if (code2 !== 0) {
        reject(new Error(`exit ${code2}\n${stdout}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(code);
  });
}

after(async () => {
  try {
    const state = JSON.parse(await readFile(TEST_BROWSER_STATE, "utf8"));
    if (state.pid) process.kill(state.pid, "SIGTERM");
  } catch {
    // nothing running
  }
  // Chrome keeps writing to its profile while shutting down, so a removal racing
  // that hits ENOTEMPTY. Cleanup is best-effort.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await rm(SANDBOX, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300,
  }).catch(() => {});
});

describe("two processes, one space", () => {
  it("lets a second process watch without touching the first one's page", async () => {
    // Agent A: open a space and put a real page in it.
    const opened = await run(`
      const task = await taskSpaces.useOrCreate('driven work')
      await page.goto(process.env.FIXTURE_URL)
      await page.waitForLoadState()
      console.log(JSON.stringify({ id: task.id, title: (await page.info()).title }))
    `);
    const { id, title } = JSON.parse(opened.trim().split("\n").at(-1));
    assert.ok(id, "agent A opened a space");

    // Agent B: a different process, watching the same space.
    const watched = await run(`
      await taskSpaces.observe(${id})
      const info = await page.info()
      const snap = await page.snapshot()
      const shot = await page.screenshot()

      const refused = {}
      for (const [name, call] of Object.entries({
        click: () => page.locator('#click-button').click(),
        goto: () => page.goto('https://example.com'),
        evaluate: () => page.evaluate('document.title = "hijacked"'),
        reload: () => page.reload(),
      })) {
        try {
          await call()
          refused[name] = 'ALLOWED'
        } catch (error) {
          refused[name] = /observing a task space/.test(error.message)
            ? 'refused'
            : 'other: ' + error.message
        }
      }
      console.log(JSON.stringify({
        title: info.title,
        readSnapshot: typeof snap === 'string' ? snap.length > 0 : Boolean(snap),
        readScreenshot: Boolean(shot),
        refused,
      }))
    `);
    const seen = JSON.parse(watched.trim().split("\n").at(-1));

    assert.equal(seen.title, title, "B sees the page A is on");
    assert.ok(seen.readSnapshot, "snapshot works while observing");
    assert.ok(seen.readScreenshot, "screenshot works while observing");
    assert.deepEqual(
      seen.refused,
      { click: "refused", goto: "refused", evaluate: "refused", reload: "refused" },
      "every write was refused, and refused for the observing reason",
    );

    // Agent A again, in a third process: the page must be exactly as it left it,
    // and driving must still work — B observing must not have leaked out of B.
    const after2 = await run(`
      await taskSpaces.switch(${id})
      const info = await page.info()
      await page.locator('#click-button').click()
      console.log(JSON.stringify({ title: info.title, clicked: true }))
    `);
    const back = JSON.parse(after2.trim().split("\n").at(-1));

    assert.equal(back.title, title, "the observer changed nothing");
    assert.ok(back.clicked, "the driver can still act after being watched");
  });
});
