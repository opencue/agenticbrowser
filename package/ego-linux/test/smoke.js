const fixture = process.env.FIXTURE_URL;

const task = await taskSpace("smoke test");
const page = task.page("p1");

await page.goto(fixture);
await page.waitForLoadState();

const info = await page.info();
console.log("URL:      " + info.url);
console.log("TITLE:    " + info.title);

const tabs = await listTabs();
console.log(
  "TABS:     " +
    tabs.length +
    " (active: " +
    tabs.filter((t) => t.active).length +
    ")",
);

const snap = await snapshotRaw({
  scope: "full_page",
  includeStableLocator: true,
});
console.log("REFS:     " + snap.refs.length);
console.log("--- SNAPSHOT ---");
console.log(snap.content);

await task.finish({ keep: [] });
