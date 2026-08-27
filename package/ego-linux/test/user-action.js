const task = await taskSpaces.useOrCreate("user action overlay e2e");
await page.goto(process.env.FIXTURE_URL, { waitUntil: "load" });

const shown = await ego.showUserAction({
  key: "approve-test",
  instruction: "Click the highlighted control, then choose Done.",
  target: { selector: "#click-button" },
  doneLabel: "Done",
  cancelLabel: "Cancel",
});
console.log("1. shown: " + JSON.stringify(shown));

const panel = await page.evaluate(() => {
  const host = document.getElementById("ego-user-action-overlay");
  if (host?.__egoAction) {
    host.__egoResult = {
      key: host.__egoAction.key,
      result: "done",
      at: Date.now(),
    };
  }
  return {
    visible: Boolean(host),
    shadowAccessible: Boolean(host?.__egoShadow),
    actionAccessible: Boolean(host?.__egoAction),
  };
});
console.log("2. panel: " + JSON.stringify(panel));

const { frameTree } = await cdp("Page.getFrameTree");
const { executionContextId } = await cdp("Page.createIsolatedWorld", {
  frameId: frameTree.frame.id,
  worldName: "ego-lite-user-action-v1",
});
await cdp("Runtime.evaluate", {
  contextId: executionContextId,
  expression:
    'document.getElementById("ego-user-action-overlay")?.__egoShadow?.getElementById("done")?.click()',
});
console.log(
  "3. result: " +
    JSON.stringify(
      await ego.waitForUserAction({
        key: "approve-test",
        timeoutMs: 1000,
        pollMs: 10,
      }),
    ),
);

await ego.clearUserAction("approve-test");
console.log(
  "4. cleared: " +
    (await page.evaluate(
      () => document.getElementById("ego-user-action-overlay") === null,
    )),
);
await taskSpaces.complete(task.id, { keep: false });
