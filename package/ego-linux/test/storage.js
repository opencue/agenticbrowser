const fixture = process.env.FIXTURE_URL;
const key = "ego-live-storage-" + Date.now();
const value = "from-first-space";

const first = await taskSpaces.useOrCreate("storage parity one");
await page.goto(fixture);
await page.waitForLoadState();
await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
  key,
  value,
});
console.log(
  "1. first read:   " +
    (await page.evaluate((key) => localStorage.getItem(key), key)),
);

const second = await taskSpaces.useOrCreate("storage parity two");
await page.goto(fixture);
await page.waitForLoadState();
console.log(
  "2. second read:  " +
    (await page.evaluate((key) => localStorage.getItem(key), key)),
);

await taskSpaces.complete(second.id, { keep: false });
await taskSpaces.complete(first.id, { keep: false });
