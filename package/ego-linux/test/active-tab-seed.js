const task = await taskSpace("port active-tab persistence");
const page = task.page("p1");
await page.goto(process.env.FIXTURE_URL);
const secondPage = await task.newPage();
await secondPage.goto("data:text/html,<title>Persisted%20second%20tab</title>");
await switchTab(secondPage.targetId);
await page.waitForTimeout(50);
console.log(
  JSON.stringify({
    taskId: task.spaceId,
    active: (await currentTab()).title,
  }),
);
// No finish — the second tab must persist for the resume probe.
