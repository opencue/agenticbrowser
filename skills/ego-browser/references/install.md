# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, go back to `SKILL.md`.

The ego-browser skill depends on a working `ego-browser` command on `PATH`. On
**macOS**, that command comes from the Citro **ego lite** app (DMG + onboarding).
On **Linux / WSL**, this fork's supported runtime is `package/ego-linux`. The
installer preserves its long-lived `~/.local/share/ego-lite-linux` profile and
links both normal browser work and the Spaces dashboard to that one runtime.
The experimental `package/ego-linux-host` package has a different profile and
task-space store; never substitute it during an active task. Both drive stock
Chrome/Chromium and neither supplies the native Citro/macOS Ego Lite shell.

ego lite website (macOS product): https://lite.ego.app/

Source: [`opencue/agenticbrowser`](https://github.com/opencue/agenticbrowser)
(formerly `opencue/ego-lite-linux`; old URLs still redirect),
an unofficial fork of `citrolabs/ego-lite`, published on branch `linux-port`
(checked out locally as `main`, which tracks it). On this machine the checkout
is at `~/Documents/ego-lite-linux`. Full details: `package/ego-linux/README.md`.

## Verify the installed Linux runtime before opening or troubleshooting it

Run these checks before making a claim about which Ego window the user has:

```bash
command -v ego-browser
readlink -f "$(command -v ego-browser)"
grep '^Exec=' ~/.local/share/applications/ego-lite-linux.desktop 2>/dev/null || true
pgrep -a -f 'package/ego-linux/bin/ego-browser.mjs|ego-lite-linux/profile' | head
```

- A CLI target under `package/ego-linux/` identifies the supported port and its
  `~/.local/share/ego-lite-linux` profile.
- A target under `package/ego-linux-host/` is the experimental host with a
  different `~/.local/share/ego-lite` profile. Stop and fix the install instead
  of crossing between the two.
- The desktop `Exec` should name the same `package/ego-linux` CLI with
  `--spaces`; this is the Task Space dashboard, not a second browser runtime.
- A launcher/icon/window class is only desktop identity. The visible surface is
  still Chrome/Chromium; never claim a native Ego application window exists.

---

## Install steps (Linux / WSL)

The checked-in `scripts/install.sh` builds the harness and installs the
supported `package/ego-linux` runtime.

This fork replaces upstream's macOS DMG script at that path with a Linux-aware
installer. On macOS, use the separate macOS instructions below.

This install builds the harness and symlinks the Linux port's CLI shim:

- Port: `package/ego-linux` (browser lifecycle + Task Spaces + `ego-browser` shim)
- Harness: `package/ego-browser` (helper runtime injected into heredocs)

### Requirements

- Linux kernel (`uname -s` → `Linux`), including WSL2
- Node.js ≥ 22 and npm
- Chrome or Chromium **on the Linux side** (not Windows `chrome.exe` for MVP)
- For headed mode: a display (`DISPLAY` set) — prefer **WSLg** on Windows
- For headed human-action focus on Linux: `xdotool` (the browser uses XWayland
  on Wayland desktops so only the explicit focus gate can activate it)
- For headless: `EGO_LINUX_HEADLESS=1` (opt-in; no GUI required)

### Run the installer

From the ego-lite repo root (adjust the path if your checkout lives elsewhere):

```bash
sh skills/ego-browser/scripts/install.sh
```

What it does:

1. Checks Linux, Node ≥ 22, and a Linux-side Chrome/Chromium
2. Runs `npm ci` + `npm run build` for `package/ego-browser`
3. Symlinks `~/.local/bin/ego-browser` → `package/ego-linux/bin/ego-browser.mjs`
4. Verifies that the installed command starts
5. Leaves the existing profile and Task Space state untouched

Optional onboarding commands:

```bash
ego-browser --import-chrome-profile   # browser must be stopped first
ego-browser --install-desktop-entry   # launcher opens --spaces
```

### Optional profile import — risky, off by default

Copying cookies/logins from your **system Chrome** into the ego profile is not
done by default.

- Profile import is explicit through `ego-browser --import-chrome-profile`.
- It copies selected profile data only while the managed browser is stopped.
- Seeding while Chrome is running (or blindly copying a live profile) can **corrupt Chrome data**. Leave seeding disabled unless you understand that risk.

Run `ego-browser --stop` first; never copy a live Chrome profile by hand.

### Headed vs headless (WSL notes)

| Mode               | When                               | How                                                   |
| ------------------ | ---------------------------------- | ----------------------------------------------------- |
| Headed (preferred) | Interactive browsing, visual debug | WSLg or native Linux desktop; ensure `DISPLAY` is set |
| Headless           | CI / no GUI                        | `export EGO_LINUX_HEADLESS=1` before `ego-browser`    |

Headed mode defaults to XWayland when `XDG_SESSION_TYPE=wayland` and `DISPLAY`
is available. This keeps ordinary agent work background-only while allowing
`taskSpaces.requestUserAction(...)` to activate the exact managed browser
window. `EGO_LINUX_WINDOW_BACKEND=wayland` forces native Wayland, but GNOME may
then reject application-level focus without a fresh compositor activation token.

The managed browser also uses a randomly allocated non-zero loopback CDP port.
Do not replace it with `--remote-debugging-port=0`: Chrome exposes
`navigator.webdriver=true` in that mode, which can make Google and Cloudflare
treat an otherwise normal headed browser as automation.

MVP targets **Linux-side** Chrome/Chromium only. Pointing at Windows Chrome under `/mnt/c/...` is out of scope.

If Chrome lives in a non-standard path:

```bash
export EGO_LINUX_CHROME=/opt/google/chrome/chrome
```

### Confirm install

```bash
command -v ego-browser
ego-browser --status
ego-browser --spaces
```

`--spaces` opens the loopback Task Space dashboard. Normal agent navigation
stays in background tabs; only dashboard Open, handoff, or `keep: true`
completion explicitly presents a task page.

If `command -v` fails, put `~/.local/bin` on `PATH` (see below) and retry.

---

## Install steps (macOS only)

The install script lives at `scripts/install.sh` in this skill and supports **macOS only**. It will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- After installing, launch the `ego lite` app.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the ego lite app directly. If ego lite is already installed, the script skips the download and opens the app directly.

After the script opens the ego lite app, the user completes the first-run onboarding in the app:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH (usually under `~/.local/bin`).

Onboarding is a step the user completes in the GUI. After the script opens ego lite, wait for the user to confirm they've finished onboarding before continuing.

---

## After installing: confirm `ego-browser` is available

Once install (and on macOS, onboarding) is done, confirm the command is ready:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Once the command exists, verify the runtime with a minimal heredoc:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready.

On Linux, you can also inspect the backing browser without a full heredoc:

```bash
ego-browser --status
```

## After that, return to the original task

Once the environment is ready, return to the user's original task and continue with the task space flow in `SKILL.md` — prefer `taskSpaces.run(name, async task => { ... })` for one-round tasks, and use `taskSpaces.useOrCreate(name)` only when the task intentionally spans multiple heredoc rounds.

## Troubleshooting

- **Linux / WSL**: confirm `command -v`/`readlink` resolves to
  `package/ego-linux`, and that the desktop entry names the same CLI with
  `--spaces`. Do not point either surface at the experimental host profile.
- **Not macOS**: the DMG script supports macOS only (`uname -s` is `Darwin`). On Linux use the matching port instructions above. On other platforms, check https://lite.ego.app/ or build from this monorepo.
- **Linux versus macOS Citro shell**: neither Linux implementation installs the
  proprietary `ego lite.app`. A Linux launcher, icon, window class, profile, and
  task-space store can provide separate desktop identity, but the visible shell
  remains stock Chrome/Chromium.
- **Chrome missing on Linux**: install Chromium/Chrome for Linux, or set `EGO_LINUX_CHROME`. The installer does not run package managers.
- **No display (WSL without WSLg)**: use `EGO_LINUX_HEADLESS=1`, or enable WSLg / a display server.
- **Download failed (macOS)**: the DMG script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it (macOS)**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **Command still unavailable**: confirm `~/.local/bin` is on the PATH (see above). On macOS, reopen ego lite, finish onboarding, and retry. On Linux, re-run `scripts/install.sh` or re-create the symlink to `package/ego-linux/bin/ego-browser.mjs`.
