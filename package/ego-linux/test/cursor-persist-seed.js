const fixture = process.env.FIXTURE_URL;
const task = await taskSpace("cursor-persist");
const page = task.page("p1");

await page.goto(fixture);
await page.waitForLoadState();

const center = await elementCenter("loc=css:#click-button");
await page.mouse.click(center.x, center.y, { label: "staying here" });
await page.waitForTimeout(300);

console.log(
  "SEEDED: " +
    (await page.evaluate(
      "!!document.getElementById('ego-agent-cursor-overlay')",
    )),
);
