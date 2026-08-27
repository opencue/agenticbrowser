# ego-browser, Linux and Windows port

Upstream ego lite runs on macOS only: the browser ships as a `.dmg`, and the
`ego-browser` harness talks to it through native bindings the app injects as
`globalThis.ego`.

This package supplies that object on Linux and on Windows, backed by a stock
Chromium over CDP. **The harness itself is unmodified** — every helper, locator,
driver and format in `package/ego-browser/` is upstream code running as-is.

Everything either operating system does differently — where state lives, how a
browser is found, how another process's argv and ancestry are read, how a
process is stopped, and what Chrome leaves behind guarding a profile — is behind
[`src/platform.mjs`](src/platform.mjs). The other ~5,800 lines are the same code
on both. `test/platform-isolation.test.mjs` fails the build if that stops being
true, because a `/proc` read added elsewhere still passes every test on Linux
and silently breaks Windows.

## Install on Windows

Download `ego-lite-setup.exe` from the latest CI run and double-click it. There
is nothing to install first — the Node runtime is inside the installer, and the
browser it drives is the Edge that Windows already has.

It installs per user into `%LOCALAPPDATA%\Programs\ego-lite`, so there is no
administrator prompt. It puts `ego-browser` on your `PATH`, adds a Start Menu
entry with the icon, and registers a normal uninstaller under **Settings → Apps**
that takes the `PATH` entry back out with it.

> A shell that was already open keeps the old `PATH`. Open a new terminal after
> installing.

> The installer is **not code-signed**, so SmartScreen shows _"Windows protected
> your PC — Unknown publisher"_ on first run: choose **More info → Run anyway**.
> Signing it needs a certificate (roughly $200–400/year), which this project does
> not have.

Building it yourself needs Windows, because the Inno Setup compiler only runs
there:

```powershell
cd package\ego-browser; npm ci; npm run build
cd ..\ego-linux
node installer\stage.mjs --node <path to node.exe>
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" /DAppVersion=0.1.0 installer\ego-lite.iss
```

What the installer _contains_ is decided by `installer/stage.mjs` and checked by
`test/installer.test.mjs`, which runs everywhere — a renamed or moved file still
compiles into a perfectly valid installer that fails on the user's machine, so
that check reads `ego-lite.iss` back and verifies every path it points at was
actually staged.

## Install from a checkout

Requires Node >= 22 and any Chrome/Chromium/Brave/Edge build. Headed Linux also
uses `xdotool` for the explicit human-action focus gate. Linux resolves the
browser and `xdotool` from `PATH`; Windows also looks in the standard browser
install locations, so a normal Chrome or Edge install needs no configuration.

On a Wayland desktop, headed agent Chrome defaults to XWayland. It starts with
`--no-startup-window`; the first task target is then created with
`background:true, focus:false`, so even a cold browser launch stays behind the
application the user is typing in. A `requestUserAction()` call focuses only
when it carries a concrete non-empty instruction, and can activate the exact
managed-browser PID without opening a second window. Its Done/Cancel state lives
in a named isolated CDP world behind a closed shadow root, so page JavaScript can
remove the panel but cannot forge a human decision. Set
`EGO_LINUX_WINDOW_BACKEND=wayland` to force native Wayland; that opts out of
reliable programmatic application activation, so focused presentation may
report `raise-failed` instead.

The CDP endpoint uses a randomly allocated non-zero loopback port. Chrome treats
`--remote-debugging-port=0` as an automation signal and exposes
`navigator.webdriver=true`, which can trigger Google sign-in rejection and
Cloudflare verification loops even in a normal headed window. The explicit
non-zero port keeps the same local CDP transport without that false signal.

```bash
cd package/ego-browser && CI=true npm ci && npm run build   # build the upstream harness
cd ../ego-linux && npm test                                  # verify the port (headless)
```

