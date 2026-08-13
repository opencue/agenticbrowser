import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The task-space file is shared by every agent on the machine, and each heredoc
 * runs its own process — so two agents working at the same time are two writers
 * against one file. These are the cases that used to lose data, run as real
 * concurrent processes rather than interleaved calls in one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-state-race-"));

/**
 * Run a snippet in its own process against a given state dir.
 *
 * Each child imports task-spaces.mjs fresh, so it gets its own module state and
 * its own file handle — the same isolation two agents have.
 */
function child(stateHome, body) {
  return new Promise((resolve, reject) => {
    const code = `
      process.env.XDG_STATE_HOME = ${JSON.stringify(stateHome)};
      process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";
      const { createTaskSpacesApi } = await import(${JSON.stringify(
        join(HERE, "..", "src", "task-spaces.mjs"),
      )});
      const cdp = {
        async call(method) {
          if (method === "Target.getTargets") return { targetInfos: [] };
          if (method === "Target.createTarget") return { targetId: "t-" + process.pid };
          if (method === "Target.attachToTarget") return { sessionId: "s-1" };
          return {};
        },
      };
      const spaces = createTaskSpacesApi(cdp);
      ${body}
    `;
    const proc = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", reject);
    proc.on("close", (status) => {
      if (status !== 0) reject(new Error(`exit ${status}\n${out}\n${err}`));
      else resolve(out);
    });
  });
}

/** A fresh state dir with one space already in it. */
async function seeded(name) {
  const stateHome = join(SANDBOX, name);
  const dir = join(stateHome, "ego-lite-linux");
  await mkdir(dir, { recursive: true });
  const at = Date.now();
  await writeFile(
    join(dir, "task-spaces.json"),
    JSON.stringify({
      spaces: [
        {
          id: 1,
          taskId: 1,
          name: "existing",
          createdAt: at,
          touchedAt: at,
          lastContentAt: at,
          ownership: "agent",
          targetIds: ["t-a"],
        },
      ],
      selectedId: 1,
      nextId: 2,
    }),
  );
  return { stateHome, file: join(dir, "task-spaces.json") };
}

describe("two agents writing the task-space file at once", () => {
  it("keeps every space when two agents create them concurrently", async () => {
    // The bug: readState -> modify -> writeState is not atomic, so two writers
    // read the same nextId, build a space with the same id, and whichever writes
    // last erases the other's. An agent's space silently vanishes.
    //
    // One create each barely overlaps — process startup is slower than the work,
    // so they tend to serialise by luck and the race hides. A run of them each is
    // both a realistic session and enough interleaving to make it certain.
    const EACH = 10;
    const { stateHome, file } = await seeded("create-race");

    const burst = (who) => `
      for (let i = 0; i < ${EACH}; i += 1) {
        await spaces.createTaskSpace("${who}-" + i);
      }
    `;
    await Promise.all([
      child(stateHome, burst("A")),
      child(stateHome, burst("B")),
    ]);

    const state = JSON.parse(await readFile(file, "utf8"));
    const names = state.spaces.map((space) => space.name);
    assert.equal(
      names.length,
      EACH * 2 + 1,
      `expected ${EACH * 2 + 1} spaces, found ${names.length} — the rest were overwritten`,
    );
    for (const who of ["A", "B"]) {
      for (let i = 0; i < EACH; i += 1) {
        assert.ok(names.includes(`${who}-${i}`), `${who}-${i} survived`);
      }
    }
    const ids = state.spaces.map((space) => space.id);
    assert.equal(new Set(ids).size, ids.length, `ids must be unique, got ${ids}`);
    assert.ok(
      state.nextId > Math.max(...ids),
      "nextId must still be ahead of every id handed out",
    );
  });

  it("does not lose one writer's update to another's", async () => {
    // The same race on an existing space: one process claims it while the other
    // adds spaces beside it. Both start from the same snapshot, so the later
    // write reverts whatever the earlier one recorded.
    const { stateHome, file } = await seeded("update-race");

    await Promise.all([
      child(
        stateHome,
        `for (let i = 0; i < 8; i += 1) await spaces.claimTaskSpace(1);`,
      ),
      child(
        stateHome,
        `for (let i = 0; i < 8; i += 1) await spaces.createTaskSpace("beside-" + i);`,
      ),
    ]);

    const state = JSON.parse(await readFile(file, "utf8"));
    assert.equal(
      state.spaces.length,
      9,
      `the claims must not erase the spaces created beside them, found ${state.spaces.length}`,
    );
    assert.equal(state.spaces[0].ownership, "agent", "the claim still took effect");
  });

  it("never leaves a half-written file for a reader to trip on", async () => {
    // A plain writeFile truncates and then fills, so a reader landing mid-write
    // sees invalid JSON — and readState swallows that as "no spaces at all",
    // which reads to the agent as its work having disappeared.
    const { stateHome, file } = await seeded("torn-read");

    const writers = Array.from({ length: 6 }, (_, index) =>
      child(stateHome, `await spaces.createTaskSpace("space ${index}");`),
    );
    const readers = (async () => {
      const seen = [];
      for (let i = 0; i < 250; i += 1) {
        try {
          const raw = await readFile(file, "utf8");
          JSON.parse(raw);
        } catch (error) {
          if (error.code !== "ENOENT") seen.push(String(error.message));
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return seen;
    })();

    const [, torn] = await Promise.all([Promise.all(writers), readers]);
    assert.deepEqual(torn, [], "every read saw a complete, parseable file");
  });
});

process.on("exit", () => {
  rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
});
