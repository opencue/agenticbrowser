import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { processAncestry } from "./platform.mjs";

/**
 * Who is opening this space.
 *
 * The panel's right-hand label mirrors the native Space category ("Personal",
 * "Work"). On a cue-managed machine the useful equivalent is the agent profile
 * that opened the space, so a glance at the overview answers "which of my agents
 * is doing this" rather than just "an agent is".
 *
 * Read at creation time, from the environment of the process that ran the
 * heredoc — the browser itself has no idea who is driving it.
 */

/**
 * cue's per-profile runtime directory, as it appears inside an environment
 * variable. Written with both separators because the same variable is spelled
 * with backslashes when a cue-managed session runs on Windows.
 */
const RUNTIME_MARKER = /[\\/]\.config[\\/]cue[\\/]runtime[\\/]/;

/** cue launches its sessions against a per-profile runtime directory. */
function profileFromEnvironment() {
  for (const value of Object.values(process.env)) {
    if (typeof value !== "string") continue;
    const match = RUNTIME_MARKER.exec(value);
    if (!match) continue;
    const rest = value.slice(match.index + match[0].length);
    const name = rest.split(/[\\/]/)[0];
    if (name) return name;
  }
  return null;
}

/** Directories can pin a profile; walk up like cue itself does. */
function profileFromPinFile(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 12; depth += 1) {
    const pin = join(dir, ".cue.profile");
    if (existsSync(pin)) {
      try {
        const name = readFileSync(pin, "utf8").trim();
        if (name) return name;
      } catch {
        // unreadable pin is the same as no pin
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Which agent harness is driving this run.
 *
 * The cursor overlay labels itself with this, so a user watching the window can
 * see who is doing the clicking. It used to be the literal string "Claude",
 * which meant a codex run drew a Claude badge.
 *
 * Read from the process ancestry, not the environment. The CLI is a grandchild
 * of the harness that ran the heredoc, so the process table answers the
 * question outright (see processAncestry() in platform.mjs).
 * Sniffing environment variables gets it wrong in both directions: a shell
 * profile that exports anything `CODEX_*` makes a Claude session look like codex
 * (`CODEX_AUTH_SKIP_TTY_RESTORE` is exported on this developer's machine and is
 * set inside Claude sessions), and a harness that exports no marker of its own
 * would stay invisible.
 *
 * Adding a harness is one row in the table below. The name is what the OS
 * reports as the process name, which for a Node-based CLI may be `node` rather
 * than the tool's name; Windows' `.exe` suffix is stripped before it gets here,
 * so one row covers both platforms.
 */
const HARNESS_NAMES = new Map([
  ["codex", "Codex"],
  ["claude", "Claude"],
]);

export function agentName({ ancestry = processAncestry } = {}) {
  const override = process.env.EGO_LINUX_CURSOR_NAME;
  if (override) return override;
  let names = [];
  try {
    names = ancestry();
  } catch {
    // A cursor label is never worth failing an action over.
  }
  for (const comm of names) {
    const name = HARNESS_NAMES.get(comm);
    if (name) return name;
  }
  // Naming the wrong agent is worse than naming none.
  return "Agent";
}

export function agentIdentity(cwd = process.cwd()) {
  // The Spaces panel's own daemon inherits the environment of whichever session
  // happened to start it. A space you create by hand from the panel is yours,
  // not that profile's, so the daemon opts out of attribution entirely.
  if (process.env.EGO_LINUX_PANEL === "1") {
    return { profile: null, session: null };
  }
  const profile = profileFromEnvironment() || profileFromPinFile(cwd) || null;
  const session = process.env.CLAUDE_CODE_SESSION_ID || null;
  return {
    profile,
    // Enough to tell two concurrent sessions apart without being a wall of hex.
    session: session ? session.slice(0, 8) : null,
  };
}
