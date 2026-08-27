const fixture = process.env.FIXTURE_URL;

await page.goto(fixture);
await page.waitForLoadState();

const center = await page.elementCenter("loc=css:#click-button");
await page.mouse.click(center.x, center.y, { label: "staying here" });
await page.waitForTimeout(300);

console.log(
  "SEEDED: " +
    (await page.evaluate(
      "!!document.getElementById('ego-agent-cursor-overlay')",
    )),
);
