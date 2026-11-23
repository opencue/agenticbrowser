import assert from "node:assert/strict";
import test from "node:test";

import { pinRuntimeInstance } from "../dist/src/cli.js";

test("pinRuntimeInstance keys process.ppid by the browser's DevTools GUID", () => {
  const fake = {};
  Object.defineProperty(fake, "ppid", {
    value: 4242,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  assert.equal(
    pinRuntimeInstance("ws://127.0.0.1:9522/devtools/browser/abc-123", fake),
    true,
  );
  assert.equal(fake.ppid, "browser-abc-123");
  assert.equal(pinRuntimeInstance(undefined, fake), false);
  assert.equal(fake.ppid, "browser-abc-123");
});
