import test from "node:test";
import assert from "node:assert/strict";

import { runMain } from "../dist/src/run.js";

const discard = () => ({ write() {} });

/** Run a script that is expected to throw, and return the error it threw. */
async function failWith(lines) {
  const previous = globalThis.ego;
  delete globalThis.ego;
  try {
    await runMain({
      argv: [],
      stdinText: lines.join("\n"),
      stdout: discard(),
      stderr: discard(),
      services: { printUpdateBanner() {} },
    });
  } catch (error) {
    return error;
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
  throw new Error("expected the script to throw");
}

/** The line and column the stack blames, in the agent's own coordinates. */
function blamed(error) {
  const frame = String(error.stack).match(/, <anonymous>:(\d+):(\d+)\)/);
  assert.ok(frame, `no script frame in stack:\n${error.stack}`);
  return { line: Number(frame[1]), column: Number(frame[2]) };
}

test("blames the line the agent wrote, not the wrapper's", async () => {
  const error = await failWith([
    "const a = 1",
    "const b = 2",
    "const c = 3",
    "null.boom",
  ]);
  // Unrealigned this reads 7: new AsyncFunction prepends a `function anonymous(…)`
  // header, its `) {`, and the injected `"use strict";`.
  assert.equal(blamed(error).line, 4);
});

test("blames line 1 when the very first line throws", async () => {
  const error = await failWith(["null.boom", "const unused = 1"]);
  assert.equal(blamed(error).line, 1);
});

test("blames the declaration, not the statement below it", async () => {
  // The shape of a real failure: a findIndex callback reading the const it is
  // still initialising. The agent that hit this was sent three lines past it, to
  // a console.log, and could find nothing wrong there — because nothing was.
  const culprit =
    "const i = lines.findIndex(l => l === 'Audience' && lines[i - 1] !== 'Branding')";
  const error = await failWith([
    "const lines = ['Branding', 'Audience']",
    "const before = 1",
    culprit,
    "const j = lines.findIndex(l => l === 'Branding')",
    "console.log(lines.slice(j).join(','))",
  ]);

  assert.match(error.message, /Cannot access 'i' before initialization/);
  const { line, column } = blamed(error);
  assert.equal(line, 3, "the findIndex line, not the console.log three below");
  // Columns need no adjustment — the wrapper adds whole lines — and V8 points at
  // the `i` being read, so this proves they were left alone rather than shifted.
  assert.equal(column, culprit.indexOf("lines[i") + "lines[".length + 1);
});

test("leaves frames it cannot attribute to the script alone", async () => {
  // A rejection carrying a browser-shaped stack: `at fn (<anonymous>:9:3)` has no
  // leading `, `, so those line numbers belong to the page and must survive as-is.
  const error = await failWith([
    "const err = new Error('from the page')",
    'err.stack = "Error: from the page\\n    at handler (<anonymous>:9:3)"',
    "throw err",
  ]);
  assert.match(error.stack, /at handler \(<anonymous>:9:3\)/);
});

test("never rewrites the message, only the frames", async () => {
  // An agent scraping a page that displays a stack trace, then throwing it. The
  // numbers in the message are the page's and mean nothing here.
  const scraped = "boom at foo, <anonymous>:12:3) while loading";
  const error = await failWith([
    "const err = new Error(" + JSON.stringify(scraped) + ")",
    "throw err",
  ]);
  assert.equal(error.message, scraped);
  assert.ok(
    error.stack.startsWith(`Error: ${scraped}`),
    `message was rewritten:\n${error.stack}`,
  );
});
