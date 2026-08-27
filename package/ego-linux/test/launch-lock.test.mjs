import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLaunchLock } from "../src/launch-lock.mjs";

describe("Spaces launcher lock", () => {
  it("serializes concurrent launchers", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-launch-lock-"));
    const lockDir = join(root, "lock");
    const releaseFirst = await acquireLaunchLock(lockDir);
    let acquiredSecond = false;
    const second = acquireLaunchLock(lockDir).then((release) => {
      acquiredSecond = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(acquiredSecond, false);
    await releaseFirst();
    const releaseSecond = await second;
    assert.equal(acquiredSecond, true);
    await releaseSecond();
  });

  it("reclaims a lock owned by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-launch-stale-"));
    const lockDir = join(root, "lock");
    const moduleUrl = new URL("../src/launch-lock.mjs", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { acquireLaunchLock } from ${JSON.stringify(moduleUrl)};
         await acquireLaunchLock(${JSON.stringify(lockDir)});
         process.stdout.write("locked\\n");
         setTimeout(() => process.exit(0), 20);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = once(child, "exit");
    await once(child.stdout, "data");
    await exited;

    const release = await acquireLaunchLock(lockDir, { timeoutMs: 1000 });
    await release();
  });

  it("never publishes an ownerless lock even with zero grace", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-launch-zero-grace-"));
    const lockDir = join(root, "lock");
    let inside = 0;
    let maxInside = 0;

    await Promise.all(
      Array.from({ length: 30 }, async () => {
        const release = await acquireLaunchLock(lockDir, {
          ownerGraceMs: 0,
          pollMs: 0,
          timeoutMs: 5000,
        });
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inside -= 1;
        await release();
      }),
    );

    assert.equal(maxInside, 1);
  });
});
