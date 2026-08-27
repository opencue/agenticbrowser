import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WM_CLASS } from "./chrome.mjs";
import {
  IS_WINDOWS,
  dataRoot,
  runPowerShell,
  startMenuProgramsDir,
} from "./platform.mjs";

/**
 * Desktop integration.
 *
 * The macOS build installs as an app: an icon in the launcher you click to open
 * the browser your agents share. There is no app to install on Linux or
 * Windows, but the same affordance is a file in the right place — an XDG
 * desktop entry, or a Start Menu shortcut.
 */

const APP_ID = "ego-lite-linux";
const APP_NAME = "ego lite";
const ICON_SOURCE = new URL("../assets/ego-lite-linux.svg", import.meta.url);
/** Built from the SVG by scripts/make-icon.mjs; committed, so no browser here. */
const ICON_ICO = new URL("../assets/ego-lite.ico", import.meta.url);
const LAUNCHER = new URL("../bin/ego-browser.mjs", import.meta.url);

/**
 * The desktop session's PATH is not your shell's. A node installed by nvm, fnm
 * or asdf lives outside it, so a `#!/usr/bin/env node` shebang resolves to
 * nothing and clicking the icon fails silently. Pin the interpreter that is
 * running this installer — re-run --install-desktop-entry after switching node
 * versions.
 */
export function desktopEntry(execPath) {
  return `[Desktop Entry]
Type=Application
Name=ego lite Spaces (Chromium port)
GenericName=Managed Agent Chromium
Comment=Task-space overview for the Chrome/Chromium browser managed by ego-browser
Exec=${process.execPath} ${execPath} --spaces
Icon=${APP_ID}
Terminal=false
# Best-effort desktop grouping for the managed Chrome/Chromium process. This
# does not create the native Ego Lite application shell available on macOS.
StartupWMClass=${WM_CLASS}
Categories=Network;WebBrowser;
Keywords=agent;automation;browser;ego;
StartupNotify=true
`;
}

/** Best-effort cache refresh; the entry works without it on most desktops. */
function refresh(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function installXdgEntry() {
  const dataHome = dataRoot();
  const applications = join(dataHome, "applications");
  const icons = join(dataHome, "icons", "hicolor", "scalable", "apps");
  await mkdir(applications, { recursive: true });
  await mkdir(icons, { recursive: true });

  const iconPath = join(icons, `${APP_ID}.svg`);
  await copyFile(fileURLToPath(ICON_SOURCE), iconPath);

  const entryPath = join(applications, `${APP_ID}.desktop`);
  await writeFile(entryPath, desktopEntry(fileURLToPath(LAUNCHER)), {
    mode: 0o755,
  });

  await refresh("update-desktop-database", [applications]);
  await refresh("gtk-update-icon-cache", [
    "-f",
    "-t",
    join(dataHome, "icons", "hicolor"),
  ]);

  return { entryPath, iconPath };
}

/**
 * A Start Menu shortcut, created through the shell's own COM object.
 *
 * A `.lnk` is a binary format only the shell writes correctly, so this is the
 * supported way to produce one without shipping a native dependency.
 *
 * The icon is the committed `.ico`, pointed at where it sits in the checkout.
 * A shortcut references an icon file rather than embedding it, so moving or
 * deleting the checkout leaves a shortcut drawn with node's icon — the same
 * thing that happens to its target, which would not run either.
 */
async function installStartMenuShortcut() {
  const programs = startMenuProgramsDir();
  await mkdir(programs, { recursive: true });
  const entryPath = join(programs, `${APP_NAME}.lnk`);

  const iconPath = fileURLToPath(ICON_ICO);
  const ok = await runPowerShell(
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:EGO_LNK_PATH)\n" +
      "$s.TargetPath = $env:EGO_LNK_TARGET\n" +
      "$s.Arguments = $env:EGO_LNK_ARGS\n" +
      "$s.WorkingDirectory = $env:EGO_LNK_CWD\n" +
      "$s.Description = $env:EGO_LNK_DESC\n" +
      "$s.IconLocation = $env:EGO_LNK_ICON\n" +
      "$s.Save()",
    {
      env: {
        EGO_LNK_PATH: entryPath,
        // Same reason as the XDG entry: pin the interpreter running the
        // installer, because the shell will not resolve `node` from your shell's
        // PATH when you click the shortcut.
        EGO_LNK_TARGET: process.execPath,
        EGO_LNK_ARGS: `"${fileURLToPath(LAUNCHER)}" --spaces`,
        EGO_LNK_CWD: homedir(),
        EGO_LNK_DESC: "The browser you and your AI agents share",
        EGO_LNK_ICON: iconPath,
      },
    },
  );
  if (!ok) throw new Error(`could not create the Start Menu shortcut at ${entryPath}`);

  return { entryPath, iconPath };
}

export async function installDesktopEntry() {
  return IS_WINDOWS ? installStartMenuShortcut() : installXdgEntry();
}
