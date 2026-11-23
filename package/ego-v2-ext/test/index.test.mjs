import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PRELUDE, extendTask, withExtensions, wrap } from "../src/index.mjs";

function makeRuntime() {
  class Page {
    constructor(label) {
      this.label = label;
    }
  }
  class TaskSpace {
    page(label) {
      return new Page(label);
    }
    async newPage() {
      return new Page("p2");
    }
    async pages() {
      return [new Page("p1"), new Page("p2")];
    }
  }
  return { Page, TaskSpace };
}

describe("v2 extension installer", () => {
  it("keeps the prelude on one line so script line numbers do not move", () => {
    assert.doesNotMatch(PRELUDE, /\n/);
    assert.match(
      PRELUDE,
      /^taskSpace=globalThis\.__egoV2Ext\.wrap\(taskSpace\);/,
    );
    const target = {};
    assert.equal(withExtensions("x()", target), `${PRELUDE}x()`);
    assert.equal(typeof target.__egoV2Ext.wrap, "function");
  });

  it("extends TaskSpace and every Page it hands out, once per prototype", async () => {
    const { Page, TaskSpace } = makeRuntime();
    const factory = wrap(async () => new TaskSpace());
    const task = await factory("name");
    assert.equal(typeof task.requestUserAction, "function");
    assert.equal(typeof task.loginPreflight, "function");
    const p1 = task.page("p1");
    assert.equal(typeof p1.debug, "function");
    assert.equal(typeof p1.locator, "function");
    assert.equal(typeof p1.fastObserve, "function");
    assert.equal(typeof p1.waitForRequest, "function");
    assert.equal(typeof (await task.newPage()).debug, "function");
    for (const page of await task.pages())
      assert.equal(typeof page.debug, "function");
    // Patching is per prototype: a Page made any other way has it too.
    assert.equal(typeof new Page("popup").debug, "function");
    // A second TaskSpace does not wrap page() twice.
    const before = TaskSpace.prototype.page;
    extendTask(new TaskSpace());
    assert.equal(TaskSpace.prototype.page, before);
  });

  it("never shadows a method the v2 runtime already has", async () => {
    class Page {
      debug() {
        return "upstream";
      }
    }
    class TaskSpace {
      page() {
        return new Page();
      }
    }
    const task = await wrap(async () => new TaskSpace())();
    assert.equal(task.page().debug(), "upstream");
  });

  it("passes non-object results through untouched", async () => {
    assert.equal(await wrap(async () => undefined)(), undefined);
    assert.equal(wrap(undefined), undefined);
  });
});