`CI=true` is required, not cosmetic: the harness's `prepare` script runs
`lefthook install`, which fails on any machine with a global `core.hooksPath`
set. The script's own guard is `[ "$CI" = "true" ] && exit 0`, so this is
upstream's intended escape hatch rather than a workaround.

Put the CLI on your PATH:

```bash
ln -s "$PWD/bin/ego-browser.mjs" ~/.local/bin/ego-browser
```

On Windows the installer above does this for you. From a checkout, a `.cmd`
shim in a directory already on `PATH` does the same job — a symlink would need
Developer Mode, and the shebang means nothing there:

```powershell
$bin = "$env:LOCALAPPDATA\Microsoft\WindowsApps"
Set-Content "$bin\ego-browser.cmd" "@node `"$PWD\bin\ego-browser.mjs`" %*"
```

## Use

Identical to upstream — a heredoc of JS on stdin:

```bash
ego-browser <<'JS'
const task = await taskSpaces.useOrCreate('research task')
await page.goto('https://example.com')
console.log(await page.snapshot())
await taskSpaces.complete(task.id, { keep: true })
JS
```

Commands this port adds (upstream's app has no equivalent):

| Command                               | What it does                                                         |
| ------------------------------------- | -------------------------------------------------------------------- |
| `ego-browser --doctor [--json]`       | inspect installation and runtime state without starting the browser  |
| `ego-browser --status`                | connection state of the backing browser                              |
| `ego-browser --open`                  | open the shared agent browser window                                 |
| `ego-browser --spaces`                | open the Spaces overview panel                                       |
| `ego-browser --stop`                  | terminate the backing browser and clear its profile lock             |
| `ego-browser --import-chrome-profile` | copy your real Chrome profile in, so agent tasks inherit your logins |
| `ego-browser --install-desktop-entry` | add it to your app launcher (Start Menu on Windows)                  |
| `ego-browser --headless`              | run the backing browser headless (first launch only)                 |

### The Spaces panel

This port is not a native Ego Lite application. On stock Chrome/Chromium the
Spaces overview is a browser surface, and task pages shown to the user retain
the browser's normal tabs and address bar. The desktop class/icon can distinguish
the managed process in the launcher; it cannot turn the window into the Citro
application shell. Never describe that window as “not Chrome”.

`ego-browser --spaces` opens an overview of every task space: one card each, with
a live screenshot of the space's page, its name, its owner, and its tab count.
Clicking a card switches to that space, `×` closes it, `+` creates one.

Cards use cached screencast frames and server-sent refresh events. A 15-second
reconciliation poll remains only as a recovery path for missed filesystem events
and activity expiry. The panel daemon publishes a hash of the runtime sources;
running `--spaces` after an update shuts down an older matching daemon through a
token-protected loopback endpoint and starts the current build. Every `/api/`
route requires the same random daemon token. The launcher passes it to the panel
in the URL fragment, which is omitted from the initial document request and the
printed panel URL. The panel then sends it only in an API header and uses an
authenticated fetch stream instead of headerless `EventSource`.

Runtime control state is private even under a permissive shell umask:
`~/.local/state/ego-lite-linux` is forced to mode `0700`, while `browser.json`,
`task-spaces.json`, and `spaces-server.json` are forced to `0600`.

Each CLI invocation also removes expired Ego-generated screenshots, failure
artifacts, and download directories from the OS temp directory. The default TTL
is 24 hours. Set `EGO_BROWSER_ARTIFACT_TTL_HOURS` to another non-negative number;
`0` disables cleanup. Explicit screenshot paths, saved downloads, and custom
failure-artifact directories are never included in this automatic sweep.

Upstream draws this inside the browser's own chrome, replacing the tab strip.
That is not reachable from outside a Chromium fork — Chrome 137 removed the
`--load-extension` switch, and the CDP `Extensions` domain answers
"Method not available", so nothing can inject UI into the browser frame. (A
Chromium-based browser that still honours `--load-extension`, such as Brave,
_can_ load one — verified on this machine — which would additionally allow
native tab groups as space markers.)

What is reachable on stock Chrome is an `--app` window: no tab strip, no
toolbar, its own `app_id`. That is what the panel uses, so it reads as part of
the browser rather than a web page in a tab. A small loopback HTTP server backs
it, reading and writing the same task-space state file the CLI uses — the
overview and the agent can never disagree about which spaces exist.

### App launcher entry

The macOS build installs as a native app. `--install-desktop-entry` gives this
port only a launcher shortcut — an XDG desktop entry on Linux, a Start Menu
shortcut on Windows:

```bash
ego-browser --install-desktop-entry
```

On Linux it writes `~/.local/share/applications/ego-lite-linux.desktop` and
`~/.local/share/icons/hicolor/scalable/apps/ego-lite-linux.svg`, then refreshes
the desktop and icon caches. On Windows it writes
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\ego lite.lnk` through the
shell's own COM object, which is the only supported way to produce a valid
`.lnk` without a native dependency, and points it at `assets/ego-lite.ico`.

