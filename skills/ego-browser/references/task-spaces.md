# Task spaces — ownership, handoff, and completion policy

The full contract behind the summary in `SKILL.md`. Read this before any
claim / handoff / takeover / complete edge case.

## Naming and reuse

`nameOrId` can be a task space name, numeric id, or digit-only numeric id
string. String values match `name`/`taskId` first, then digit-only strings fall
back to numeric id. Number values match existing numeric ids only; if no
matching id exists, `taskSpaces.useOrCreate` fails instead of creating a new
space.

Use a short name for the active user goal when creating a new task space. Keep
reusing that task space for follow-up questions, corrections, refinements,
re-checks, and result validation, even if you previously thought the task was
complete. Choose a new task space only when the user clearly starts a separate,
unrelated goal. Prefer using the numeric `id` returned by
`taskSpaces.useOrCreate` (for example, `task.id`) to resume a known task in
later rounds and avoid name collisions.

For any follow-up on the same user goal — including continue, corrections,
retries, validation, user-reported problems, or work after
`taskSpaces.complete(..., { keep: true })` — resume the original task space
first if it still exists. Do not create a new task space for the same goal
unless the user asks for a fresh space, starts an unrelated goal, or the
original space is unavailable after checking. If a new space is necessary,
state why.

When a named space was closed by a sweep, `taskSpaces.useOrCreate(name)`
creates a replacement and attaches `task.previously` with the closed space's
URLs. `task.previously.reason` says which sweep: `'idle'` for a space that did
work and was not returned to, `'abandoned'` for one closed 120 seconds after
opening because the run that created it never navigated. An abandoned closure
carries no URLs, so there is nothing to restore — read
`task.previously.note` and open the target URL yourself. Current builds automatically reopen non-internal `task.previously.urls`
and report them as `task.restoredUrls`. If `task.previously` exists but
`task.restoredUrls` is empty, the replacement remains targetless. Navigate with
`await browser.openOrReuseTab(url)` before app-specific selectors.

After explicit user confirmation, to continue work from an existing user-owned,
inactive, or unassigned task space, use `await taskSpaces.list()` to find the
space, call `await taskSpaces.takeOver(id)` to take ownership and select it,
then use `await browser.listTabs()` and `await browser.switchTab(targetId)` to
select the exact tab before acting. `taskSpaces.claim(id)` remains available
when you only need to transfer ownership without the take-over overlay.

## Linux storage modes

- Default: spaces share the live browser profile, including cookies,
  localStorage, IndexedDB, CacheStorage and service workers.
- `EGO_LINUX_TASK_SPACE_STORAGE=isolated`: each new space gets an isolated
  browser context with a point-in-time cookie copy only.
- `EGO_LINUX_TASK_SPACE_STORAGE=isolated-sync`: keeps the isolated context and
  adds a bounded point-in-time localStorage copy for each HTTP(S) origin before
  its first page scripts run (1000 entries / 256 KiB maximum). If the origin is
  not already open in the default profile, the runtime briefly loads its root in
  an unfocused background source tab, reads storage, then closes it. It does not
  copy IndexedDB, CacheStorage or service-worker state and is not a live sync.

## Ownership policy

Every task space has `ownership: 'agent' | 'agentDelegatedToUser' | 'user'`;
the facades treat user-owned spaces differently:

