# Task-space isolation *and* inherited logins, without forking Chromium

`package/ego-linux/README.md` currently states the constraint this way:

> A native Space is isolated *and* inherits your login state. On stock Chromium
> those two properties pull apart:
>
> - `Target.createBrowserContext` → real isolation, but an empty cookie jar
> - a separate window → your real logins, but no isolation
>
> Login inheritance wins, because that is what agent tasks actually depend on.

The first half is right: a fresh browser context does start with an empty jar.
The conclusion does not follow, because **the jar can be filled**. Measured on
Chrome 148, both properties are available at the same time.

## What was measured

Reproduce with the scripts in `docs/experiments/`. Both connect straight to
Chrome's DevTools browser endpoint, because the harness promotes only `Target`
and `Browser` domain calls to the browser level — a `Storage.setCookies` sent
through `cdp()` lands on a page session, where `browserContextId` is rejected
with *"browserContextId is only allowed for Browser target"*. That routing
detail is what makes this look impossible from inside a heredoc.

`docs/experiments/context-seeding-mechanism.mjs`:

```
1. cookies in fresh context: 0        (scoped read works)
2. after scoped setCookies: 1 cookie, marker present: true
3. page inside the context sees it: true
4. leaked into default context: false (isolation intact)
```

`docs/experiments/context-seeding-scale.mjs`, against the real profile:

```
real jar: 2038 cookies
seeded: 2038 of 2038 in 105ms
distinct name+domain not carried over: 0
default jar unchanged: true
```

So: full-size login state transfers into an isolated context in about a tenth of
a second, a page loaded in that context genuinely sees the cookies, and nothing
leaks back into the default jar.

## What this changes

A task space could own a browser context instead of just a window, and seed it
from the default jar at creation. That yields what the native macOS Space has —
isolation plus the user's logins — on stock Chromium.

## What it does not solve

Be precise about the difference from native, because it is not nothing:

- **The login state is a copy, taken at seed time.** The native Space shares live
  state; here, logging into a site inside one space does not appear in the
  others, and a session refreshed in the default profile does not propagate.
  For agent tasks this is usually the desired behaviour, but it is a difference,
  not parity.
- **Cookies are not all of login state.** `localStorage`, IndexedDB and service
  workers are per-origin storage that this does not carry. Sites holding tokens
  outside cookies will still land logged out. Worth measuring before promising
  users a clean result.
- **Seeding cost scales with the jar**, ~105 ms at 2038 cookies. Per space, at
  creation, this is unlikely to matter — but it is not free.

## Implementation

Implemented in `package/ego-linux/src/task-spaces.mjs` (`createSeededContext`).
Creating a space now does:

1. `Target.createBrowserContext` → `browserContextId`, stored on the space record.
2. `Storage.getCookies` (browser level, unscoped) → the default jar.
3. `Storage.setCookies` (browser level, with `browserContextId`) → seed it.
4. `Target.createTarget` with `browserContextId`, for the space's first tab and
   every later one (`tabs.createTab` takes the id).
5. `Target.disposeBrowserContext` on close, which drops the space's jar with it.

No change was needed in the shim's CDP routing: `transport.mjs`'s `call()` omits
`sessionId` unless given one, so these already go out at the browser level. The
restriction is in the *harness's* `cdp()` helper, which promotes only `Target`
and `Browser` — which is why this looks impossible from a heredoc but is
straightforward from inside the shim.

A space that fails to get a context keeps the previous window-only behaviour
rather than failing to open, and spaces created before this change have no
context id and are treated the same way — so upgrading strands nothing.

### Verified

Against an isolated instance (`XDG_DATA_HOME` / `XDG_STATE_HOME` redirected):

- a cookie present in the default jar before a space is created is visible
  inside that space — logins are inherited;
- a cookie written in space A is not visible in space B, and switching back to A
  still shows A's own — spaces are isolated from each other, not just from the
  default jar;
- neither reaches the default jar;
- open contexts go 2 → 4 → 2 across create/close, so nothing leaks;
- the port's own suite still passes 3/3, task-space lifecycle included.

Per-space `browser.listTabs()` is now also reachable — targets report the
context they were created in — but is left alone here, since it is a separate
documented divergence and this change is already load-bearing.
