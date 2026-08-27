import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createDesktopFocusGuard } from "../src/focus-guard.mjs";
import { APP_DIR } from "../src/platform.mjs";

const execFileAsync = promisify(execFile);

function sequence(...values) {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)];
}

describe("desktop focus guard", () => {
  it("restores the previous app when the managed browser steals focus", async () => {
    const restored = [];
    const events = [];
    const guard = createDesktopFocusGuard({
      browserPid: 4242,
      getActiveWindow: sequence(
        { kind: "x11-window", windowId: "11", pid: 1001 },
        { kind: "x11-window", windowId: "22", pid: 4242 },
        { kind: "x11-window", windowId: "11", pid: 1001 },
      ),
      restoreFocus: async (focus) => {
        restored.push(focus.windowId);
        return true;
      },
      recordEvent: async (event) => events.push(event),
      sleep: async () => {},
    });

    const result = await guard.run("create-tab", async () => "created");

    assert.equal(result, "created");
    assert.deepEqual(restored, ["11"]);
    assert.equal(events.length, 1);
    assert.deepEqual(
      {
        reason: events[0].reason,
        browserPid: events[0].browserPid,
        previous: events[0].previous,
        observed: events[0].observed,
        restored: events[0].restored,
      },
      {
        reason: "create-tab",
        browserPid: 4242,
        previous: { kind: "x11-window", windowId: "11", pid: 1001 },
        observed: { kind: "x11-window", windowId: "22", pid: 4242 },
        restored: true,
      },
    );
  });

  it("does not fight a person who switches to another application", async () => {
    const restored = [];
    const guard = createDesktopFocusGuard({
      browserPid: 4242,
      getActiveWindow: sequence(
        { kind: "x11-window", windowId: "11", pid: 1001 },
        { kind: "x11-window", windowId: "33", pid: 3003 },
      ),
      restoreFocus: async (focus) => restored.push(focus.windowId),
      recordEvent: async () =>
        assert.fail("a non-browser switch is not a theft"),
      sleep: async () => {},
    });

    await guard.run("create-tab", async () => {});

    assert.deepEqual(restored, []);
  });

  it("repairs a managed browser window created during startup", async () => {
    const restored = [];
    const guard = createDesktopFocusGuard({
      browserPid: 4242,
      getActiveWindow: sequence(
        { kind: "x11-window", windowId: "22", pid: 4242 },
        { kind: "wayland-history", windowId: null, pid: null },
      ),
      restoreFocus: async (focus) => {
        restored.push(focus);
        return true;
      },
      recordEvent: async () => {},
      sleep: async () => {},
    });

    await guard.restoreAfter("launch-browser", {
      kind: "wayland-history",
      windowId: null,
      pid: null,
    });

    assert.deepEqual(restored, [
      { kind: "wayland-history", windowId: null, pid: null },
    ]);
  });

  it("leaves explicit work alone when the browser already had focus", async () => {
    let reads = 0;
    const guard = createDesktopFocusGuard({
      browserPid: 4242,
      getActiveWindow: async () => {
        reads += 1;
        return { kind: "x11-window", windowId: "22", pid: 4242 };
      },
      restoreFocus: async () => assert.fail("nothing should be restored"),
      recordEvent: async () => assert.fail("nothing should be audited"),
      sleep: async () => {},
    });

    await guard.run("create-tab", async () => {});

    assert.equal(reads, 1);
  });

  it("preserves the operation error after repairing focus", async () => {
    const restored = [];
    const guard = createDesktopFocusGuard({
      browserPid: 4242,
      getActiveWindow: sequence(
        { kind: "x11-window", windowId: "11", pid: 1001 },
        { kind: "x11-window", windowId: "22", pid: 4242 },
        { kind: "x11-window", windowId: "11", pid: 1001 },
      ),
      restoreFocus: async (focus) => {
        restored.push(focus.windowId);
        return true;
      },
      recordEvent: async () => {},
      sleep: async () => {},
    });

    await assert.rejects(
      guard.run("create-tab", async () => {
        throw new Error("create failed");
      }),
      /create failed/,
    );
    assert.deepEqual(restored, ["11"]);
  });

  it("does not claim success when the compositor kept the browser focused", async () => {
    const events = [];
    const guard = createDesktopFocusGuard({
      browserPid: 4242,
      getActiveWindow: sequence(
        { kind: "wayland-history", windowId: null, pid: null },
        { kind: "x11-window", windowId: "22", pid: 4242 },
        { kind: "x11-window", windowId: "22", pid: 4242 },
      ),
      restoreFocus: async () => true,
      recordEvent: async (event) => events.push(event),
      sleep: async () => {},
    });

    await guard.run("create-tab", async () => {});

    assert.equal(events[0].restored, false);
  });

  it("writes a private JSONL audit record for a repaired theft", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ego-focus-audit-"));
    const moduleUrl = new URL("../src/focus-guard.mjs", import.meta.url).href;
    try {
      await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const { appendFocusAudit } = await import(${JSON.stringify(moduleUrl)});
           await appendFocusAudit({ at: "now", reason: "create-tab", restored: true });`,
        ],
        {
          env: { ...process.env, XDG_STATE_HOME: sandbox },
        },
      );

      const auditFile = join(sandbox, APP_DIR, "focus-audit.jsonl");
      assert.deepEqual(JSON.parse((await readFile(auditFile, "utf8")).trim()), {
        at: "now",
        reason: "create-tab",
        restored: true,
      });
      if (process.platform !== "win32") {
        assert.equal((await stat(auditFile)).mode & 0o777, 0o600);
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
