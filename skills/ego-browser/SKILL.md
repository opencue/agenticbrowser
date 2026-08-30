---
name: ego-browser
description: >-
  Use when Codex must inspect, verify, test, or automate a site or local web
  app, including opening URLs, filling forms, running login flows, taking
  screenshots, scraping data, or debugging browser UI with Ego Lite.
metadata:
  version: "1.2.6-linux.1"
  date: "2026-08-30"
  platform: "linux-windows-port"
---

> **This is the Linux and Windows port**, not the macOS app: the same harness
> over a stock Chromium via CDP. See `references/install.md`. Task spaces use the live agent
> profile by default, so cookies and non-cookie browser storage carry between
> spaces; use `EGO_LINUX_TASK_SPACE_STORAGE=isolated` only when storage privacy
> matters more than live logins. Use `isolated-sync` for isolated cookies plus a
> point-in-time localStorage login seed. Another thing to know: `EGO_LINUX_HEADLESS` runs
> the browser with no window at all, which makes
> every request for the user to click something impossible to satisfy — see the
> visibility rule under Task spaces.

> **Routing invariant:** use the `ego-browser` CLI for every browser task. Never
> fall back to Codex's Browser/Chrome plugins, a Chrome-extension automation
> tool, or a direct Chrome/Playwright launch. On Linux and Windows the Ego host may use
> Chrome/Chromium as its managed engine; that process is expected and must still
> be reached through `ego-browser`.

> **Port runtime identity:** this fork's supported runtime is
> `package/ego-linux`; its CLI, desktop `--spaces` launcher, profile, and
> Task Space state belong together. Resolve the CLI with
> `readlink -f "$(command -v ego-browser)"` on Linux or
> `(Get-Command ego-browser).Source` on Windows, and never substitute the
> experimental `package/ego-linux-host`, which uses different state. Both drive
> stock Chrome/Chromium; neither creates the native Citro/macOS Ego Lite
> shell. Present tasks only through `taskSpaces`.

# ego-browser

ego-browser gives AI agents a CLI-accessible Node.js runtime with a Playwright-style
API — `page`, `browser`, `taskSpaces`, `site`, `fetch`, `cdp` — that agents call
directly inside JS scripts to observe pages, interact with UI, evaluate browser-side
JavaScript, and drive a real browser for any web automation task.

For setup, install, or connection problems, read `references/install.md`.

Run all browser operations through stdin: use `ego-browser nodejs <<'EOF' ...
EOF` with a POSIX shell, or `@' ... '@ | ego-browser nodejs` with PowerShell.
Do not write code to a `.js` file first.

## Prerequisites

Install-time only — skip if `ego-browser` already answers. Setup is in `references/install.md`.

- `ego-browser` — the CLI resolved from `PATH`; verify its target with
  `readlink -f "$(command -v ego-browser)"` on Linux or
  `(Get-Command ego-browser).Source` on Windows rather than assuming which
  implementation is active
- `node` >= 22 — runs both the harness build and each heredoc
- Chrome, Chromium, Brave, or Edge — Windows searches standard installation
  paths; Linux resolves the browser from `PATH`

## Quick start

```bash
ego-browser nodejs <<'EOF'
// taskSpaces.run is the safe default for a one-round browser task:
// it selects/creates the task space and completes it on success.
await taskSpaces.run('inspect example page', async (task) => {
  console.log('task space id: ' + task.id)
  page.setDefaultTimeout(8000)

  await page.goto('https://example.com', { waitUntil: 'load' })

  console.log(await page.snapshot())
})
EOF
```

PowerShell runs the same script without WSL:

```powershell
@'
await taskSpaces.run('inspect example page', async (task) => {
  console.log('task space id: ' + task.id)
  page.setDefaultTimeout(8000)
  await page.goto('https://example.com', { waitUntil: 'load' })
  console.log(await page.snapshot())
})
'@ | ego-browser nodejs
```

