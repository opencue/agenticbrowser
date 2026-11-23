const fixture = process.env.FIXTURE_URL;
const key = "ego-live-storage-" + Date.now();
const value = "from-first-space";

const first = await taskSpace("storage parity one");
const firstPage = first.page("p1");
await firstPage.goto(fixture);
await firstPage.waitForLoadState();
await firstPage.evaluate(({ key, value }) => localStorage.setItem(key, value), {
  key,
  value,
});
console.log(
  "1. first read:   " +
    (await firstPage.evaluate((key) => localStorage.getItem(key), key)),
);

const second = await taskSpace("storage parity two");
const secondPage = second.page("p1");
await secondPage.goto(fixture);
await secondPage.waitForLoadState();
console.log(
  "2. second read:  " +
    (await secondPage.evaluate((key) => localStorage.getItem(key), key)),
);

await second.finish({ keep: [] });
await first.finish({ keep: [] });