| Call                                               | When the target space is user-owned                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `taskSpaces.useOrCreate`                           | selects read-only; snapshot, screenshot, and debug only                                                                   |
| `taskSpaces.switch`                                | throws — agent-owned spaces only                                                                                          |
| `taskSpaces.claim`                                 | claims it (ownership transfers to the agent), then selects it                                                             |
| `taskSpaces.handOff`                               | skipped — resolves `{ done: false, skipped: 'user-owned' }`                                                               |
| `taskSpaces.complete(…, { keep: true })`           | skipped — resolves `{ done: false, skipped: 'user-owned' }`                                                               |
| `taskSpaces.complete(…, { keep: false })`          | claims it, then closes it                                                                                                 |
| `taskSpaces.bringToFront(nameOrId, options?)`      | checks its window without focusing by default; `{ focus: true }` is allowed only after an explicit same-turn user request |
| `taskSpaces.requestUserAction(nameOrId, options?)` | preserves ownership; a concrete instruction shows Done/Cancel and sends one notification without focusing                 |
| `taskSpaces.loginPreflight(nameOrId, options?)`    | rejects — autofill inspection/submission requires agent control                                                           |
| `taskSpaces.handleChallenge(nameOrId, options?)`   | rejects — background challenge inspection requires agent control                                                          |
| `taskSpaces.takeOver(nameOrId)`                    | claims it, selects it, then takes over                                                                                    |
| `taskSpaces.waitForAgentControl`                   | waits for it to be handed back without claiming it                                                                        |

`taskSpaces.handOff` and `taskSpaces.complete` resolve `{ done: true }` when
the operation actually happened. `handOff`, and `complete(..., { keep: true })`
on window-aware backends, also include `visible` so you know whether the user
has an open, non-minimized page window. `bringToFront` returns the same visibility
shape without changing ownership or application focus. Check `done` before telling the user the
handoff/cleanup is finished — a `skipped` result usually means you targeted a
space that was never yours.

## Completion and cleanup

For one-round tasks, prefer:

```js
await taskSpaces.run(
  "task name",
  async (task) => {
    // browser work here
  },
  { keep: false, timeout: 8000 },
);
```

When the task has a machine-checkable success condition, prefer the verified
executor:

```js
const out = await taskSpaces.execute("search releases", {
  goal: "return at least one release",
  risk: "read-only",
  retries: { max: 2, delay: 100, on: ["error", "verification"] },
  async work({ attempt, previousVerification }) {
    await page.goto("https://example.com/releases");
    return { attempt, previousVerification };
  },
  async verify() {
    const count = await page.getByRole("article").count();
    return { ok: count > 0, evidence: { count } };
  },
  keep: false,
  timeout: 8000,
});
console.log(JSON.stringify(out, null, 2));
```

`taskSpaces.execute` runs `work → verify`, completes only after verified
success, and returns `{ result, verification, attempts, receipt, completion }`.
`verify` must return a boolean or `{ ok: boolean, ... }`. A final ordinary
error or failed verification leaves the space open and carries
`error.executionReceipt`; a task-space hard stop propagates immediately.
Automatic retry is intentionally narrower than generic retry logic: it
requires `risk: "read-only"`, accepts only `error` / `verification` retry
kinds, and allows at most five retries. `risk: "reversible"` and
`risk: "destructive"` work runs once even when verification fails.

`taskSpaces.run` calls `taskSpaces.useOrCreate` first, temporarily applies
`timeout` as the default helper timeout for the callback, and then calls
`taskSpaces.complete(task.id, { keep })` after the callback succeeds. If the
callback throws, the task space is left open so the failure artifact and the
next retry can inspect the same page. `complete: false` is an escape hatch for
advanced multi-step scripts that want the wrapper's setup and timeout only. If
selection is read-only because the user controls the space, `run` never claims
or closes it automatically and reports
`{ done:false, skipped:'user-owned' }` as its completion.

**`taskSpaces.complete(nameOrId, { keep })` must run only after the result is
captured and verified.** For one-round tasks that do not use `taskSpaces.run`,
completing at the end of the same heredoc is preferred so the browser cannot be
left open after success. For multi-round tasks, use a dedicated final heredoc
after a prior heredoc's output has confirmed the task is genuinely done. `keep`
is required and defaults by policy to `false`: close the task space after
completion unless there is a concrete reason to leave the live page visible.

Use `{ keep: true }` only when the user explicitly asks to keep the page open,
the task needs manual user action in that exact page, or the result cannot be
delivered well as a URL, file, artifact, or summary. Do not keep a task space
open merely because a page was visited, a document was created, or a screenshot
was used for verification.

