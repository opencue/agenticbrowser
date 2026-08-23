const task = await taskSpaces.useOrCreate("port active-tab persistence");
console.log("RESUMED: " + (await browser.currentTab()).title);
await taskSpaces.complete(task.id, { keep: false });