Launching either runs `--open`, which brings up the shared agent browser window.
The icon is upstream's mark with a badge, so a port window is never mistaken for
an upstream build.

`assets/ego-lite.ico` is committed, and rebuilt from the SVG by
`node scripts/make-icon.mjs`. It renders through the browser this package
already requires rather than ImageMagick, rsvg or `sharp` — a system package a
contributor may not have, or a native dependency in a package that has none —
and packs the results into a 7-size icon by hand. `test/icon.test.mjs` parses
the committed file back and checks every entry against the size it declares,
because nothing on Linux would otherwise notice a broken one.

The entry pins the **absolute path of the node that installed it**, rather than
relying on a `#!/usr/bin/env node` shebang. A desktop session's PATH is not your
shell's, so a node from nvm / fnm / asdf is invisible to it and clicking the
icon would fail silently, with no terminal to show the error. Re-run
`--install-desktop-entry` after switching node versions.

`--open` also replaces a headless backing browser with a visible one instead of
refusing, for the same reason: an icon has to work, not explain.

The backing browser is launched once and **persists between invocations** — each
heredoc is its own short-lived Node process, so the browser, not the process, is
what has to survive. It uses a dedicated profile under
`~/.local/share/ego-lite-linux/profile` (Linux) or
`%LOCALAPPDATA%\ego-lite\profile` (Windows), which is why
`--import-chrome-profile` exists: it is this port's equivalent of ego lite's
"migrate your Chrome data" onboarding step. It reads your stock browser's
profile from `~/.config/google-chrome` on Linux and
`%LOCALAPPDATA%\Google\Chrome\User Data` on Windows, Chromium, Edge and Brave
included.

The Linux directory keeps its `ego-lite-linux` name on purpose: renaming it
would strand the profile — and the logins in it — of every existing install.
Windows has no such history, so it gets `ego-lite`.

Environment overrides: `EGO_LINUX_CHROME` (browser binary),
`EGO_LINUX_PROFILE` (profile dir), `EGO_LINUX_CDP_URL` (attach to an
already-running DevTools endpoint instead of launching), `EGO_LINUX_CURSOR=0`
(hide the agent cursor), `EGO_LINUX_CURSOR_NAME` (override the detected agent
name). The `EGO_LINUX_` prefix is historical and applies on both platforms.
`XDG_DATA_HOME` and `XDG_STATE_HOME` are honoured on Windows too, which is what
lets a harness — or the test suite — redirect all state with one assignment.

The cursor labels itself with whichever harness is driving — `codex` draws
"Codex", `claude` draws "Claude", anything unrecognised draws "Agent" rather
than claiming to be one of them. Detection reads the process ancestry — from
`/proc` on Linux, from `Win32_Process` on Windows — so it needs no cooperation
from the harness; `EGO_LINUX_CURSOR_NAME` overrides it. Teaching it a new
harness is one row in `HARNESS_NAMES` (`src/agent-identity.mjs`); the `.exe`
suffix is stripped before the lookup, so one row covers both platforms.