The heredoc body runs as a Node.js script that controls the selected ego-browser task space. The API objects are preloaded into that script — do not import anything. Before outputting a script, self-check that every browser operation is called through `page.*`, `browser.*`, `taskSpaces.*`, `site.*`, `fetch.*`, or `cdp(...)`; standalone calls such as `load(...)`, `snapshot(...)`, `goto(...)`, `navigate(...)`, `waitForLoad(...)`, `currentUrl(...)`, and `js(...)` are invalid.

## API surface

Everything hangs off six preloaded globals. There are **no flat helper functions**:
`load()`, `snapshot()`, `goto()`, `navigate()`, `waitForLoad()`, `currentUrl()`,
`js()`, `snapshotText()`, `click()`, `fillInput()`, `cliLog()` and friends were
removed from the harness, and calling one raises `ReferenceError: … is not
defined`. Do not invent aliases: use `page.goto(...)` for navigation,
`page.snapshot()` for semantic snapshots, `page.waitForLoadState(...)` for load
waits, `page.url()` for the current URL, and `page.evaluate(...)` for page-side
JS.

| Global       | Members                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`       | `goto`, `reload`, `info`, `url`, `title`, `snapshot`, `snapshotRaw`, `screenshot`, `debug`, `trace`, `evaluate`, `locator`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId`, `waitForTimeout`, `waitForLoadState`, `waitForSelector`, `waitForFunction`, `waitForURL`, `waitForRequest`, `waitForResponse`, `waitForEvent`, `setDefaultTimeout`, `elementCenter`, `drainEvents`, `screencast`, `keyboard`, `mouse` |
| `browser`    | `listTabs`, `currentTab`, `switchTab`, `openOrReuseTab`, `closeTab`, `ensureRealTab`, `iframeTarget`                                                                                                                                                                                                                                                                                                                                                                       |
| `taskSpaces` | `execute`, `run`, `useOrCreate`, `list`, `switch`, `new`, `claim`, `complete`, `handOff`, `bringToFront`, `requestUserAction`, `loginPreflight`, `handleChallenge`, `takeOver`, `waitForAgentControl`, `isHardStopError`                                                                                                                                                                                                                                                   |
| `site`       | `skills`, `skillsForUrl`, `runTool`, `runBrowserTool`, `learnContext`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fetch`      | `fetch.server(url, options)` (Node-side), `fetch.browser(url, options)` (page origin)                                                                                                                                                                                                                                                                                                                                                                                      |
| `cdp`        | `cdp(method, params?, sessionId?, timeoutMs?)` — raw CDP for anything the facades don't cover                                                                                                                                                                                                                                                                                                                                                                              |

Notes:

- `console.log(value)` is the output channel — it is routed to the terminal sink. There is no `cliLog`.
- `await page.info()` — resolves to `{ url, title, w, h, sx, sy, pw, ph }`; if a native browser dialog is open it resolves to `{ dialog: ... }` instead, because page JavaScript is blocked.
- If `await page.info()` resolves to `{ dialog: ... }`, handle it with `await cdp('Page.handleJavaScriptDialog', { accept: true })` before running page JavaScript.
- `await page.url()` is **async** — always await it before using the string.
- `await browser.ensureRealTab()` — switches to an existing non-internal page tab if needed and resolves to it; resolves to `null` when none exists. It does not create a tab — use `await browser.openOrReuseTab(...)` for that.
- `await browser.closeTab(target?)` — closes the given target id / tab object, or the current tab when omitted.
- `await page.drainEvents()` — consumes and returns the async event queue produced by the page.
- `await page.debug()` — returns a JSON-serializable debug dump for agents: redacted page info, tabs, a viewport snapshot excerpt, screenshot path, session state, and recent CDP event summaries. It drains events. Use `await page.debug({ includeScreenshot: false })` for text-only debugging.
- `await page.trace()` drains a compact chronological timeline of CDP requests, responses, errors, and browser events. Use it after a failed click, fill, navigation, or wait to see what happened before retrying.
- On uncaught ordinary errors, the CLI writes a redacted local JSON failure artifact and prints `ego-browser: failure artifact written to ...` on stderr. Open that file before retrying. Read `recovery.readThisFirst` first, then inspect `error.message`, locator diagnostics, `debug.trace.items`, `debug.snapshot.excerpt`, and the screenshot path in that order. Hard-stop user-control errors skip this artifact so the control handoff guidance stays clean.
- `help()` prints the built-in reference; `console.log(help())` is the fastest way to re-check a signature.
- Print values with `console.log(value)` or `JSON.stringify(value, null, 2)`. Do not call `.toString()` on unknown `page.evaluate` / helper results; some page data shadows that method. `page.screenshot()` returns a file path; read the file first if you need `buffer.toString('base64')`.

### Locators

`page.locator(selector)` returns a strict, auto-waiting locator. It accepts raw CSS,
`xpath=…`, `@N` / `ref=N`, and the `loc=…` values printed by `page.snapshot()`
(`loc=css:…`, `loc=role:…`, `loc=href:…`). `@N` refs work in locators only — they are
not valid inside `document.querySelector(...)`. `loc=testid:foo` matches
`data-testid="foo"` exactly by default, matching `page.getByTestId("foo")`.

Locator methods: `first`, `last`, `nth`, `locator`, `getByRole`, `getByText`,
`getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId`,
`filter`, `click`, `dblclick`, `hover`, `dragTo`, `scrollIntoViewIfNeeded`, `focus`,
`fill`, `clear`, `press`, `pressSequentially`, `check`, `uncheck`, `setChecked`,
`selectOption`, `setInputFiles`, `dispatchEvent`, `blur`, `textContent`, `innerText`,
`innerHTML`, `inputValue`, `isChecked`, `isVisible`, `isHidden`, `isEnabled`,
`isDisabled`, `isEditable`, `getAttribute`, `boundingBox`, `screenshot`, `count`,
`allInnerTexts`, `allTextContents`, `evaluate`, `evaluateAll`, `waitFor`.

```js
await page.locator("@21").click();
await page.locator("button.primary").click();
await page.locator('loc=role:textbox[name="Search"]').fill("ego lite");
await page.getByTestId("settings__visibilityToggle__topics-/map").click();
await page.getByRole("link", { name: "Learn more" }).click();
await page
  .locator('input[type="file"]')
  .setInputFiles("/absolute/path/to/file.pdf");
