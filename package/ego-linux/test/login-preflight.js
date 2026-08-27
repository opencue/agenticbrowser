const task = await taskSpaces.useOrCreate("login preflight e2e");
const html = `<!doctype html><title>Login preflight</title>
  <form onsubmit="event.preventDefault(); document.body.dataset.submitted='yes'">
    <input type="email" autocomplete="username" value="saved@example.test">
    <input type="password" autocomplete="current-password" value="saved-secret">
    <button type="submit">Sign in</button>
  </form>`;
await page.goto("data:text/html," + encodeURIComponent(html), {
  waitUntil: "load",
});
const result = await taskSpaces.loginPreflight(task.id, {
  waitForAutofill: 0,
});
console.log("1. preflight: " + JSON.stringify(result));
console.log(
  "2. submitted: " +
    (await page.evaluate(() => document.body.dataset.submitted === "yes")),
);
await taskSpaces.complete(task.id, { keep: false });
