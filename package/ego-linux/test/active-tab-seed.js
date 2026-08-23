const task = await taskSpaces.useOrCreate("port active-tab persistence");
await page.goto(process.env.FIXTURE_URL);
const second = await browser.openOrReuseTab(
  "data:text/html,<title>Persisted%20second%20tab</title>",
);
await browser.switchTab(second.targetId);
await page.waitForTimeout(50);
console.log(JSON.stringify({ taskId: task.id, active: (await browser.currentTab()).title }));
