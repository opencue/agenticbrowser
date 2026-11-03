import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  desktopEntry,
  installDesktopEntry,
  launchTargets,
} from "../src/desktop.mjs";
import { IS_WINDOWS } from "../src/platform.mjs";

// Paths resolve per platform (a drive letter on Windows), so build the
// expected file URLs the same way rather than hard-coding POSIX ones.
const fileUrl = (cwd, path) => pathToFileURL(resolve(cwd, path)).href;

test("Linux launcher names the Chromium surface honestly", () => {
  const entry = desktopEntry("/opt/ego/ego-browser.mjs");

  assert.match(entry, /^Name=ego lite Spaces \(Chromium port\)$/m);
  assert.match(entry, /^GenericName=Managed Agent Chromium$/m);
  assert.match(entry, /^Comment=.*Chrome\/Chromium.*$/m);
  assert.doesNotMatch(entry, /The browser you and your AI agents share/);
});

test("the launcher takes the pages xdg-open passes and offers itself for web content", () => {
  const entry = desktopEntry("/opt/ego/ego-browser.mjs");

  assert.match(entry, /^Exec=.* \/opt\/ego\/ego-browser\.mjs --launch %U$/m);
  assert.match(entry, /^MimeType=.*text\/html;.*x-scheme-handler\/https;$/m);
});

test("launch targets keep URLs and turn paths into file URLs", () => {
  assert.deepEqual(
    launchTargets(
      [
        "https://example.com/a?b=1",
        "report.html",
        "/tmp/x y.html",
        "--headless",
        "",
      ],
      "/home/u",
    ),
    [
      "https://example.com/a?b=1",
      fileUrl("/home/u", "report.html"),
      fileUrl("/home/u", "/tmp/x y.html"),
    ],
  );
  assert.deepEqual(launchTargets([]), []);
});

test("launch targets refuse script and browser-internal schemes", () => {
  assert.deepEqual(
    launchTargets(
      ["javascript:alert(1)", "chrome://settings", "-x", "about:blank"],
      "/home/u",
    ),
    [
      fileUrl("/home/u", "javascript:alert(1)"),
      fileUrl("/home/u", "chrome://settings"),
      "about:blank",
    ],
  );
});

// installDesktopEntry writes real files; test only the Linux (XDG) path.
if (!IS_WINDOWS) {
  test("installDesktopEntry writes an executable .desktop file and SVG icon", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ego-desktop-install-test-"));
    const origXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = sandbox;
    try {
      const { entryPath, iconPath } = await installDesktopEntry();

      // (1) .desktop file exists and has execute bits set
      const entryStat = await stat(entryPath);
      assert.ok(entryStat.isFile(), ".desktop is a regular file");
      // 0o111 = any execute bit (user/group/other)
      assert.ok(
        // eslint-disable-next-line no-bitwise
        (entryStat.mode & 0o111) !== 0,
        ".desktop file has at least one execute bit set",
      );

      // (2) SVG icon exists
      const iconStat = await stat(iconPath);
      assert.ok(iconStat.isFile(), "SVG icon is a regular file");
      assert.ok(iconPath.endsWith(".svg"), "icon path has .svg extension");

      // (3) desktopEntry() content is present: at minimum the section header
      //     and the Exec= line that embeds the current interpreter
      const content = await readFile(entryPath, "utf8");
      assert.match(
        content,
        /^\[Desktop Entry\]/m,
        "desktop-entry section header present",
      );
      assert.match(
        content,
        new RegExp(
          `^Exec=${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          "m",
        ),
        "Exec= line pins the current Node.js interpreter",
      );
      assert.match(
        content,
        /--launch %U/,
        "desktop entry handles web-content URLs",
      );
    } finally {
      if (origXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = origXdg;
      }
      await rm(sandbox, { recursive: true, force: true });
    }
  });
}