```

Narrow multiple matches with `filter()`; reach for `first()` / `nth()` only for
confirmed legitimate duplicates.

When a locator matches 0 or multiple elements, ego-browser appends `Locator
diagnostics:` with visible candidate elements and copyable `loc=...` selectors.
Copy one of those suggestions before guessing at CSS or adding `nth()`.

### Scroll / mouse / keyboard

```js
// scroll an element into view
await page.locator("@42").scrollIntoViewIfNeeded();

// real wheel event, and raw coordinate input (CSS pixels)
await page.mouse.wheel(0, 900);
await page.mouse.click(420, 260); // agent-style-ok: visual workflow coordinate example
await page.mouse.drag(from, to);
await page.mouse.drag([from, mid, to]);

await page.keyboard.press("Enter");
await page.keyboard.type("hello");
await page.keyboard.insertText("pasted text");
```

`page.mouse` has `click`, `dblclick`, `move`, `down`, `up`, `wheel`, `drag`;
`page.keyboard` has `press`, `down`, `up`, `insertText`, `type`.

### page.evaluate

`page.evaluate` accepts an expression string or a function, and returns the real
value — not a JSON string. A top-level `return` in a string is auto-wrapped.

```js
const data = await page.evaluate(String.raw`(() => {
  return {
    title: document.title,
    href: location.href,
    readyState: document.readyState,
  }
})()`);
```

When you need multi-step logic inside the browser, wrap it in a single self-invoking
closure and return once — don't split it across several `page.evaluate` calls. Note
that a function passed here is stringified, so closures are not captured.

### Task spaces

A task space is an owned set of tabs in the live agent profile by default, so agents operate on authenticated sites with cookies, `localStorage`, IndexedDB and service-worker state intact. Ownership is `agent` / `agentDelegatedToUser` / `user`, and only one side drives a space at a time.

The rules that matter every round:

- For one-round tasks, prefer `taskSpaces.run(nameOrId, async task => { ... }, { keep: false, timeout: 8000 })`. It selects or creates the space, temporarily narrows helper timeouts, and calls `complete(..., { keep: false })` after the callback succeeds. If selection is read-only because the user controls the space, it skips automatic completion instead of claiming or closing the user's page.
- When success needs a postcondition instead of “the callback returned”, use `taskSpaces.execute(nameOrId, { risk, work, verify, retries?, keep?, timeout? })`. `verify` must return `true` / `false` or `{ ok: boolean, ...evidence }`; the space completes only after `ok: true`. Automatic retry is allowed only with explicit `risk: "read-only"` and is capped at five retries. Use `risk: "reversible"` or `"destructive"` for mutations; those always run once, so a failed verification cannot duplicate a send, publish, delete, or checkout.
- For multi-round tasks, start every working heredoc with `taskSpaces.useOrCreate(nameOrId)` — the Node runtime exits between heredocs; the space is what persists. Prefer the numeric `task.id` over names across rounds. If the user controls the space, this selects it without claiming in passive observation mode: `page.snapshot()`, `page.screenshot()`, and `page.debug()` remain available, while navigation/input/evaluation and other mutations remain blocked.
- **Check `task.previously` on the returned space.** A space left untouched long enough is closed automatically, and asking for that name afterwards gives you a replacement space. When that has happened, `previously` carries a `note` and the `urls` the old space had open. Current builds automatically reopen non-internal `previously.urls` and set `task.restoredUrls`; if no URLs were recoverable, navigate with `browser.openOrReuseTab(...)` before using app selectors.
- One user goal = one space, reused for every follow-up (corrections, re-checks, validation). A new space only when the user starts a clearly unrelated goal.
- New port task spaces are targetless: creation opens no blank/ready tab. The first `page.goto(url)` or `browser.openOrReuseTab(url)` creates the tab directly at that URL.
- Use `ego-browser --spaces` when a human needs to inspect, resume,
  explicitly inspect, or close Task Spaces. Managed browser windows may remain
  visible so the user can watch agent work. Ordinary agent work never focuses
  them automatically; an instructed `requestUserAction(...)` is the deliberate
  exception when the agent is blocked on a required human step.
- Finish with `taskSpaces.complete(nameOrId, { keep })` unless `taskSpaces.run(...)` is already doing that for you. For one-round tasks not using `run`, call `complete` at the end of the same heredoc after you have captured/logged the verified result. For multi-round tasks, call it in a dedicated final heredoc only after a prior round confirmed the task is done. `keep: false` unless the user needs that exact live page open. If `keep: true`, read the returned `{ visible }` before saying the page was left open for the user to view.
- **Autofilled login is authorized and code-enforced.** Before requesting user action on a login page, call `const login = await taskSpaces.loginPreflight(task.id)`. It waits briefly for password-manager autofill, returns only booleans/counts, and submits a uniquely identifiable ready login form without exposing credential values or taking focus. If `login.submitted`, verify success; do not ask permission. Use `{ submit: "css selector" }` only when the page has multiple submit controls, or `{ submit: false }` to inspect without submitting.
- CAPTCHA or browser verification → call `taskSpaces.handleChallenge(task.id, options)`. It detects common visible Cloudflare, hCaptcha, and reCAPTCHA challenges without focusing, waits briefly for automatic completion, and invokes the one-shot manual action flow only if the blocker remains.
- Missing login input, passkey/hardware interaction, or another genuinely human confirmation → call `taskSpaces.requestUserAction(task.id, { instruction, target?, actionKey?, doneLabel?, cancelLabel? })`. **A non-empty concrete instruction is mandatory for automatic focus.** It shows an in-page action card whose decision state is isolated from page JavaScript, persists the same blocker in the Spaces **Needs You** Inbox, highlights the optional target, focuses only once for that action key, and waits by default. Match the labels and instruction language to the user (Hungarian: `doneLabel: "Kész"`, `cancelLabel: "Mégsem"`). Done explicitly returns control and resumes automatically; Cancel keeps user control and returns `{ resumed:false }`. Supply a stable `actionKey` so process retries reuse the pending Inbox request instead of creating another.
- **Never steal application focus during autonomous work.** Task-space creation, navigation, tab switching, snapshots, ordinary handoff, `complete(..., { keep: true })`, and a bare `requestUserAction(nameOrId)` leave the user's current app focused. Only `requestUserAction(...)` with a non-empty instruction, or `bringToFront(..., { focus: true })` after an explicit user request to show the browser, may focus it.
- On Linux Wayland desktops, headed Ego Lite uses XWayland plus `xdotool` so that explicit focus targets only the managed browser PID. Setting `EGO_LINUX_WINDOW_BACKEND=wayland` forces native Wayland and may make focused presentation fail safely with `raise-failed` because the compositor rejects focus without a fresh user activation token.
- `taskSpaces.bringToFront(nameOrId)` is retained for focus-protected availability checks; `{ focus: true }` is the explicit user-authorized presentation path. Repeating the same `requestUserAction(...)` `actionKey` refreshes the panel without focusing again. If focused presentation fails, Linux sends a best-effort desktop notification and refuses to pretend the page is visible.
- On this port, normal agent selection, tab switching, input, snapshots, and `page.screenshot()` stay on the agent's background target and do not replace the task-space tab the user is viewing. Screenshots capture the attached page even while that tab is hidden. Only an instructed `requestUserAction(...)`, an explicit human desktop action, or a user-authorized `bringToFront(..., { focus: true })` may focus the managed browser.
- **Never assume the user can see the browser.** Prefer `requestUserAction`, which rejects a hidden page. The lower-level `handOff`, `bringToFront`, and `complete(..., { keep: true })` resolve `{ done: true, visible, reason? }`; on Linux `visible: true` means the managed browser window is open and not minimized, not that it was focused or placed over the current app. On `visible: false`, use `reason`: `headless` → restart the active runtime headed as documented in `references/install.md`; `no-live-tab` → reopen the page or start a fresh space; `minimized` → ask the user to restore Ego Lite manually; `window-unavailable` → ask the user to locate the managed browser manually. Never switch between `package/ego-linux` and `package/ego-linux-host` during an active task, and never use a desktop launcher as an unverified fallback. The same rule covers screenshots — you read those files, the user does not.
- **Port caveat**: default spaces share browser storage with each other. Set `EGO_LINUX_TASK_SPACE_STORAGE=isolated` before creating a space for cookie-only seeding with the strongest storage boundary. Use `isolated-sync` when a login also depends on localStorage: it copies up to 1000 entries / 256 KiB for each HTTP(S) origin before its first scripts run, briefly loading an unfocused background source tab when that origin is not already open. Both are point-in-time copies; IndexedDB, CacheStorage and service workers remain isolated.

### Agent-safe loop guard

When catching errors inside a browser script, first rethrow task-space hard stops:

```js
try {
  await page.locator("button.save").click();
} catch (error) {
  if (taskSpaces.isHardStopError(error)) throw error;
  // Now handle normal page/selector failures, with a bounded retry or a screenshot.
}
```

Hard stops mean the user controls or ended the space. Retrying the failed command
is what makes agents look stuck. A later heredoc may reselect a user-controlled
space only for snapshot/screenshot/debug verification; it must not route around
the mutation boundary. Also keep each round bounded: set a reasonable
`page.setDefaultTimeout(...)`, avoid open-ended `while (true)` retry loops, and
avoid `networkidle` waits unless the site actually needs them and the timeout is
explicit.
`taskSpaces.run(...)` does this for its wrapper boundary, but callback-level
`catch` blocks still need the guard above.
`taskSpaces.execute(...)` applies the same hard-stop rule itself and returns a
compact execution receipt. It does not make mutating work retryable.

**Before acting on any claim / handoff / takeover / complete edge case, read `references/task-spaces.md`** — it carries the full ownership table, the `{ done, skipped }` result contract, the keep/cleanup policy, and the recovery flow for "user is controlling" and unassigned-space errors.

## Recommended workflow

ego-browser has three main workflows. Pick the workflow that fits the page and task before acting.

Use the semantic workflow first for ordinary websites with real DOM controls. For canvas-like productivity apps and rich editors — including Google Docs, Google Sheets, Lark/Feishu Docs, Notion, Figma, whiteboards, maps, and other virtualized editors — use the visual workflow first for the main editing surface. These apps often expose toolbars, title inputs, hidden textareas, offscreen iframes, or canvas layers in the DOM that do not represent the actual user-editable document or grid. Do not rely on `locator.fill(...)`, DOM selectors, or `page.snapshot()` refs for the main editing surface unless a small write probe proves the text lands in the intended place.

Before writing substantial content into a rich editor, perform a tiny write probe, then verify it with `await page.screenshot()`, an export/readback path, or another reliable visual/state check. If the probe appears in the title bar, toolbar search, hidden input, or any wrong field, stop using DOM/input helpers for that surface and switch to screenshot-guided mouse actions plus real keyboard operations.

1. **Semantic workflow: `page.snapshot()` + refs / locators** — default for most pages with normal text, links, buttons, forms, tables, and lists.
   - For one-round tasks, wrap the workflow in `await taskSpaces.run(name, async task => { ... })`; for multi-round tasks, reuse or create a task space with `const task = await taskSpaces.useOrCreate(name)`.
   - Open or switch pages with `await browser.openOrReuseTab(url)`; use `await page.goto(url, { waitUntil: 'load' })` when navigating inside the current tab.
   - Observe with `await page.snapshot()` to get a full-page semantic tree annotated with `[ref=N, loc=..., url=...]`.
   - Act with `await page.locator('@N').click()`, `await page.locator('@N').fill(...)`, or stable `loc=...` values. Use `page.evaluate` only when it is simpler than a locator.
   - After meaningful clicks, input, or navigation, observe again with `await page.snapshot()`, `await page.info()`, or `await page.screenshot()` before assuming success.

2. **Visual workflow: `await page.screenshot()` + coordinate/keyboard actions** — use when the page is primarily visual, canvas-like, heavily virtualized, or when accessibility / semantic structure is incomplete.
   - Inspect the screenshot, act with viewport coordinates such as `await page.mouse.click(x, y)`, `await page.keyboard.press(...)`, and `await page.keyboard.type(...)`, then verify with another screenshot or a reliable export/readback path.
   - Prefer this path for rich editors, spreadsheets, visual menus, map/canvas UIs, drag interactions, and targets that are obvious visually but poor in the DOM/AX tree.

3. **Direct DOM / CDP workflow: `await page.evaluate(...)` / `await cdp(...)`** — use when you need browser state, compact data extraction, custom DOM traversal, or raw browser capabilities.
   - Keep browser-side logic in one explicit IIFE and return once.
   - Use `await cdp(...)` for browser protocol operations that the facades do not cover.

These workflows can be combined. A task may take multiple heredoc rounds when the next step depends on fresh page state or user handoff. In each round, write a coherent script that advances the task: observe, act or extract, verify, report with `console.log(...)`, and close the task space when the goal is complete. Avoid tiny probe scripts, but don't force the whole task into one oversized script.

## Caveats

- Timeouts are in **milliseconds**, Playwright-style: `await page.waitForTimeout(1500)` waits 1.5 s. (The removed flat API used seconds; do not carry that habit over.) <!-- agent-style-ok: timeout caveat -->
- `await page.screenshot()` returns a **file path string**, not image bytes. Read the file if you need the image. On this port, generated screenshots, failure artifacts, and temporary download directories expire after 24 hours; `EGO_BROWSER_ARTIFACT_TTL_HOURS` changes the lifetime and `0` disables cleanup. Explicit output paths are never swept.
- `page.snapshot()` defaults to the whole page. Reach for `{ scope: 'only_within_viewport' }` when the task only needs what is on screen — it is now the cheapest lever by a wide margin, and it no longer costs you refs. Measured on a 200-card listing (10000 px tall against an 800 px viewport): viewport scope cuts the output **−92%** (40k → 3.3k chars, 600 → 51 lines) while keeping **all 200 refs** addressable. The other two flags trade tokens for capability: `includeStableLocator: false` removes the `loc=` values that survive across rounds, and `includeActionMarks: false` removes the annotations telling you what is actionable. What viewport scope still costs is _sight_, not addressability — you will not read anything below the fold, so use the full page when you need to reason about content you have not seen. Repeatedly snapshotting the same page is better solved by a site skill under `learnings/`, which returns extracted data instead of a tree.
- `@N` refs are only valid for the most recent `page.snapshot()` call — every call rebuilds the refMap. Ref numbers come from the CDP `backendNodeId`, so the same element keeps the same number across calls; but to use `@N`, N must appear in the latest snapshot's refMap. A DOM re-render drops refs. Scrolling and `scope: 'only_within_viewport'` do **not**: every interactive element joins the refMap wherever it sits on the page, so `@N` still resolves for a button below the fold even though its line was not rendered. For elements you need long-term, use the `loc=...` value as a stable selector, or write a CSS selector directly.
- `page.evaluate()` returns the evaluated value, not a JSON string — don't wrap it with `JSON.parse(...)`.
- Inside a `page.evaluate` template string, regex backslashes must be doubled (e.g. `\\d`, `\\s`), or use `String.raw`.
- Code in the heredoc body runs in Node.js; code inside `page.evaluate(...)` runs in the browser page. Navigation, waits, and `console.log(...)` belong in the heredoc body; `document`, `window`, and page selectors belong inside `page.evaluate(...)`.
- If `await page.info()` reports `w: 0` or `h: 0`, do not continue coordinate actions or screenshots until the viewport is fixed. Try switching to the real tab, reloading, or using CDP viewport metrics, then verify with `await page.info()` and `await page.screenshot()`.
- Always call `taskSpaces.complete(name, { keep })` when the task is done — or use `taskSpaces.run(...)` so successful one-round tasks are completed automatically. Do not leave the space hanging. Default to `{ keep: false }`; use `{ keep: true }` only for the concrete live-page cases described in Task spaces. Do not send the final chat answer before a successful cleanup call, unless the user explicitly asked to keep the live page.
- At the actual end of the user task, after the last browser round, always run `ego-browser --cleanup-session`. It closes any remaining agent-owned spaces created by the current session and stops only recognised Next, Vite, or React development servers carrying that exact session id. It skips spaces handed to the user, manually created spaces, and other agents' processes. Do not run it between rounds of an active multi-round task or while waiting for user control.
- When the user explicitly asks to use ego-browser, assume both `ego-browser` and the repo runtime are ready. Do not pre-check `which ego-browser`, `node -v`, package metadata, or help output. Only investigate environment issues if the first run produces an error.
- If the first run reports `command not found` / a missing environment, or the user explicitly asks to install ego lite, read `references/install.md` and follow its flow to complete the install, then return to the original task — do not give up, and do not keep retrying the same heredoc.
