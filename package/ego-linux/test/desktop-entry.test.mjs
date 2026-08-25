import test from "node:test";
import assert from "node:assert/strict";

import { desktopEntry } from "../src/desktop.mjs";

test("Linux launcher names the Chromium surface honestly", () => {
  const entry = desktopEntry("/opt/ego/ego-browser.mjs");

  assert.match(entry, /^Name=ego lite Spaces \(Chromium port\)$/m);
  assert.match(entry, /^GenericName=Managed Agent Chromium$/m);
  assert.match(entry, /^Comment=.*Chrome\/Chromium.*$/m);
  assert.doesNotMatch(entry, /The browser you and your AI agents share/);
});
