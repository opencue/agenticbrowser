import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { replaceFile } from "../src/atomic-write.mjs";

/**
 * State files must never be readable half-written.
 *
 * Every heredoc is its own process and the Spaces panel is another, so the
 * writers overlap as a matter of course. readState() cannot tell a fragment
 * from an absent file -- both reach its catch, which answers "no spaces at
 * all" -- so a torn read becomes an empty document and the next write makes
 * that permanent. From the outside it looks like a space the agent created a
 * moment ago going missing.
 *
 * Writing in place produced a torn read in roughly one attempt in three here,
 * so a regression shows up reliably rather than occasionally.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixture", "atomic-writer.mjs");

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-state-write-"));
after(() => rm(SANDBOX, { recursive: true, force: true }));

function run(role, file, iterations) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [FIXTURE, role, file, String(iterations)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`${role} exited ${code}\n${out}\n${err}`)),
    );
  });
}

describe("replacing a state file", () => {
  it("is never observed half-done by a concurrent reader", async () => {
    const file = join(SANDBOX, "concurrent.json");
    const [, torn] = await Promise.all([
      run("writer", file, 250),
      run("reader", file, 250),
    ]);

    assert.equal(
      Number(torn),
      0,
      `a reader saw ${torn} fragments. The file is not being replaced in one ` +
        `step, and every one of those becomes an empty state downstream.`,
    );
  });

  it("leaves the file holding exactly what was written last", async () => {
    const file = join(SANDBOX, "contents.json");
    await replaceFile(file, '{"spaces":[{"id":7}]}');
    await replaceFile(file, '{"spaces":[{"id":9}]}');
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      spaces: [{ id: 9 }],
    });
  });

  it("replaces a file that is already there, rather than refusing", async () => {
    // rename() over an existing path is the whole mechanism; a platform that
    // rejected it would fail here rather than in the field.
    const file = join(SANDBOX, "existing.json");
    await writeFile(file, "stale");
    await replaceFile(file, "fresh");
    assert.equal(await readFile(file, "utf8"), "fresh");
  });

  it(
    "applies scratch-file permissions to the replacement",
    { skip: process.platform === "win32" },
    async () => {
      const file = join(SANDBOX, "private.json");
      await replaceFile(file, "private", { mode: 0o600 });
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    },
  );

  it("leaves no scratch file behind, on the way through or on failure", async () => {
    const dir = join(SANDBOX, "leftovers");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "state.json");

    for (let i = 0; i < 5; i += 1) await replaceFile(file, `{"round":${i}}`);
    assert.deepEqual(await readdir(dir), ["state.json"]);

    // A write that cannot land must not leave its scratch copy either.
    await assert.rejects(() =>
      replaceFile(join(dir, "missing", "x.json"), "{}"),
    );
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  it("keeps concurrent writes from this process off one another's scratch file", async () => {
    const file = join(SANDBOX, "same-process.json");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => replaceFile(file, `{"round":${i}}`)),
    );
    // Whichever landed last, the file has to be one whole document.
    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.ok(Number.isInteger(parsed.round));
  });
});
