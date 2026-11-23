import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectRuntime } from "../src/runtime-select.mjs";

describe("runtime selection", () => {
  it("defaults to v2 when the script names neither API", () => {
    assert.equal(selectRuntime("console.log(1 + 1)", {}), "v2");
    assert.equal(selectRuntime("", {}), "v2");
    assert.equal(selectRuntime("console.log(help())", {}), "v2");
  });

  it("switches to v2 when the script calls taskSpace() or profiles()", () => {
    assert.equal(selectRuntime('const task = await taskSpace("x")', {}), "v2");
    assert.equal(selectRuntime("console.log(await profiles())", {}), "v2");
    assert.equal(selectRuntime("await taskSpace (7)", {}), "v2");
  });

  it("treats every v2 entry point as v2, even beside v1-looking names", () => {
    for (const call of [
      "claimTaskSpace(7)",
      "takeOverTaskSpace(7)",
      "listTaskSpaces()",
    ]) {
      assert.equal(
        selectRuntime(`// was taskSpaces.run\nawait ${call}`, {}),
        "v2",
      );
    }
  });

  it("keeps v2 for a page that the script declares itself", () => {
    const script = [
      'const task = await claimTaskSpace("abc")',
      'const page = task.page("p1")',
      'await page.goto("https://example.com")',
    ].join("\n");
    assert.equal(selectRuntime(script, {}), "v2");
    assert.equal(
      selectRuntime("const { page } = ctx; await page.goto('x')", {}),
      "v2",
    );
    assert.equal(
      selectRuntime("await run(async (page) => page.goto('x'))", {}),
      "v2",
    );
    assert.equal(selectRuntime("pages.map(page => page.label)", {}), "v2");
    assert.equal(selectRuntime("function f(task, page) { page.x }", {}), "v2");
  });

  it("keeps v1 for the page / taskSpaces / browser / site globals", () => {
    assert.equal(
      selectRuntime("await page.goto('https://example.com')", {}),
      "v1",
    );
    assert.equal(
      selectRuntime("await taskSpaces.run('x', async () => {})", {}),
      "v1",
    );
    assert.equal(selectRuntime("await taskSpaces.useOrCreate('x')", {}), "v1");
    assert.equal(selectRuntime("console.log(await browser.tabs())", {}), "v1");
    assert.equal(selectRuntime("await site.run('github', 'x')", {}), "v1");
  });

  it("lets a v2 call win over v1-looking names in the same script", () => {
    assert.equal(
      selectRuntime("const t = await taskSpace('x'); await page.goto('y')", {}),
      "v2",
    );
  });

  it("does not mistake member access or longer names for either marker", () => {
    assert.equal(selectRuntime("obj.taskSpace('x')", {}), "v2");
    assert.equal(selectRuntime("myprofiles()", {}), "v2");
    assert.equal(selectRuntime("task.page('p1').goto('x')", {}), "v2");
    assert.equal(selectRuntime("const homepage = 1; homepage.x", {}), "v2");
    assert.equal(selectRuntime("taskSpaces.list()", {}), "v1");
  });

  it("reads v1's fetch helpers and optional chaining as v1", () => {
    assert.equal(selectRuntime("await fetch.server('/api')", {}), "v1");
    assert.equal(selectRuntime("await fetch.browser('/api')", {}), "v1");
    assert.equal(selectRuntime("await page?.goto('u')", {}), "v1");
    // Node's own fetch() and cdp(), which v2 also has, decide nothing.
    assert.equal(selectRuntime("await fetch('https://x')", {}), "v2");
    assert.equal(selectRuntime("await cdp('Page.reload')", {}), "v2");
  });

  it("counts an array-destructured page as declared", () => {
    assert.equal(
      selectRuntime(
        "const [page] = await Promise.all([task.page('p')]); await page.goto('u')",
        {},
      ),
      "v2",
    );
  });

  it("ignores markers inside comments and strings", () => {
    assert.equal(
      selectRuntime("// open the site. then\nconsole.log('x')", {}),
      "v2",
    );
    assert.equal(selectRuntime('console.log("see the site. ok")', {}), "v2");
    assert.equal(
      selectRuntime(
        "// TODO migrate to taskSpace(name)\nawait page.goto('u')",
        {},
      ),
      "v1",
    );
    assert.equal(
      selectRuntime("console.log('taskSpace(x)'); await page.goto('u')", {}),
      "v1",
    );
    assert.equal(
      selectRuntime("/* taskSpaces.run */ const t = await taskSpace('x')", {}),
      "v2",
    );
    assert.equal(
      selectRuntime("console.log(`${browser.x} and site.`)", {}),
      "v1",
    );
    assert.equal(selectRuntime("console.log(`about the site.`)", {}), "v2");
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
      selectRuntime("console.log(1)", { EGO_BROWSER_RUNTIME: "v1" }),
      "v1",
    );
    assert.equal(
      selectRuntime("await taskSpace('x')", { EGO_BROWSER_RUNTIME: "bogus" }),
      "v2",
    );
  });
});
