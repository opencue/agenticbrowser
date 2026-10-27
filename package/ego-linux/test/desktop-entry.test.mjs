import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { desktopEntry, launchTargets } from "../src/desktop.mjs";

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