### The agent's cursor

Watch the agent's window and you see a cursor move, click and carry a label of
what it is currently doing — the same "something else is driving this" signal
the native app draws over its web view. On Linux the page is the only surface
the shim controls, so the cursor is a DOM overlay injected into the page the
harness is acting on (`src/cursor.mjs`), fed by the pointer coordinates the
harness sends.

It is deliberately unable to interfere with the automation it illustrates:

- the host element is `pointer-events: none`, so `document.elementFromPoint`
  never returns it. That is load-bearing, not cosmetic — the harness's wheel and
  drag fallbacks hit-test with `elementFromPoint`, and an overlay that answered
  those probes would swallow input meant for the page;
- it lives in a closed shadow root, keeping it out of the agent's own snapshot
  and out of reach of page CSS;
- every render is fire-and-forget and swallows its errors, so a page that
  refuses the injection or navigates mid-flight can never fail an action.

It _is_ drawn into screenshots, which is usually what you want and occasionally
not: `EGO_LINUX_CURSOR=0` turns it off.

### Watching it read

Snapshotting is most of what an agent does, and it dispatches no input at all —
so a window where the agent was reading showed a cursor parked in a corner under
a badge that said "reading". True, but it never said _what_, which is the one
thing someone watching wants to know.

Every snapshot now starts a **read sweep**: the cursor walks the lines that are
actually on screen, marking each one as it passes and naming it in the badge
(`Claude · reading "…"`). The marks are lighter than the highlighter's and fade
behind the cursor, because reading is constant and its marks should not pile up.

The sweep runs entirely inside the page. A CDP round trip per line would cost
more than the snapshot it illustrates, and the heredoc that triggered it has
usually exited before the last line is drawn. It gives up after about two and a
half seconds, and any real input — a click, a keystroke, the next read, an
explicit `highlight()` — takes the cursor back from it immediately, mid-line.

It also keeps the state the Spaces overview subscribes to moving, so a space
whose agent is reading no longer looks like a space whose agent walked away.

### Watching it scroll

The cursor is anchored to the page rather than the screen, because it marks the
element the agent is working on and has to travel with it. The cost is that a
long scroll carries it out of the viewport entirely, and the window went blank
while the agent was still working.

The cursor still goes; the **badge stays**, docked against the edge the cursor
left by with an arrow pointing after it (`↑ Claude · checking the button`). It
holds still while the page keeps moving under it, and glides back to the cursor
when the cursor comes back into view. Scroll position is not something a CDP
round trip announces, so this is driven by the overlay's own `scroll` listener —
which also means it works for the `scrollIntoView` every `click()` does, not just
for an explicit `page.wheel()`.

One limit worth knowing: a docked badge is for the window, not for screenshots.
`Page.captureScreenshot` renders the overlay in page coordinates without the
scroll offset — a pre-existing quirk, visible on any scrolled page — so a badge
docked at the top of a viewport scrolled far down falls outside the captured
frame. Nothing is lost that used to be there: before, the cursor was off screen
and the screenshot showed nothing either.

Cursor movement is also timed by distance now, between a 90ms nudge and a 420ms
glide, rather than every move taking the same 200ms whether it crossed the page
or two fields.

### The highlighter

`ego` is a global inside a heredoc, so the port adds one thing the upstream API
has no equivalent for — a marker the agent draws to show you what it is talking
about:

```js
await ego.highlight("free shipping", { note: "this is the bit that changed" });
await ego.highlight("#total", { note: "and this is the total" });
await ego.clearHighlight();
```

A string is tried as a CSS selector first and searched for as page text if that
finds nothing, so both forms above do the obvious thing; `{selector}` or `{text}`
forces one. Off-screen text is scrolled into view first — a marker nobody can see
explains nothing.