`complete(nameOrId, { keep: true })` has the same visibility contract as
`handOff`: it resolves `{ done: true, visible, reason? }`. On Linux,
`visible: true` means the managed browser window is open and not minimized; the
agent never focuses or raises it over the user's current app. If `visible: false`,
`reason` is one of `headless`, `no-live-tab`, `minimized`, or
`window-unavailable`. `keep: false` closes the space and resolves `{ done: true }`.

When passing a string that may create a new task space, the string should
reflect the task's intent (e.g. `'search github issues'`); don't use literal
placeholders.

**If the task space needs to be preserved after the task ends, keep only the
tabs that need to be shown to the user.** Keep loose awareness of how many tabs
are open — a quick `(await browser.listTabs()).length` is enough; there's no
need to spend a dedicated round just to check. When scratch tabs (search-result
pages, cross-check pages, and other one-off pages) pile up, close them as you
go rather than letting them all accumulate for the end. When finishing with
`{ keep: true }` to leave pages for the user, clear out the remaining scratch
tabs so only the pages worth showing stay open. Close a single tab with
`await browser.closeTab(targetId)` (`targetId` comes from `browser.listTabs()`
or an `openOrReuseTab` return value).

## Control handoff

Only one side — agent or user — may mutate a task space at any time. While the
user holds control, navigation, input, page evaluation, tab creation, and other
mutations fail with a "user is controlling" message. Do not retry the failed
command or reclaim control. Passive verification is different: a later heredoc
may call `taskSpaces.useOrCreate(nameOrId)` and finish with `page.snapshot()`,
`page.screenshot()`, or `page.debug()` without changing ownership.

A "user is controlling" error is a hard stop for the failed mutation — not an
obstacle to route around. It means the user has deliberately taken the browser
back. Honoring the mutation boundary is the correct outcome; observation may
continue, but pushing the original action forward without confirmation may not.

An "inactive", "not assigned to an agent", or similar task-space error is also
a hard stop with the same confirmation requirement. Resume only after explicit
user confirmation, then start with `await taskSpaces.claim(id)`.

If a script catches browser errors internally, it must rethrow these hard stops
before any retry/continue logic:

```js
if (taskSpaces.isHardStopError(error)) throw error;
```

Swallowing hard-stop errors in a retry loop makes the agent appear stuck even
though the user-control boundary is working correctly.

**Autofilled login is not user intervention**: Before handing off a login page,
call `const login = await taskSpaces.loginPreflight(task.id)`. It waits briefly
for browser/password-manager autofill, returns only booleans and counts, and
submits a uniquely identifiable ready form. It never returns or logs credential
values and never takes focus. If `login.submitted`, verify login success. Use an
explicit CSS selector in `{ submit: "..." }` when the page has multiple submit
controls, or `{ submit: false }` for inspection only. Handoff is only for a
missing credential, CAPTCHA, passkey/hardware interaction, or genuinely human
2FA approval.

**Browser challenges wait before interrupting**: Call
`await taskSpaces.handleChallenge(task.id, options)` when a visible CAPTCHA or
verification page blocks progress. It checks common Cloudflare, hCaptcha, and
reCAPTCHA surfaces without focusing, gives automatic verification a short chance
to finish, recognizes populated Turnstile, hCaptcha, and reCAPTCHA response fields,
then uses one stable action key to show the Done/Cancel panel and notify the user
without focusing while the challenge remains. Done returns control and resumes the agent.

**Requesting user action**: When the task genuinely requires user intervention,
call
`await taskSpaces.requestUserAction(task.id, { instruction, target?, actionKey?,
doneLabel?, cancelLabel? })`. Pass a concrete, non-empty instruction: it is the
content shown in the panel and desktop notification. The helper hands off an
agent-controlled space or preserves a user-owned space, displays an in-page
action card whose controls and decision state live in an isolated browser world,
highlights the optional selector/text target, and waits by default. Page scripts
can remove the card but cannot inspect its closed shadow root or forge Done.
Done explicitly returns control and resumes the agent; Cancel leaves the user in
control. A repeat with the same action key refreshes the panel without focusing
or notifying again. A bare legacy call only hands off/checks visibility. If the
page is not available on screen, Linux sends the notification with the failure
reason and the helper throws rather than pretending the page is visible.

