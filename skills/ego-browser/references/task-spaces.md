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

After explicit user confirmation, to continue work from an existing user-owned,
inactive, or unassigned task space, use `await taskSpaces.list()` to find the
space, call `await taskSpaces.claim(id)` to take ownership and select it, then
use `await browser.listTabs()` and `await browser.switchTab(targetId)` to
select the exact tab before acting.

## Ownership policy

Every task space has `ownership: 'agent' | 'agentDelegatedToUser' | 'user'`;
the facades treat user-owned spaces differently:

| Call | When the target space is user-owned |
|---|---|
| `taskSpaces.switch` | throws — agent-owned spaces only |
| `taskSpaces.claim` | claims it (ownership transfers to the agent), then selects it |
| `taskSpaces.handOff` | skipped — resolves `{ done: false, skipped: 'user-owned' }` |
| `taskSpaces.complete(…, { keep: true })` | skipped — resolves `{ done: false, skipped: 'user-owned' }` |
| `taskSpaces.complete(…, { keep: false })` | claims it, then closes it |
| `taskSpaces.takeOver` / `waitForAgentControl` | no ownership check |

`taskSpaces.handOff` and `taskSpaces.complete` resolve `{ done: true }` when
the operation actually happened. `handOff`, and `complete(..., { keep: true })`
on window-aware backends, also include `visible` so you know whether the user
can actually see the page. Check `done` before telling the user the
handoff/cleanup is finished — a `skipped` result usually means you targeted a
space that was never yours.

## Completion and cleanup

For one-round tasks, prefer:

```js
await taskSpaces.run('task name', async (task) => {
  // browser work here
}, { keep: false, timeout: 8000 })
```

`taskSpaces.run` calls `taskSpaces.useOrCreate` first, temporarily applies
`timeout` as the default helper timeout for the callback, and then calls
`taskSpaces.complete(task.id, { keep })` after the callback succeeds. If the
callback throws, the task space is left open so the failure artifact and the
next retry can inspect the same page. `complete: false` is an escape hatch for
advanced multi-step scripts that want the wrapper's setup and timeout only.

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
`handOff`: it resolves `{ done: true, visible, reason? }`. Only `visible: true`
means the kept page was raised on a screen for the user to review. If
`visible: false`, `reason` is one of `headless`, `no-live-tab`, or
`raise-failed`. `keep: false` closes the space and resolves `{ done: true }`.

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

Only one side — agent or user — holds control of a task space at any time.
While the user holds control, any browser operation by the agent fails with a
"user is controlling" message — do not retry it; follow the steps below to
resume.

A "user is controlling" error is a hard stop on the whole task — not an
obstacle to route around. It means the user has deliberately taken the browser
back, often because your current approach is going wrong. Honoring it *is* the
correct outcome here; pushing the goal forward anyway is the failure. The only
thing you may do is **ask the user and wait**.

An "inactive", "not assigned to an agent", or similar task-space error is also
a hard stop with the same confirmation requirement. Resume only after explicit
user confirmation, then start with `await taskSpaces.claim(id)`.

If a script catches browser errors internally, it must rethrow these hard stops
before any retry/continue logic:

```js
if (taskSpaces.isHardStopError(error)) throw error
```

Swallowing hard-stop errors in a retry loop makes the agent appear stuck even
though the user-control boundary is working correctly.

**Handing off**: When the task requires user intervention (e.g. login, captcha,
manual confirmation), call `await taskSpaces.handOff(nameOrId)` to give control
to the user, and tell them exactly what to do. Omitting `nameOrId` uses the
currently selected task space; pass `task.id` across heredoc rounds to avoid
ambiguity. The handoff selects the space's tab, restores the window if it was
minimized, and raises it — the user has to find that window on their own desktop,
and a browser buried behind an editor looks identical to nothing happening.

**What the user can actually see**: `handOff` and
`complete(..., { keep: true })` resolve
`{ done: true, visible: boolean, reason?: string }`.

| `visible` | What it means | What you may say |
|---|---|---|
| `true` | The browser has a window and the space's page was raised on it. | Ask for the click, the login, the captcha. Still describe *where* to look ("the ego lite window"), because it may have opened on another workspace. |
| `false` + `reason: "headless"` | The browser is running headless (`EGO_LINUX_HEADLESS`). There is no window on any display. | Nothing about clicking. Report that the browser is headless and give the fix below. |
| `false` + `reason: "no-live-tab"` | The task space has no live tab left. | Nothing about clicking. Reopen the page or start a fresh task space before asking for user action. |
| `false` + `reason: "raise-failed"` | The browser has a window, but the port could not bring it to the front. | Ask the user to open the ego lite browser window manually before acting. |

The fix to hand the user for `reason: "headless"`: unset
`EGO_LINUX_HEADLESS` (under fish it is usually a universal variable, so
`set -Ue EGO_LINUX_HEADLESS` rather than `set -e`), then run
`ego-browser --open`. That trades the headless browser for a visible one, which
**restarts Chrome** — the current spaces' tabs and their seeded cookie jars do
not survive it, so treat the work in flight as lost and start the task again in
a fresh space.

A `visible: false` handoff or kept completion is not an error and does not need
to be retried: the ownership change is real, headless is a supported way to run,
and CI hands off with nobody watching. It is only wrong to *narrate* it as
something the user is looking at. The port also writes a one-line warning to
stderr for handoff in that case, so it shows up in the command output even if
the resolved value goes unread.

**Regaining control**: Take control back *only* after the user explicitly
confirms — through an Ask (your harness's button/option prompt, e.g. "Continue"
vs "Finish task") or a "continue" message in chat. Then start a new heredoc
with `await taskSpaces.takeOver(nameOrId)` and resume; if the user chooses to
finish, close out with `await taskSpaces.complete(nameOrId, { keep })`. Never
call `taskSpaces.takeOver` on your own to grab control back — it has no
ownership check and will seize the browser away from the user.

**Unexpected takeover**: The user can take over at any time via the browser GUI
— the same effect as the agent calling `taskSpaces.handOff`. Do not retry the
failed operation and do not auto-takeover; surface the Ask above (Continue /
Finish) and resume only when the user picks Continue.

`await taskSpaces.waitForAgentControl(nameOrId)` is a read-only blocking poll
(it never takes control); use it only to wait inside the current heredoc for a
handoff you initiated.