It resolves to a `Range`, which is what gives **one band per line** instead of
one box around a whole paragraph: the difference between a pen stroke and a
coloured rectangle. Each band wipes in from its own left edge while the cursor
travels along it, and the call resolves when the stroke finishes, so an agent can
narrate at the speed a human reads.

It never makes a real selection. Selecting text for the look of it would fight
the agent's own work on the page.

### What the launcher normalises, and why

Two settings are forced on the agent profile because inheriting them silently
breaks coordinate-based automation:

- **Page zoom is reset to 100% on every launch.** `--import-chrome-profile`
  copies real Chrome preferences, zoom included. At 150% zoom a 1280px window
  lays out as 853 CSS px, so page content the agent expects on screen falls
  below the fold: element coordinates hit-test to nothing, clicks land on
  nothing, and `Input.dispatchMouseEvent` can hang outright. This was not
  theoretical — it caused every canvas drawing case in the upstream e2e suite to
  fail until it was fixed.
- **The window is launched at 1280x900 with device scale factor 1**, so page
  layout does not depend on the desktop's HiDPI setting.

The launcher also clears Chrome's single-instance guard before starting. A
browser killed without exiting cleanly leaves it behind, and every later launch
then aborts with "Failed to create a ProcessSingleton". Since `launch()` only
runs after no DevTools endpoint answered, a guard still held by a live process
means an unreachable orphan of ours, which is terminated first.

What that guard _is_ differs: POSIX Chrome writes `SingletonLock` as a symlink
naming its owner's pid, so the owner is readable off the filesystem. Windows
Chrome uses a named mutex and a message window — nothing on disk names the owner
— so the port finds it in the process table instead, by the `--class=` marker
every browser it launches carries. That switch is inert as a window hint on
Windows and is passed there purely as that marker.

## Windows

Everything above applies on Windows, with these differences:

| Linux                           | Windows                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `~/.local/share/ego-lite-linux` | `%LOCALAPPDATA%\ego-lite`                                    |
| `~/.local/state/ego-lite-linux` | `%LOCALAPPDATA%\ego-lite` (Windows has no data/state split)  |
| browser found on `PATH`         | standard install paths first, `where.exe` as a backstop      |
| `/proc` for argv and ancestry   | `Win32_Process` over PowerShell, ancestry cached per process |
| `SIGTERM`                       | `taskkill /T /F` (both leave the crash mark `--stop` clears) |
| XDG desktop entry, SVG icon     | Start Menu `.lnk`, `.ico` icon                               |
| `--class` sets the window class | inert as a hint; still the ownership marker                  |

Packaging: `installer/` builds `ego-lite-setup.exe` (Inno Setup, per-user, with
a bundled Node runtime), and `scripts/make-icon.mjs` builds the `.ico` both the
installer and the Start Menu shortcut draw — through the browser this package
already requires, so neither ImageMagick nor a native npm dependency enters the
tree. See **Install on Windows** above.

**Not yet verified against a real Windows machine.** The Windows branch is
covered by `test/platform.test.mjs`, which exercises it from Linux by passing
`createPlatform()` a platform and an environment — that proves the paths,
command-line parsing and artifact handling are right, and cannot prove the
behaviour against a real process table or a real browser. The `test-windows` CI
job on `windows-latest` is what does that, and `build-windows-installer` is what
proves the installer compiles and is the size it should be. Treat a green run of
those, not this README, as the evidence.

Two costs are Windows-specific and worth knowing:

- **The process table is a PowerShell call.** Reading another process's argv
  goes through `Get-CimInstance Win32_Process`, filtered server-side by WQL so
  only matching rows come back. The reaper does this once per launch. The
  cursor's harness detection does it once per process and caches the answer,
  because it is called while the overlay is being built and cannot be async.
- **Detached children are launched with `windowsHide`.** Without it every
  heredoc that starts the Spaces daemon flashes a console window on the desktop.

## Fidelity

The harness uses 15 native methods plus 2 callbacks. All are implemented. The
remaining differences are structural rather than unfinished native methods.

