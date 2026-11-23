import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  browserInstanceKey,
  pinRuntimeInstance,
} from "../src/runtime-instance.mjs";

describe("runtime instance pinning", () => {
  it("keys the instance by the browser's DevTools GUID", () => {
    assert.equal(
      browserInstanceKey(
        "ws://127.0.0.1:37085/devtools/browser/7028f5e7-eeb9-4c74-9db0-4e1f03920ed2",
      ),
      "browser-7028f5e7-eeb9-4c74-9db0-4e1f03920ed2",
    );
    assert.equal(browserInstanceKey(undefined), null);
    assert.equal(browserInstanceKey("ws://127.0.0.1:1/devtools/page/X"), null);
  });

  it("makes process.ppid report the key, where plain assignment does not", () => {
    const fake = {};
    Object.defineProperty(fake, "ppid", {
      value: 4242,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    assert.equal(pinRuntimeInstance("browser-abc", fake), true);
    assert.equal(fake.ppid, "browser-abc");
    assert.equal(pinRuntimeInstance(null, fake), false);
    assert.equal(fake.ppid, "browser-abc");
  });
});
