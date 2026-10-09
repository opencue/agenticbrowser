import test from "node:test";
import assert from "node:assert/strict";

import { desktopEntry, launchTargets } from "../src/desktop.mjs";

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
    launchTargets(["https://example.com/a?b=1", "report.html", "/tmp/x y.html", "--headless", ""], "/home/u"),
    ["https://example.com/a?b=1", "file:///home/u/report.html", "file:///tmp/x%20y.html"],
  );
  assert.deepEqual(launchTargets([]), []);
});