| Native surface                                            | Backed by                                             | Fidelity                                                                                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sendCDPMessage`, `onCDPMessage`, `onSendCDPMessageError` | WebSocket to Chrome's browser endpoint                | **Exact.** Chrome's flat CDP wire format is byte-identical to what the harness sends and parses, so this is a passthrough, not a translation.                                                |
| `listTabs`, `createTab`                                   | `Target.getTargets` / `Target.createTarget`           | **Exact**, except `active`: CDP cannot report which tab is focused, so the DevTools HTTP endpoint's most-recently-used ordering stands in. It also tracks tabs the user switches to by hand. |
| `getBrowserVersion`                                       | `Browser.getVersion`                                  | Exact.                                                                                                                                                                                       |
| `upgradeBrowser`                                          | no-op                                                 | App lifecycle; the user's own Chrome updates itself.                                                                                                                                         |
| `animationHighlightMouseToPosition`, `setAgentTaskState`  | a DOM overlay injected into the page                  | **Equivalent, drawn elsewhere.** The native app paints the cursor over its web view; the shim has only the page, so it injects one there. See above.                                         |
| `snapshot`                                                | `DOMSnapshot.captureSnapshot` + role/name computation | **Refs exact, content rebuilt.** See below.                                                                                                                                                  |
| the 9 task-space methods                                  | tracked tab sets in the live agent profile            | **Shared live login/storage state, with scoped tabs and enforced handoff.** Optional isolated cookie-only and cookie + localStorage seed modes are available. See below.                     |

Verified against upstream's own real-browser e2e suite (45 cases, ~525
assertions), which drives this CLI exactly as it drives the macOS app.

### snapshot

The `refs` half is exact. `browserSnapshotRefsToRefMap()` keys the ref map by
`String(backendNodeId)`, and CDP hands out `backendNodeId`s directly — so `@N`
and `ref=N` resolve against genuine node identities, not a reimplementation.

The `content` half is rebuilt, since the native snapshot is closed source. One
`DOMSnapshot.captureSnapshot` call returns every document — iframes included,
nested to any depth — with each node's `backendNodeId`, attributes and layout
box. Hierarchy, layout-driven visibility and iframe piercing therefore come from
the browser itself; roles, accessible names and `loc=` locators are computed
here. Emitted `loc=` values are resolved by upstream's own `locator-query.ts`,
so they are validated against the real resolver rather than an invented format.

Not claimed: parity with the native snapshot's output. It is a different tree
built from the same underlying facts.

### Task spaces

Task spaces now use the live agent profile by default. That deliberately chooses
profile-level login parity over per-space storage privacy: cookies,
`localStorage`, IndexedDB, CacheStorage and service-worker registrations are
shared with the rest of the agent browser, so a login made in one space is
visible in the next one without a seed or sync pass.

Creating a task space opens no tab or window. The first `page.goto(...)` or
`browser.openOrReuseTab(...)` creates its first tab directly at the requested
URL, so an interrupted agent run cannot leave an "agent space is ready" page on
the desktop.

Set `EGO_LINUX_TASK_SPACE_STORAGE=isolated` to opt into the older
browser-context mode. In that mode a space owns a context seeded from the
default cookie jar when the space is created. Cookies written in one isolated
space stay invisible to the others and to the default jar, but non-cookie auth
stores do not come along.

Set `EGO_LINUX_TASK_SPACE_STORAGE=isolated-sync` when isolation is required but
the login also uses `localStorage`. It keeps the isolated cookie jar and, before
each HTTP(S) origin's first page scripts run, copies a bounded point-in-time
snapshot of that origin's default-profile `localStorage`. The snapshot is capped
at 1000 entries / 256 KiB and is installed once per tab; it is not a live bridge.
If that origin is not already open in the default profile, the shim briefly
loads the origin root in a background, unfocused source tab and closes it after
reading storage. IndexedDB, CacheStorage and service-worker state remain
isolated. Measurements and two reproducible cookie experiments are in
[`docs/isolation-with-inherited-logins.md`](../../docs/isolation-with-inherited-logins.md);
seeding a real 2038-cookie profile costs ~105 ms, once per isolated space.

A space also owns a tracked set of tabs plus its ownership state (`agent` /
`agentDelegatedToUser` / `user`), with working `switch` / `claim` / `handOff` /
`takeOver` / `complete` semantics; switching to a space puts the agent back on
that space's last active tab, including across separate heredoc processes. When
the user owns control, the agent bridge rejects page
operations with `EGO_TASK_SPACE_USER_IN_CONTROL`; the Spaces panel can still
switch cards because that is the user, not the agent.

`listTabs` is scoped to the selected space, as it is in the native app. That was
dropped once and has been restored, because the reason it failed is gone:
membership used to be inferred from which window a tab landed in, and
`Target.createTarget` accepts no window id, so every heuristic tried (MRU
ordering, "the tab the harness is attached to", "the tab we just created")
either hid a tab the harness still held — `switchTab` then failed with "target
not found" — or leaked one space's tabs into another's list. Context-backed
spaces still scope by `browserContextId`; default shared-profile spaces scope by
the tracked target ids the shim opened.

**What does not work:** default spaces do not isolate browser storage from each
other. Use `isolated` for the strongest boundary, or `isolated-sync` for a
point-in-time cookie + localStorage login seed. Neither isolated mode clones
IndexedDB, CacheStorage or service-worker state.

The user-control boundary is enforced at the bridge: selecting a user-controlled
space returns `{ done: true, readOnly: true }` without claiming it. Semantic
snapshot and screenshot capture remain available for passive verification;
navigation, input, Runtime evaluation, tab/window/browser mutation, and all
other non-passive CDP stay blocked with `EGO_TASK_SPACE_USER_IN_CONTROL` while
the space is handed off. Only an exact observation/attachment allowlist remains:
screenshot and browser/window metadata reads plus Target list/info/context and
session attach/detach. Takeover uses the shim's internal path, not this public
passthrough.

## Verification

Two suites, and they must be run one at a time — both drive a browser.

**`npm test` (this package)** drives the real CLI headless against a local
fixture: navigation, snapshot content, refs resolving to coordinates,
synthesised clicks landing on elements, locator fills, two-level iframe
piercing, screenshots, the agent cursor, and task-space lifecycle. It also
starts a real Spaces server and asserts its routes, its cross-origin refusal,
and that a click by a separate agent process shows up as activity on the card.
It uses a throwaway profile and state dir, so it never touches a browser your
agent sessions are using.

**Upstream's real-browser e2e suite** (`cd ../ego-browser && npm run e2e`, with
`ego-browser` on PATH) is the real measure: 45 cases, ~520 assertions, driving
this CLI exactly as it drives the macOS app.

**43 of 45 cases pass** on an unloaded machine.

Two failures are permanent, and neither is a port defect:

| Case                                      | Why it cannot pass                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `macOS bare Meta input isolation`         | Asserts `process.platform === "darwin"`.                                                                                                                                                     |
| `regression PWB-10 permission capability` | Asserts that `Browser.grantPermissions` with `clipboardReadWrite` is _rejected_ — an ego lite limitation. Stock Chromium supports it, so the port is more capable than the assertion allows. |

Everything else passes: navigation, observation, task spaces, pointer input,
keyboard, downloads, screencast, fetch, canvas drawing, the Playwright
regression set, and the adversarial cases.

### Resolved flake: canvas drawing under load

The former canvas race counted one stroke twice when a trusted `mouseup` arrived
after the first 50 ms probe and the harness re-synthesised the drag. The harness
now checks the non-consuming probe after 50, 100 and 150 ms and only permits the
fallback after all evidence windows miss. `driver/pointer.test.mjs` covers a late
trusted event and asserts that the drag is consumed once rather than replayed.
