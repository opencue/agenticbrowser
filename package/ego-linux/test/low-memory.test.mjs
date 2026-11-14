import { it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LOW_MEMORY_MB,
  LOW_MEMORY_FLAGS,
  availableMemoryMb,
  isLowMemory,
} from "../src/low-memory.mjs";

it("treats less available memory than the default threshold as low", () => {
  assert.equal(isLowMemory(DEFAULT_LOW_MEMORY_MB - 1, {}), true);
  assert.equal(isLowMemory(DEFAULT_LOW_MEMORY_MB, {}), false);
});

it("moves the threshold with EGO_LINUX_LOW_MEMORY_MB and turns off at 0", () => {
  assert.equal(isLowMemory(1500, { EGO_LINUX_LOW_MEMORY_MB: "1024" }), false);
  assert.equal(isLowMemory(900, { EGO_LINUX_LOW_MEMORY_MB: "1024" }), true);
  assert.equal(isLowMemory(1, { EGO_LINUX_LOW_MEMORY_MB: "0" }), false);
  assert.equal(isLowMemory(1, { EGO_LINUX_LOW_MEMORY_MB: "junk" }), false);
});

it("never reports low memory where available memory cannot be read", () => {
  assert.equal(isLowMemory(null, {}), false);
});

it("reads available memory as a positive number of MiB or null", async () => {
  const mb = await availableMemoryMb();
  assert.ok(mb === null || (Number.isInteger(mb) && mb > 0));
});

it("trims the browser without touching what a page can do", () => {
  assert.deepEqual(LOW_MEMORY_FLAGS, [
    "--renderer-process-limit=2",
    "--disable-extensions",
  ]);
});
