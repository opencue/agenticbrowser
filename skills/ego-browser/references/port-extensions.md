# Port extensions

These features are added by this port on top of the v2 Page and TaskSpace
(`package/ego-v2-ext`); upstream ego lite does not have them.

This port adds four features on top of the v2 Page and TaskSpace. They are not
in upstream ego lite.

**Locators.** `page.locator(selector)` and `page.getByRole(role, { name, exact })`,
`getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`,
`getByTestId` return a strict, auto-waiting Locator (default 8 s). It accepts the
same selectors as Page actions, including the `loc=role:` / `loc=testid:` /
`text=` values a snapshot prints. Chain with `locator()`, `getBy*()`,
`filter({ hasText })`, `first()`, `last()`, `nth(i)`. Actions: `click`,
`dblclick`, `hover`, `focus`, `fill`, `clear`, `press`, `pressSequentially`,
`check`, `uncheck`, `setChecked`, `selectOption`, `setInputFiles`, `dragTo`,
`scrollIntoViewIfNeeded`, `dispatchEvent`, `blur`. Reads: `textContent`,
`innerText`, `innerHTML`, `inputValue`, `getAttribute`, `isChecked`,
`boundingBox`, `evaluate`, `screenshot`, plus non-strict `count`, `isVisible`,
`isHidden`, `isEnabled`, `isDisabled`, `isEditable`, `allInnerTexts`,
`allTextContents`, `evaluateAll`, and `waitFor({ state, timeout })`. A
locator matching 0 or several elements throws with up to five candidates;
narrow it with `filter()` before reaching for `nth()`. Reads on `@ref` selectors
are not supported; actions on them are.

```js
await page.getByRole("button", { name: "Save" }).click();
const n = await page.locator("li.result").count();
await page.getByLabel("Email").fill("user@example.com");
```

**Fast indexed loop.** `page.fastObserve()` returns `{ url, title, text, table,
actions, omitted_actions, w, h, scroll }` in one browser call: visible controls
with ids, names and values. `page.fastAct(obs, id, text?)` runs one entry
(`fill`, `click`, `select`, `scroll`, `wait`) after re-checking that the page
and target are unchanged; otherwise it throws `StalePageError`, so observe
again instead of retrying. Password, file and hidden inputs are never listed;
shadow roots and iframes are not read, so use `page.snapshot()` there.

```js
let obs = await page.fastObserve();
console.log(obs.table);
await page.fastAct(obs, "e2", "search terms");
obs = await page.fastObserve();
```

**`page.debug(options?)`** returns one JSON dump for a stuck task: page info
(URL secrets redacted), a snapshot excerpt, a screenshot path, and recent
navigations, failed requests and HTTP errors. It drains the event buffer. Pass
`{ includeScreenshot: false }` for text only. A part that fails is listed in
`errors` instead of failing the call.

**`task.requestUserAction({ instruction, target?, actionKey?, doneLabel?,
cancelLabel?, wait?, timeout? })`** asks the user for one concrete manual step,
such as a login, passkey or captcha. It hands the space to the user and shows
an in-page action card, which also appears in the Spaces "Needs You" inbox. It
sends one desktop notification per `actionKey` and, by default, waits for Done
or Cancel without taking focus. It throws if the page is not visible (for
example headless), so never ask a user to act on a page they cannot see.
Done returns `{ userResult: "done", resumed: true }` with control back to you;
Cancel returns `{ userResult: "cancel", resumed: false }` and leaves control
with the user. Match the labels to the user's language, for example Hungarian
`doneLabel: "Kész"`, `cancelLabel: "Mégsem"`.

**Login and challenges.**
- `task.loginPreflight(options?)` waits briefly for password-manager autofill.
  When every visible credential field is filled, it submits the single login
  form. It returns `{ detected, ready, needsUser, fieldCount, filledCount,
  submitted }` and never returns field values. Call it before asking the user to
  log in.
- `task.handleChallenge(options?)` detects a visible Cloudflare, hCaptcha or
  reCAPTCHA challenge without taking focus. It waits briefly for the challenge
  to resolve automatically, and only if it stays does it call
  `task.requestUserAction(...)`. It returns `{ detected: false, handled: false
  }`, `{ detected: true, ..., resolvedAutomatically: true }`, or the
  requestUserAction result with `handled: true`.
- Both act on the space's active page. Pass `{ page }` to target another one.

**Network waits.** `page.waitForRequest(urlOrPredicate, { timeout })` and
`page.waitForResponse(urlOrPredicate, { timeout })` match an exact URL string, a
RegExp, or a synchronous predicate. The default timeout is 10 s.
- Start the wait before the action that triggers the request.
- A request resolves to `{ url(), method(), headers(), postData(),
  resourceType() }`.
- A response resolves to `{ url(), status(), statusText(), ok(), headers(),
  request(), body(), text(), json() }`.

```js
const responseP = page.waitForResponse((r) => r.url().includes("/api/save"));
await page.getByRole("button", { name: "Save" }).click();
console.log((await responseP).status());
```

**Recording.**
- `await page.screencast.start({ path, size?, quality? })` starts a video and
  `await page.screencast.stop()` finishes it, within one script. Writing the
  video needs `ffmpeg` (or `EGO_BROWSER_FFMPEG_PATH`).
- `page.trace({ limit?, redact? })` returns the page's recent browser events as
  `{ schema: "ego-browser.trace.v1", createdAt, count, shown, items }`.

**Shared event buffer.** `page.debug()`, `page.trace()`, the network waits and
the screencast all read the page's buffered events, and reading drains them.
Avoid running two of them at the same time on one page.