The lower-level `taskSpaces.handOff(nameOrId)` transfers control and checks the
window without activating a tab, restoring a minimized window, or raising the
application. Prefer `requestUserAction` for manual steps because it also handles
already user-owned spaces and enforces the availability check.

**What the user can actually see**: `handOff` and
`complete(..., { keep: true })` resolve
`{ done: true, visible: boolean, reason?: string }`.

| `visible`                                | What it means                                                                                   | What you may say                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `true`                                   | The managed Chrome/Chromium window is open and not minimized; it was not focused automatically. | Ask the user to click the already-open managed browser when convenient. Never claim it was brought to the front. |
| `false` + `reason: "headless"`           | The browser is running headless (`EGO_LINUX_HEADLESS`). There is no window on any display.      | Nothing about clicking. Report that the browser is headless and give the fix below.                              |
| `false` + `reason: "no-live-tab"`        | The task space has no live tab left.                                                            | Nothing about clicking. Reopen the page or start a fresh task space before asking for user action.               |
| `false` + `reason: "minimized"`          | The managed browser window is minimized and was deliberately not restored over the current app. | Ask the user to restore Ego Lite manually when ready.                                                            |
| `false` + `reason: "window-unavailable"` | The port could not confirm an on-screen window without trying to focus it.                      | Ask the user to locate the managed browser manually before acting.                                               |

For `reason: "headless"`, follow `references/install.md` to restart the active
runtime in headed mode. Do not invoke either package by source path or open a
desktop launcher unless `readlink` confirms it is the active runtime. Switching
implementations uses different profile/task-space state. A host restart
closes the current spaces' tabs, so treat work in flight as lost and start the
task again in a fresh space.

A `visible: false` handoff or kept completion is not an error and does not need
to be retried: the ownership change is real, headless is a supported way to run,
and CI hands off with nobody watching. It is only wrong to _narrate_ it as
something the user is looking at. The port also writes a one-line warning to
stderr for handoff in that case, so it shows up in the command output even if
the resolved value goes unread.

**Regaining control**: Take control back _only_ after the user explicitly
confirms — through an Ask (your harness's button/option prompt, e.g. "Continue"
vs "Finish task") or a "continue" message in chat. Then start a new heredoc
with `await taskSpaces.takeOver(nameOrId)` and resume; it automatically claims a
user-owned named/id space before selecting it. If the user chooses to finish,
close out with `await taskSpaces.complete(nameOrId, { keep })`. Never call
`taskSpaces.takeOver` on your own to grab control back — it can seize the browser
away from the user.

**Unexpected takeover**: The user can take over at any time via the browser GUI
— the same effect as the agent calling `taskSpaces.handOff`. Do not retry the
failed operation and do not auto-takeover. If only visual verification remains,
start a new heredoc with `taskSpaces.useOrCreate(nameOrId)` and finish using the
passive observation helpers. Otherwise surface the Ask above (Continue / Finish)
and resume mutation only when the user picks Continue.

**Check without taking control**: If the user already controls the space and you
need to confirm that its window is available, call
`await taskSpaces.bringToFront(nameOrId)`. The legacy name is retained for API
compatibility; without options it never brings the window forward. When the user
explicitly asks to show/raise/focus the existing Ego Lite window, call
`await taskSpaces.bringToFront(nameOrId, { focus: true })`. The higher-level
`requestUserAction(...)` path remains background-only even with an instruction;
it uses the action panel, Inbox, and desktop notification instead.
Do not call `taskSpaces.useOrCreate(nameOrId)` merely to present it: read-only
selection is background-only and intentionally does not replace the user's
current view.

`await taskSpaces.waitForAgentControl(nameOrId)` is a read-only blocking poll
(it never takes control or claims ownership). If the space is user-owned, it
waits until the user hands it back before selecting and probing it; use it only
to wait inside the current heredoc for a handoff you initiated.
