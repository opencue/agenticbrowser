import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectRuntime } from "../src/runtime-select.mjs";

describe("runtime selection", () => {
  it("keeps v1 for the page / taskSpaces API", () => {
    assert.equal(selectRuntime("await page.goto('https://example.com')", {}), "v1");
    assert.equal(
      selectRuntime("await taskSpaces.run('x', async () => {})", {}),
      "v1",
    );
    assert.equal(selectRuntime("await taskSpaces.useOrCreate('x')", {}), "v1");
  });

  it("switches to v2 when the script calls taskSpace() or profiles()", () => {
    assert.equal(selectRuntime('const task = await taskSpace("x")', {}), "v2");
    assert.equal(selectRuntime("console.log(await profiles())", {}), "v2");
    assert.equal(selectRuntime("await taskSpace (7)", {}), "v2");
  });

  it("does not mistake member calls or longer names for v2", () => {
    assert.equal(selectRuntime("obj.taskSpace('x')", {}), "v1");
    assert.equal(selectRuntime("myprofiles()", {}), "v1");
    assert.equal(selectRuntime("taskSpaces.list()", {}), "v1");
  });

  it("lets EGO_BROWSER_RUNTIME override the detection", () => {
    assert.equal(
      selectRuntime("await page.goto('x')", { EGO_BROWSER_RUNTIME: "v2" }),
      "v2",
    );
    assert.equal(
      selectRuntime("await taskSpace('x')", { EGO_BROWSER_RUNTIME: "V1" }),
      "v1",
    );
    assert.equal(
      selectRuntime("await taskSpace('x')", { EGO_BROWSER_RUNTIME: "bogus" }),
      "v2",
    );
  });
});
