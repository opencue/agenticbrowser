# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, go back to `SKILL.md`.

The ego-browser skill depends on a working `ego-browser` command. On macOS it
comes from the ego lite app. On Linux this repository also includes a source
port under `package/ego-linux` that drives an installed Chrome, Chromium, Brave,
or Edge browser over CDP.

ego lite website: https://lite.ego.app/

## Install from source on Linux

Requirements: Node.js 22+, npm, and a Linux Chrome/Chromium-family browser.
Headed human-action focus also uses `xdotool`; ordinary background and headless
automation do not require it. Returning focus to a native Wayland application
uses `ydotool` with `ydotoold` running.

From a checkout of this repository, run:

```bash
sh skills/ego-browser/scripts/install.sh
```

The script builds `package/ego-browser`, links
`package/ego-linux/bin/ego-browser.mjs` into `~/.local/bin/ego-browser`, and
runs `ego-browser --doctor` without starting the managed browser. It preserves
existing profile and Task Space state.

Optional setup:

```bash
ego-browser --import-chrome-profile   # run only while the managed browser is stopped
ego-browser --install-desktop-entry   # add the Spaces launcher
ego-browser --spaces                  # open the Task Spaces dashboard
```

For headless CI or a Linux session without a display:

```bash
export EGO_LINUX_HEADLESS=1
```

See `package/ego-linux/README.md` for runtime commands, profile locations,
Wayland/XWayland behavior, Windows packaging, and security boundaries.

## Install steps (macOS)

On macOS the same install script downloads and launches the native app. It will:

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

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready:

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

## After that, return to the original task

Once the environment is ready, return to the user's original task and continue with the task space flow in `SKILL.md` — start from `taskSpaces.useOrCreate(name)` and proceed as usual.

## Troubleshooting

- **Linux browser missing**: install a Linux Chrome/Chromium-family browser, or set `EGO_LINUX_CHROME` to its absolute path.
- **Linux command unavailable**: add `~/.local/bin` to `PATH`, then retry `ego-browser --doctor`.
- **No Linux display**: set `EGO_LINUX_HEADLESS=1`, or provide a desktop/WSLg display for headed browsing.
- **Other platforms**: use the ego lite website at https://lite.ego.app/ or build a supported port from this repository.
- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **Command still unavailable after onboarding**: confirm `~/.local/bin` is on the PATH (see above); or have the user reopen ego lite, finish onboarding, and retry.
