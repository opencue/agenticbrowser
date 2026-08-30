import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { agentIdentity } from "./agent-identity.mjs";
import { replaceFile } from "./atomic-write.mjs";
import { acquireDirectoryLock } from "./launch-lock.mjs";
import { STATE_DIR, TASK_SPACE_FILE } from "./paths.mjs";
import {
  ensurePrivateStateDir,
  securePrivateStateFile,
} from "./private-state.mjs";

/**
 * Task spaces, emulated as tracked sets of tabs.
 *
 * The native app's Space inherits the user's live login state, including the
 * origin storage sites use instead of cookies. Stock Chromium only gives us that
 * by using the profile's default browser context, so this port treats a Space as
 * an owned, tracked tab set in the shared agent profile. That makes cookies,
 * localStorage, IndexedDB and service-worker state live across Spaces.
 *
 * If you need stronger storage isolation more than live login parity, set
 * EGO_LINUX_TASK_SPACE_STORAGE=isolated. That revives the older context-backed
 * mode: a space owns a browser context seeded with a point-in-time cookie copy
 * from the default jar, while non-cookie storage stays isolated.
 * EGO_LINUX_TASK_SPACE_STORAGE=isolated-sync adds a bounded, point-in-time
 * localStorage copy for each HTTP(S) origin before its first document scripts
 * run. IndexedDB, CacheStorage and service-worker state remain isolated.
 *
 * Membership comes from tracked target ids by default, and from browserContextId
 * first for opt-in isolated or restart-adopted context-backed spaces.
 *
 * Each heredoc is a fresh Node process, so state lives in a file, not memory.
 */

const USER_CONTROL_ERROR = "The task is under user control";
const USER_CONTROL_CODE = "EGO_TASK_SPACE_USER_IN_CONTROL";
const STATE_UNAVAILABLE_CODE = "EGO_TASK_SPACE_STATE_UNAVAILABLE";
const TASK_SPACE_LOCK = join(STATE_DIR, "task-spaces.lock");
const ISOLATED_STORAGE_RE =
  /^(1|true|yes|on|isolated|isolated-sync|isolated-login|context|browser-context|cookie-copy)$/i;
const SYNCED_STORAGE_RE = /^(isolated-sync|isolated-login)$/i;
const MAX_LOCAL_STORAGE_ENTRIES = 1000;
const MAX_LOCAL_STORAGE_BYTES = 256 * 1024;

/**
 * How many idle-closed spaces to remember.
 *
 * Enough that a session returning from a long break still finds its own, few
 * enough that the state file cannot grow without bound.
 */
const REMEMBERED_CLOSURES = 20;

/**
 * Record what a swept space held, so the next agent to ask for the name learns
 * it is not the one it left behind.
 *
 * Both sweeps write here. An agent coming back to a space that is simply gone
 * has the same problem whichever rule removed it, and a sweep that closes
 * windows without leaving a line behind is indistinguishable from a browser
 * losing them — which is what it looked like from the outside.
 */
function rememberClosures(state, doomed, entryFor) {
  const closures = state.closedSpaces || [];
  for (const space of doomed) closures.unshift(entryFor(space));
  state.closedSpaces = closures.slice(0, REMEMBERED_CLOSURES);
}

/**
 * Say what happened to a space someone is asking for again, in the terms of the
 * rule that closed it.
 *
 * The two sweeps describe different failures and the fix differs with them: an
 * idle space was working and stopped being returned to, an abandoned one never
 * got anywhere at all. Telling an agent its space "went idle" when its own
 * previous run never navigated sends it looking for the wrong problem.
 */
function closureNote(name, previous) {
  const label = `a task space named ${JSON.stringify(name)}`;
  if (previous.reason === "abandoned") {
    return (
      `${label} was closed ${previous.unusedSeconds} seconds after it was ` +
      `created, having never loaded a page; this is a new, empty one. The run ` +
      `that opened it stopped before navigating anywhere.`
    );
  }
  return (
    `${label} was closed after ${previous.idleMinutes} minutes idle; this is ` +
    `a new, empty one. ` +
    (previous.urls?.length
      ? `It had these pages open: ${previous.urls.join(", ")}`
      : "It had no pages open.")
  );
}

export function createTaskSpacesApi(
  cdp,
  {
    shouldAutoFocus = async () => true,
    activateWindow = async () => true,
    guardBackground = async (_reason, operation) => operation(),
  } = {},
) {
  /**
   * Which space *this process* is working in.
   *
   * selectedId lives in a file every concurrent session shares, and each heredoc
   * writes it on the way in. So a second agent starting up silently reassigns
   * the first one: from that moment the first agent scoped its tab list, its
   * navigations and its cursor to the *other* session's space. The observed
   * symptom is a tab navigating away to an unrelated site while the agent that
   * opened it is still working in it, and the other agent finding a stranger's
   * page where its own should be.
   *
   * Once this process has chosen a space it pins it here and stops consulting
   * the shared value. The file still records the global selection — the Spaces
   * overview reads it, and it is the right answer for a fresh process that has
   * not chosen yet — it simply no longer decides what an already-committed
   * process acts on.
   */
  let pinnedSpaceId = null;
  // A normal CLI process should not leave behind a targetless state record when
  // its script returns before opening a page. Keep this process's creations
  // local so cleanup cannot close an empty space opened by another agent.
  const createdSpaceIds = new Set();

  function emptyState() {
    return { spaces: [], selectedId: null, nextId: 1, closedSpaces: [] };
  }

  function stateUnavailable(error) {
    const reason =
      error instanceof SyntaxError
        ? "contains invalid JSON"
        : `could not be read${error?.code ? ` (${error.code})` : ""}`;
    return Object.assign(
      new Error(
        `Task-space state ${reason}; refusing to overwrite ${TASK_SPACE_FILE}`,
        { cause: error },
      ),
      { error_code: STATE_UNAVAILABLE_CODE },
    );
  }

  function parseState(contents) {
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SyntaxError("task-space state must be a JSON object");
    }
    if (parsed.spaces !== undefined && !Array.isArray(parsed.spaces)) {
      throw new SyntaxError("task-space state spaces must be an array");
    }
    if (
      parsed.closedSpaces !== undefined &&
      !Array.isArray(parsed.closedSpaces)
    ) {
      throw new SyntaxError("task-space state closedSpaces must be an array");
    }
    return { ...emptyState(), ...parsed };
  }

  function useIsolatedStorage() {
    return ISOLATED_STORAGE_RE.test(
      String(process.env.EGO_LINUX_TASK_SPACE_STORAGE || ""),
    );
  }

  function syncIsolatedLocalStorage() {
    return SYNCED_STORAGE_RE.test(
      String(process.env.EGO_LINUX_TASK_SPACE_STORAGE || ""),
    );
  }

  function userControlResult() {
    return { error: USER_CONTROL_ERROR, error_code: USER_CONTROL_CODE };
  }

  function userControlException() {
    return Object.assign(new Error(USER_CONTROL_ERROR), {
      error_code: USER_CONTROL_CODE,
    });
  }

  function isUserControlled(space) {
    return (
      space?.ownership === "user" || space?.ownership === "agentDelegatedToUser"
    );
  }

  function isPanelProcess() {
    return process.env.EGO_LINUX_PANEL === "1";
  }

  function spaceForEffectiveSelection(state) {
    const wanted = effectiveSelectedId(state);
    return state.spaces?.find((candidate) => candidate.id === wanted) ?? null;
  }

  function pageControlErrorForState(state) {
    if (isPanelProcess()) return null;
    return isUserControlled(spaceForEffectiveSelection(state))
      ? userControlResult()
      : null;
  }

  /** The pinned space if it still exists, else whatever the file last recorded. */
  function effectiveSelectedId(state) {
    if (
      pinnedSpaceId !== null &&
      state.spaces.some((space) => space.id === pinnedSpaceId)
    ) {
      return pinnedSpaceId;
    }
    return state.selectedId;
  }

  async function readState() {
    try {
      return parseState(await readFile(TASK_SPACE_FILE, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw stateUnavailable(error);
    }
  }

  async function writeState(state) {
    // Same temp-and-rename this used inline, moved into one place so the
    // Windows half comes with it: there, a rename over a file another process
    // is reading fails with EPERM until that reader lets go, so replaceFile
    // retries rather than surfacing a moment as an error.
    await replaceFile(TASK_SPACE_FILE, JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
    await securePrivateStateFile(TASK_SPACE_FILE);
  }

  /** Hold every read-modify-write cycle across processes, not merely its write. */
  async function withStateLock(operation) {
    await ensurePrivateStateDir();
    const release = await acquireDirectoryLock(TASK_SPACE_LOCK, {
      pollMs: 5,
    });
    try {
      return await operation(await readState());
    } finally {
      await release();
    }
  }

  function pageControlErrorSync() {
    try {
      return pageControlErrorForState(
        parseState(readFileSync(TASK_SPACE_FILE, "utf8")),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      const unavailable = stateUnavailable(error);
      return {
        error: unavailable.message,
        error_code: unavailable.error_code,
      };
    }
  }

  async function pageControlError() {
    return pageControlErrorForState(await readState());
  }

  async function assertAgentControl() {
    if (await pageControlError()) throw userControlException();
  }

  async function livePageTargets() {
    const { targetInfos = [] } = await cdp.call("Target.getTargets");
    const live = new Map();
    for (const target of targetInfos) {
      if (target.type === "page" && !target.url.startsWith("devtools://")) {
        live.set(target.targetId, target);
      }
    }
    return live;
  }

  /**
   * Remove the exact blank tab created by `ego-browser --open` once a real
   * agent tab exists. Closing that creator-stamped anchor lets Chrome hide its
   * last window when the final task space closes, while a later task can map a
   * fresh window simply by creating its first target.
   *
   * The target is left alone if a person navigated it away from about:blank.
   * Never infer ownership from a blank URL: only the persisted target id is
   * eligible, so an unrelated user-created blank tab cannot be swept here.
   */
  async function closeUnusedWindowAnchor(state) {
    const targetId = state.windowAnchorTargetId;
    if (typeof targetId !== "string" || !targetId) return false;
    if (
      state.spaces.some((space) =>
        (space.targetIds || []).includes(targetId),
      )
    ) {
      delete state.windowAnchorTargetId;
      return false;
    }

    let target;
    try {
      target = (await livePageTargets()).get(targetId);
    } catch {
      return false;
    }
    if (!target || !isBlankUrl(target.url)) {
      delete state.windowAnchorTargetId;
      return false;
    }
    try {
      await cdp.call("Target.closeTarget", { targetId });
      delete state.windowAnchorTargetId;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-adopt a space's pages after the browser restarted.
   *
   * A space is identified by target ids, and those die with the browser. A
   * restart therefore wiped every space even though Chrome had restored the
   * very pages they described — the overview read "No spaces yet" next to a
   * window full of tabs. Remembered urls are what survive a restart, so they
   * are what the pages get matched back by.
   *
   * Only attempted when EVERY space lost EVERY tab at once, which is the
   * signature of a restart. Closing one space's tabs by hand leaves the others
   * alive, and must stay a deletion — otherwise a space would resurrect itself
   * from any other tab that happened to share its url.
   */
  function readoptRestoredPages(state, live) {
    if (state.spaces.length === 0) return false;
    if (
      state.spaces.some((space) =>
        (space.targetIds || []).some((id) => live.has(id)),
      )
    ) {
      return false;
    }

    const claimed = new Set();
    let changed = false;
    for (const space of state.spaces) {
      const wanted = new Set(space.urls || []);
      if (wanted.size === 0) continue;
      const matches = [...live.values()].filter(
        (target) => !claimed.has(target.targetId) && wanted.has(target.url),
      );
      if (matches.length === 0) continue;
      for (const target of matches) claimed.add(target.targetId);
      space.targetIds = matches.map((target) => target.targetId);
      space.activeTargetId = space.targetIds[0];
      // Browser contexts do not outlive the browser. The restored pages are in
      // the default jar, so the space is no longer isolated and must not keep
      // claiming a context id that now refers to nothing.
      if (space.browserContextId) space.browserContextId = null;
      space.restored = true;
      changed = true;
    }
    return changed;
  }

  /**
   * How long an unused space is given before it counts as abandoned.
   *
   * Tunable for the reason the idle window is: a run that opens a space and
   * then thinks for a while is doing nothing wrong, and only the person
   * watching the desktop knows how long that is worth waiting for.
   * EGO_LINUX_SPACE_ABANDONED_SEC=0 turns this sweep off entirely.
   */
  const ABANDONED_SECONDS = Number(
    process.env.EGO_LINUX_SPACE_ABANDONED_SEC ?? 120,
  );
  const ABANDONED_AFTER_MS =
    Number.isFinite(ABANDONED_SECONDS) && ABANDONED_SECONDS > 0
      ? ABANDONED_SECONDS * 1000
      : 0;

  /**
   * Close spaces that were opened and never used.
   *
   * A context-backed space cannot share a window with the default context, so
   * every space is its own window, and every space starts life as a single
   * about:blank tab. Anything that creates spaces in bulk — the e2e suite, a
   * crashed run, an agent that gave up — therefore leaves a drift of empty
   * windows across the desktop, which is what users actually notice.
   *
   * Only a space that is not selected, has *never* held a real page, holds
   * nothing but about:blank, and has had a grace period to receive its first
   * one is swept. "Never held a page" is the load-bearing condition: a tab is
   * momentarily about:blank on every navigation, so judging by the current url
   * alone would delete a working space mid-goto.
   *
   * What it closes it records, the same as the idle sweep: a window that opens
   * on the ready anchor and disappears two minutes later is the one thing about
   * task spaces people ask about, and the answer has to be readable from the
   * closure list rather than inferred from an empty desktop.
   */
  async function pruneAbandoned(state, live) {
    if (!ABANDONED_AFTER_MS) return false;
    const now = Date.now();
    const doomed = state.spaces.filter((space) => {
      if (space.id === effectiveSelectedId(state)) return false;
      // Ever held a real page => not abandoned, only between pages.
      if (space.lastContentAt) return false;
      if (!space.createdAt || now - space.createdAt < ABANDONED_AFTER_MS)
        return false;
      const tabs = (space.targetIds || [])
        .map((id) => live.get(id))
        .filter(Boolean);
      if (tabs.length === 0) return false;
      return tabs.every((target) => target.url === "about:blank");
    });
    if (doomed.length === 0) return false;

    for (const space of doomed) {
      for (const targetId of space.targetIds) {
        await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
      }
      if (space.browserContextId) await disposeContext(space.browserContextId);
    }

    // An abandoned space never held a page, so there is nothing to hand back —
    // but the name still has to be accounted for. Without this the window an
    // agent opened simply vanished, and the only way to find out why was to
    // read this file.
    rememberClosures(state, doomed, (space) => ({
      name: space.name,
      urls: [],
      closedAt: now,
      reason: "abandoned",
      unusedSeconds: Math.round((now - space.createdAt) / 1000),
    }));

    const gone = new Set(doomed.map((space) => space.id));
    state.spaces = state.spaces.filter((space) => !gone.has(space.id));
    return true;
  }

  /**
   * Close spaces nobody has come back to.
   *
   * A space outlives the process that opened it — every heredoc is a fresh Node
   * run — so nothing reaps one whose agent simply stopped returning. A session
   * that ends mid-task leaves its tabs open for good, and the count only climbs;
   * spaces from long-finished work were still holding pages days later.
   *
   * Idleness is measured from the last time something addressed the space, not
   * from when its page last changed: an agent reading one page for ten minutes
   * is working, and a space parked on a live dashboard is not. Live work keeps
   * itself alive by continuing, since every round touches the space it uses.
   *
   * It runs when a session commits to a space, not when spaces are listed.
   * Coming back to one starts by listing them — useOrCreate(id) resolves the id
   * against the list before it selects — so sweeping on the read path reaped the
   * very space the returning agent had just named, one call before the touch
   * a space that was alive until it was asked for, and a session that goes quiet
   * for longer than the window between two user turns is the normal case, not an
   * abandoned one. A poll of the Spaces panel had the same effect, so an open
   * overview quietly shortened every space's life.
   *
   * Selecting is the first moment the sweep knows which space is wanted, and
   * every path the harness takes ends there — switch, claim, create and reuse
   * all select afterwards — so nothing goes unswept by waiting for it.
   *
   * The selected space is never swept — it is the one someone is on right now —
   * and EGO_LINUX_SPACE_IDLE_MIN=0 turns the sweep off for anyone who would
   * rather clean up by hand.
   */
  const IDLE_MINUTES = Number(process.env.EGO_LINUX_SPACE_IDLE_MIN ?? 30);
  const IDLE_AFTER_MS =
    Number.isFinite(IDLE_MINUTES) && IDLE_MINUTES > 0
      ? IDLE_MINUTES * 60000
      : 0;

  async function pruneIdle(state) {
    if (!IDLE_AFTER_MS) return false;
    const now = Date.now();
    // Stamping is itself a state change worth persisting: drop it and every run
    // would re-stamp from scratch, so nothing would ever reach the threshold.
    let stamped = false;
    const doomed = state.spaces.filter((space) => {
      if (space.id === effectiveSelectedId(state)) return false;
      // touchedAt only moves when an API call names the space, and nothing a
      // person does at the keyboard produces one. A space handed over for a
      // login or a captcha, or completed with keep: true — which exists purely
      // to say "leave this page open" — would therefore go idle while it is
      // being used, and get closed out from under them.
      if (
        space.ownership === "user" ||
        space.ownership === "agentDelegatedToUser"
      ) {
        return false;
      }
      // Spaces that predate this field have no idle history, and judging them
      // by createdAt would sweep every one of them the first time the feature
      // runs — including whatever a colleague session is halfway through. Stamp
      // them instead and let them earn a full idle window from here.
      if (!space.touchedAt) {
        space.touchedAt = now;
        stamped = true;
        return false;
      }
      return now - space.touchedAt >= IDLE_AFTER_MS;
    });
    if (doomed.length === 0) return stamped;

    for (const space of doomed) {
      for (const targetId of space.targetIds || []) {
        await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
      }
      if (space.browserContextId) await disposeContext(space.browserContextId);
    }

    // Leave a trail. Without one, an agent coming back after a long break calls
    // useOrCreate with the same name, silently gets a brand-new empty space, and
    // carries on believing it resumed — the tabs it had open are simply gone and
    // nothing says so. A closed space that names itself and lists what it held
    // turns that into something the agent can put back.
    rememberClosures(state, doomed, (space) => ({
      name: space.name,
      urls: (space.urls || []).filter((url) => url && url !== "about:blank"),
      closedAt: now,
      reason: "idle",
      idleMinutes: Math.round((now - space.touchedAt) / 60000),
    }));

    const gone = new Set(doomed.map((space) => space.id));
    state.spaces = state.spaces.filter((space) => !gone.has(space.id));
    return true;
  }

  /** Drop tabs the user closed, and spaces left with none. */
  async function reconcile(state) {
    const live = await livePageTargets();
    let changed = false;

    for (const space of state.spaces) {
      const kept = (space.targetIds || []).filter((id) => live.has(id));
      if (kept.length !== (space.targetIds || []).length) {
        space.targetIds = kept;
        changed = true;
      }
      if (!kept.includes(space.activeTargetId)) {
        const replacement = kept[0];
        if (space.activeTargetId !== replacement) {
          space.activeTargetId = replacement;
          changed = true;
        }
      }
      // Remembered while the pages are alive, so a restart has something to
      // match them back by.
      if (kept.length > 0) {
        const urls = kept.map((id) => live.get(id).url).filter(Boolean);
        // A space that has ever held a real page is never "opened and never
        // used", however blank it looks right now — a tab is momentarily
        // about:blank on every navigation.
        if (!space.lastContentAt && urls.some((url) => url !== "about:blank")) {
          space.lastContentAt = Date.now();
          changed = true;
        }
        if (urls.join("\n") !== (space.urls || []).join("\n")) {
          space.urls = urls;
          changed = true;
        }
      }
    }

    if (readoptRestoredPages(state, live)) changed = true;
    if (await pruneAbandoned(state, live)) changed = true;

    const surviving = state.spaces.filter(
      (space) => space.targetIds.length > 0 || space.pendingFirstTab === true,
    );
    if (surviving.length !== state.spaces.length) {
      // Losing its last tab is how a space ends when the user closes tabs by
      // hand, so an opt-in isolated context has to go the same way
      // closeTaskSpace disposes one. Dropping the record alone would strand a
      // live context holding a full cookie copy until the browser restarts.
      for (const space of state.spaces) {
        if (space.targetIds.length === 0 && space.browserContextId) {
          await disposeContext(space.browserContextId);
        }
      }
      state.spaces = surviving;
      changed = true;
    }
    if (!state.spaces.some((space) => space.id === state.selectedId)) {
      state.selectedId = null;
      changed = true;
    }
    if (changed) await writeState(state);
    return { state, live };
  }

  function decorate(space, live) {
    return {
      ...space,
      taskId: space.taskId ?? space.id,
      recentTabTitles: space.targetIds
        .map((id) => live.get(id)?.title || "")
        .filter(Boolean),
    };
  }

  function isBlankUrl(url) {
    return !url || url === "about:blank";
  }

  /**
   * The harness selects a space with useTaskSpace() and then calls handOff /
   * takeOver / complete / close with NO arguments — they act on whatever is
   * currently selected (see helpers.ts:326-354). Only useTaskSpace, claim and
   * create are passed an id.
   */
  async function requireSpace(state, id, op) {
    const wanted =
      id === undefined || id === null ? effectiveSelectedId(state) : Number(id);
    const space = state.spaces.find((candidate) => candidate.id === wanted);
    if (!space) {
      throw new Error(
        id === undefined || id === null
          ? `${op}: no task space is selected`
          : `${op}: task space not found: ${id}`,
      );
    }
    // Every API call that names a space is a session saying it is still here.
    // That is what the idle sweep measures, and touching it in the one place
    // they all pass through is what keeps live work from being swept out from
    // under an agent that simply had a long think between rounds.
    space.touchedAt = Date.now();
    return space;
  }

  /**
   * Select the space for this agent connection and optionally foreground it.
   *
   * Linux agent work uses logical selection only. A brand-new targetless space
   * remains invisible until its first navigation creates the destination tab.
   */
  async function focusSpace(space, { allowActivation = true } = {}) {
    const live = await livePageTargets();
    const preferredIds = [
      space.activeTargetId,
      ...(space.targetIds || []).filter((id) => id !== space.activeTargetId),
    ].filter(Boolean);
    const target = preferredIds.map((id) => live.get(id)).find(Boolean);
    if (!target) return;
    // This is the agent connection's current target even when another tab stays
    // visible to the user. listTabs() consumes the hint and ensureSession()
    // attaches directly to it, so observation/input do not need foreground UI.
    cdp.selectTarget?.(target.targetId);
    if (!space.lastContentAt && isBlankUrl(target.url)) {
      return;
    }
    if (allowActivation && (await shouldAutoFocus(target.targetId))) {
      await cdp
        .call("Target.activateTarget", { targetId: target.targetId })
        .catch(() => {});
    }
  }

  /**
   * Whether this browser draws windows at all.
   *
   * Cached: a running browser cannot change mode, and every handoff asks.
   * `--headless=new` reports an ordinary product string ("Chrome/148.0.7778.167"),
   * so the user agent is the only field of Browser.getVersion that still names
   * the mode.
   */
  let windowed = null;
  async function hasWindow() {
    if (windowed === null) {
      try {
        const { userAgent } = await cdp.call("Browser.getVersion");
        windowed = !/headless/i.test(String(userAgent ?? ""));
      } catch {
        // A protocol hiccup is not evidence of a missing window. Assume there
        // is one rather than warn about a browser the user is looking at.
        windowed = true;
      }
    }
    return windowed;
  }

  /**
   * Inspect the space without stealing keyboard focus by default.
   *
   * Agents often hand off while the user is typing in chat. Target activation,
   * restoring a minimized window, or Page.bringToFront would interrupt that
   * input. Keep selection logical to this CDP connection and only report whether
   * the managed browser already has a normal on-screen window. The user decides
   * when to click or restore it. Explicit, user-authorized presentation may
   * opt in through `allowFocus`.
   */
  async function presentSpace(space, { allowFocus = false } = {}) {
    const live = await livePageTargets().catch(() => new Map());
    const liveIds = (space.targetIds || []).filter((id) => live.has(id));
    const hintedIds = [
      cdp.activeHint?.(),
      cdp.attachedHint?.(),
      space.activeTargetId,
    ].filter((id) => id && liveIds.includes(id));
    const targetId =
      hintedIds.find((id) => !isBlankUrl(live.get(id)?.url)) ||
      liveIds.find((id) => !isBlankUrl(live.get(id)?.url)) ||
      hintedIds[0] ||
      liveIds[0];
    if (!targetId) return { visible: false, reason: "no-live-tab" };
    if (allowFocus) {
      await cdp.call("Target.activateTarget", { targetId }).catch(() => {});
    } else {
      cdp.selectTarget?.(targetId);
    }
    if (!(await hasWindow())) return { visible: false, reason: "headless" };

    try {
      const { windowId } = await cdp.call("Browser.getWindowForTarget", {
        targetId,
      });
      const { bounds } = await cdp.call("Browser.getWindowBounds", {
        windowId,
      });
      if (bounds?.windowState === "minimized") {
        if (!allowFocus) return { visible: false, reason: "minimized" };
        await cdp.call("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
      }
    } catch {
      if (!allowFocus) {
        return { visible: false, reason: "window-unavailable" };
      }
    }

    if (!allowFocus) return { visible: true };

    let sessionId;
    try {
      ({ sessionId } = await cdp.call("Target.attachToTarget", {
        targetId,
        flatten: true,
      }));
      cdp.claimSession?.(sessionId);
      await cdp.call("Page.bringToFront", {}, sessionId);
      if ((await activateWindow({ targetId })) !== true) {
        return { visible: false, reason: "raise-failed" };
      }
      return { visible: true };
    } catch {
      return { visible: false, reason: "raise-failed" };
    } finally {
      if (sessionId) {
        await cdp
          .call("Target.detachFromTarget", { sessionId })
          .catch(() => {});
        cdp.releaseSession?.(sessionId);
      }
    }
  }

  function handoffWarning(space, reason) {
    if (reason === "headless") {
      return (
        `ego-browser: handed off task space ${space.id}, but this browser has no window ` +
        `on screen — the user cannot see the page or act on it. Do not ask them to click, ` +
        `log in, or solve a captcha here. Get a visible browser first: unset ` +
        `EGO_LINUX_HEADLESS, then run \`ego-browser --open\`.\n`
      );
    }
    if (reason === "no-live-tab") {
      return (
        `ego-browser: handed off task space ${space.id}, but it has no live tab left — ` +
        `there is no page for the user to see or act on. Reopen the page or start a ` +
        `fresh task space before asking the user to click, log in, or solve a captcha.\n`
      );
    }
    if (reason === "minimized") {
      return (
        `ego-browser: handed off task space ${space.id} without stealing focus, but the ` +
        `ego lite browser window is minimized. The user must restore it manually before ` +
        `acting on the page.\n`
      );
    }
    return (
      `ego-browser: handed off task space ${space.id} without stealing focus, but its ` +
      `browser window could not be confirmed on screen. The user may need to open the ` +
      `ego lite browser window manually before acting on the page.\n`
    );
  }

  /**
   * The selected space's context id, read synchronously.
   *
   * Sync because its only caller is the transport rewriting an outgoing payload
   * on its way to the socket, which has nowhere to await. The state file is a
   * few hundred bytes and the rewrite only fires on Browser.setDownloadBehavior,
   * so this is not on any hot path.
   */
  function selectedContextId() {
    try {
      const state = JSON.parse(readFileSync(TASK_SPACE_FILE, "utf8"));
      const wanted = effectiveSelectedId({
        ...state,
        spaces: state.spaces ?? [],
      });
      const space = state.spaces?.find((candidate) => candidate.id === wanted);
      return space?.browserContextId ?? null;
    } catch {
      return null;
    }
  }

  /** The space's own still-blank tab, if it has exactly that and nothing else. */
  async function blankAnchor(space) {
    const ids = space.targetIds || [];
    if (ids.length !== 1) return null;
    const live = await livePageTargets().catch(() => new Map());
    const target = live.get(ids[0]);
    return target && isBlankUrl(target.url) ? target.targetId : null;
  }

  async function disposeContext(browserContextId) {
    await cdp
      .call("Target.disposeBrowserContext", { browserContextId })
      .catch(() => {});
  }

  /**
   * Give an opt-in isolated space its own cookie jar, pre-filled with the user's.
   *
   * Target.createBrowserContext isolates storage for real, but starts empty.
   * Seeding the new context from the default jar recovers cookie-backed logins
   * while deliberately keeping non-cookie storage private. These calls carry no
   * sessionId, so the transport sends them at the browser level, where
   * browserContextId is accepted.
   *
   * Returns null if the browser refuses a context, so a space degrades to the
   * shared-profile default rather than failing to open at all.
   */
  async function createSeededContext() {
    let browserContextId;
    try {
      ({ browserContextId } = await cdp.call(
        "Target.createBrowserContext",
        {},
      ));
    } catch {
      return null;
    }
    if (!browserContextId) return null;
    try {
      const { cookies } = await cdp.call("Storage.getCookies", {});
      if (cookies?.length) {
        await cdp.call("Storage.setCookies", { browserContextId, cookies });
      }
    } catch {
      // An unseeded context is still a usable space, just a logged-out one.
    }
    return browserContextId;
  }

  function storageOrigin(url) {
    try {
      const parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol) ? parsed.origin : null;
    } catch {
      return null;
    }
  }

  /** Read a bounded localStorage snapshot from the live default profile. */
  async function defaultLocalStorage(url) {
    const origin = storageOrigin(url);
    if (!origin) return null;
    const { targetInfos = [] } = await cdp.call(
      "Target.getTargets",
      {},
      undefined,
      { timeoutMs: 3000 },
    );
    const { browserContextIds = [] } = await cdp.call(
      "Target.getBrowserContexts",
      {},
      undefined,
      { timeoutMs: 3000 },
    );
    const isolatedContexts = new Set(browserContextIds);
    const defaultTargets = targetInfos.filter(
      (candidate) =>
        candidate.type === "page" &&
        !isolatedContexts.has(candidate.browserContextId),
    );
    let target = defaultTargets.find(
      (candidate) => storageOrigin(candidate.url) === origin,
    );
    let temporary = false;
    if (!target) {
      const sourceUrl = `${origin}/`;
      const created = await guardBackground(
        "create-storage-source-tab",
        async () => {
          try {
            return await cdp.call("Target.createTarget", {
              url: sourceUrl,
              background: true,
              focus: false,
            });
          } catch (error) {
            try {
              return await cdp.call("Target.createTarget", { url: sourceUrl });
            } catch {
              throw error;
            }
          }
        },
      );
      target = { targetId: created.targetId };
      temporary = true;
    }

    let sessionId;
    try {
      ({ sessionId } = await cdp.call("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      }));
      cdp.claimSession?.(sessionId);
      if (temporary) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const current = await cdp
            .call(
              "Runtime.evaluate",
              { expression: "location.origin", returnByValue: true },
              sessionId,
              { timeoutMs: 1000 },
            )
            .catch(() => null);
          if (current?.result?.value === origin) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      const { entries = [] } = await cdp.call(
        "DOMStorage.getDOMStorageItems",
        {
          storageId: { securityOrigin: origin, isLocalStorage: true },
        },
        sessionId,
        { timeoutMs: 3000 },
      );
      const selected = [];
      let bytes = 0;
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const key = String(entry[0]);
        const value = String(entry[1]);
        const nextBytes = Buffer.byteLength(key) + Buffer.byteLength(value);
        if (
          selected.length >= MAX_LOCAL_STORAGE_ENTRIES ||
          bytes + nextBytes > MAX_LOCAL_STORAGE_BYTES
        ) {
          break;
        }
        selected.push([key, value]);
        bytes += nextBytes;
      }
      return { origin, entries: selected };
    } catch {
      return null;
    } finally {
      if (sessionId) {
        await cdp
          .call("Target.detachFromTarget", { sessionId })
          .catch(() => {});
        cdp.releaseSession?.(sessionId);
      }
      if (temporary && target?.targetId) {
        await cdp
          .call("Target.closeTarget", { targetId: target.targetId })
          .catch(() => {});
      }
    }
  }

  /**
   * Create the isolated bootstrap target needed to install localStorage before
   * the destination's first scripts run. This is delayed until navigation, so
   * merely creating the space still opens no tab or window.
   */
  async function createStorageSeedTarget(browserContextId) {
    const params = { url: "about:blank", browserContextId };
    return guardBackground("create-storage-seed-tab", async () => {
      try {
        return await cdp.call("Target.createTarget", {
          ...params,
          background: false,
          focus: false,
        });
      } catch (error) {
        try {
          return await cdp.call("Target.createTarget", params);
        } catch {
          throw error;
        }
      }
    });
  }

  /**
   * Create an isolated target whose first document receives a point-in-time
   * localStorage copy before the site's own scripts execute.
   */
  async function createLocalStorageSeededTarget(browserContextId, url) {
    const seed = await defaultLocalStorage(url);
    if (!seed?.entries?.length) return null;

    let targetId;
    let sessionId;
    try {
      ({ targetId } = await createStorageSeedTarget(browserContextId));
      ({ sessionId } = await cdp.call("Target.attachToTarget", {
        targetId,
        flatten: true,
      }));
      cdp.claimSession?.(sessionId);
      await cdp.call("Page.enable", {}, sessionId, { timeoutMs: 3000 });
      const marker = `__egoStorageSeeded:${seed.origin}`;
      const source = `(() => {
        if (location.origin !== ${JSON.stringify(seed.origin)}) return;
        try {
          if (sessionStorage.getItem(${JSON.stringify(marker)})) return;
          for (const [key, value] of ${JSON.stringify(seed.entries)}) {
            localStorage.setItem(key, value);
          }
          sessionStorage.setItem(${JSON.stringify(marker)}, "1");
        } catch {}
      })()`;
      await cdp.call(
        "Page.addScriptToEvaluateOnNewDocument",
        { source },
        sessionId,
        { timeoutMs: 3000 },
      );
      await cdp.call("Page.navigate", { url }, sessionId, { timeoutMs: 10000 });
      cdp.selectTarget?.(targetId);
      return { targetId };
    } catch (error) {
      if (targetId) {
        await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
      }
      if (/browser context/i.test(String(error?.message))) throw error;
      return null;
    } finally {
      if (sessionId) {
        await cdp
          .call("Target.detachFromTarget", { sessionId })
          .catch(() => {});
        cdp.releaseSession?.(sessionId);
      }
    }
  }

  return {
    selectedContextId,

    /** Remember only the blank target this launcher invocation created. */
    async rememberWindowAnchor(targetId) {
      if (typeof targetId !== "string" || !targetId) return false;
      return withStateLock(async (state) => {
        state.windowAnchorTargetId = targetId;
        await writeState(state);
        return true;
      });
    },

    /**
     * Remember that the selected space received a real page.
     *
     * This is what keeps a working space out of the abandoned sweep: its tab is
     * about:blank again on every navigation, so the current url can never tell
     * "never used" apart from "between pages". Recorded once, never cleared.
     */
    async noteContent() {
      return withStateLock(async (state) => {
        const space = state.spaces.find(
          (candidate) => candidate.id === effectiveSelectedId(state),
        );
        if (!space || space.lastContentAt) return;
        space.lastContentAt = Date.now();
        await writeState(state);
      });
    },

    async listTaskSpaces() {
      return withStateLock(async (state) => {
        const reconciled = await reconcile(state);
        return {
          taskSpaces: reconciled.state.spaces.map((space) =>
            decorate(space, reconciled.live),
          ),
        };
      });
    },

    async createTaskSpace(name) {
      return withStateLock(async (state) => {
        const identity = agentIdentity();
        const wantedName = String(name ?? `task ${state.nextId}`);
        const browserContextId = useIsolatedStorage()
          ? await createSeededContext()
          : null;
        // Keep every new space targetless until the first navigation. This makes
        // creation invisible and lets the first tab open directly at the site
        // the agent requested instead of briefly showing a ready/about:blank page.

        const space = {
          id: state.nextId,
          taskId: state.nextId,
          name: wantedName,
          createdAt: Date.now(),
          touchedAt: Date.now(),
          ownership: "agent",
          createdBy: "agent",
          // Which agent profile opened it — the overview's right-hand label.
          ...identity,
          browserContextId,
          ...(browserContextId && syncIsolatedLocalStorage()
            ? { storageSeed: "localStorage" }
            : {}),
          targetIds: [],
          activeTargetId: null,
          pendingFirstTab: true,
        };
        state.spaces.push(space);
        state.nextId += 1;
        state.selectedId = space.id;
        pinnedSpaceId = space.id;

        // useOrCreate lands here whenever it cannot find the name it was given —
        // including when a sweep closed that very space while its agent was
        // away. Handing back what the old one held is the difference between
        // "resumed" and "started over without noticing". Consumed on use, so it
        // is reported once rather than on every later run of the same name.
        const closures = state.closedSpaces || [];
        const index = closures.findIndex((entry) => entry.name === space.name);
        if (index !== -1) {
          const [previous] = closures.splice(index, 1);
          state.closedSpaces = closures;
          // Entries written before closures carried a reason can only be idle
          // ones: that was the only sweep that left any.
          const reason = previous.reason || "idle";
          space.previously = {
            closedAt: previous.closedAt,
            reason,
            ...(reason === "abandoned"
              ? { unusedSeconds: previous.unusedSeconds }
              : { idleMinutes: previous.idleMinutes }),
            urls: previous.urls,
            note: closureNote(space.name, { ...previous, reason }),
          };
        }

        await writeState(state);
        createdSpaceIds.add(space.id);
        return space;
      });
    },

    /** Close targetless spaces created by this process that never navigated. */
    async cleanupCreatedEmptySpaces() {
      if (createdSpaceIds.size === 0) return { closed: 0 };
      return withStateLock(async (state) => {
        const live = await livePageTargets();
        const now = Date.now();
        const doomed = state.spaces.filter((space) => {
          if (!createdSpaceIds.has(space.id)) return false;
          if (space.ownership !== "agent" || space.lastContentAt) return false;
          const ids = space.targetIds || [];
          if (ids.length === 0) return space.pendingFirstTab === true;
          const tabs = ids.map((id) => live.get(id)).filter(Boolean);
          return (
            tabs.length === ids.length &&
            tabs.every((target) => isBlankUrl(target.url))
          );
        });
        if (doomed.length === 0) return { closed: 0 };

        for (const space of doomed) {
          for (const targetId of space.targetIds || []) {
            await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
          }
          if (space.browserContextId) {
            await disposeContext(space.browserContextId);
          }
        }
        rememberClosures(state, doomed, (space) => ({
          name: space.name,
          urls: [],
          closedAt: now,
          reason: "abandoned",
          unusedSeconds: Math.max(
            0,
            Math.round((now - (space.createdAt || now)) / 1000),
          ),
        }));

        const gone = new Set(doomed.map((space) => space.id));
        state.spaces = state.spaces.filter((space) => !gone.has(space.id));
        if (gone.has(state.selectedId)) state.selectedId = null;
        if (gone.has(pinnedSpaceId)) pinnedSpaceId = null;
        for (const id of gone) createdSpaceIds.delete(id);
        await writeState(state);
        return { closed: doomed.length };
      });
    },

    /** Close every still-agent-owned space created by one exact session. */
    async cleanupAgentSessionSpaces(session) {
      if (typeof session !== "string" || !session) {
        return { closed: 0, skipped: 0, reason: "no-session" };
      }
      return withStateLock(async (state) => {
        const sameSession = state.spaces.filter(
          (space) => space.session === session,
        );
        const doomed = sameSession.filter(
          (space) =>
            space.createdBy === "agent" && space.ownership === "agent",
        );
        const skipped = sameSession.length - doomed.length;
        if (doomed.length === 0) return { closed: 0, skipped };

        for (const space of doomed) {
          for (const targetId of space.targetIds || []) {
            await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
          }
          if (space.browserContextId) {
            await disposeContext(space.browserContextId);
          }
        }

        const gone = new Set(doomed.map((space) => space.id));
        state.spaces = state.spaces.filter((space) => !gone.has(space.id));
        if (gone.has(state.selectedId)) state.selectedId = null;
        if (gone.has(pinnedSpaceId)) pinnedSpaceId = null;
        for (const id of gone) createdSpaceIds.delete(id);
        await writeState(state);
        return { closed: doomed.length, skipped };
      });
    },

    async useTaskSpace(id) {
      return withStateLock(async (state) => {
        const space = await requireSpace(state, id, "useTaskSpace");
        const readOnly = !isPanelProcess() && isUserControlled(space);
        state.selectedId = space.id;
        pinnedSpaceId = space.id;
        // Selected first, so this session's space is protected by the sweep.
        // A read-only observer must not perform cleanup as a side effect of
        // attaching to a space that is still in the user's hands.
        if (!readOnly) await pruneIdle(state);
        await writeState(state);
        await focusSpace(space, { allowActivation: !readOnly });
        return { done: true, ...(readOnly ? { readOnly: true } : {}) };
      });
    },

    async claimTaskSpace(id) {
      return withStateLock(async (state) => {
        const space = await requireSpace(state, id, "claimTaskSpace");
        space.ownership = "agent";
        state.selectedId = space.id;
        pinnedSpaceId = space.id;
        await writeState(state);
        await focusSpace(space);
        return space;
      });
    },

    async handOffTaskSpace(id) {
      return withStateLock(async (state) => {
        const space = await requireSpace(state, id, "handOffTaskSpace");
        // Availability is checked before ownership moves; this never focuses or
        // raises the managed browser over the user's current application.
        const presentation = await presentSpace(space);
        space.ownership = "agentDelegatedToUser";
        await writeState(state);
        if (!presentation.visible) {
          // Headless handoff is valid, but the caller must not claim it is seen.
          process.stderr.write(handoffWarning(space, presentation.reason));
        }
        return { done: true, ...presentation };
      });
    },

    async presentTaskSpace(id, { allowFocus = false } = {}) {
      return withStateLock(async (state) => {
        const space = await requireSpace(state, id, "presentTaskSpace");
        const presentation = await presentSpace(space, { allowFocus });
        await writeState(state);
        return { done: true, ...presentation };
      });
    },

    async takeOverTaskSpace(id) {
      return withStateLock(async (state) => {
        const space = await requireSpace(state, id, "takeOverTaskSpace");
        space.ownership = "agent";
        state.selectedId = space.id;
        pinnedSpaceId = space.id;
        await writeState(state);
        await focusSpace(space);
        return { done: true };
      });
    },

    // Only the `keep: true` path reaches here; the harness routes `keep: false`
    // to closeTaskSpace instead (helpers.ts:299-315).
    async completeTaskSpace(id) {
      return withStateLock(async (state) => {
        const space = await requireSpace(state, id, "completeTaskSpace");
        // `keep: true` leaves a page for the user without taking application focus.
        const presentation = await presentSpace(space);
        space.ownership = "user";
        await writeState(state);
        return { done: true, ...presentation };
      });
    },

    async closeTaskSpace(id) {
      return withStateLock(async (state) => {
        const space = await requireSpace(state, id, "closeTaskSpace");
        for (const targetId of space.targetIds) {
          await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
        }
        if (space.browserContextId) {
          // Also drops an opt-in isolated space's private cookie/storage jar.
          await disposeContext(space.browserContextId);
        }
        state.spaces = state.spaces.filter(
          (candidate) => candidate.id !== space.id,
        );
        if (state.selectedId === space.id) state.selectedId = null;
        if (pinnedSpaceId === space.id) pinnedSpaceId = null;
        await writeState(state);
        return { done: true };
      });
    },

    /**
     * Open a tab and attribute it to the selected space, so completing that
     * space closes the tabs it opened. Membership is tracked by the ids we
     * create rather than inferred from which window a tab landed in, which CDP
     * gives no way to control (Target.createTarget takes no window id). For a
     * space with a context the browser also enforces membership, but the id
     * list stays authoritative so context-less spaces behave identically.
     */
    /**
     * What listTabs() should show: the selected space's tabs.
     *
     * A browser context identifies membership exactly, so it is preferred. The
     * tracked target ids cover spaces that have no context — the fallback path,
     * and spaces re-adopted after a restart, whose context died with the
     * browser.
     */
    async selectedScope() {
      const state = await readState();
      if (!effectiveSelectedId(state)) return null;
      const space = state.spaces.find(
        (candidate) => candidate.id === effectiveSelectedId(state),
      );
      if (!space) return null;
      return {
        browserContextId: space.browserContextId || null,
        targetIds: new Set(space.targetIds || []),
      };
    },

    /** Internal metadata for Linux bridge calls that predate task-space ids. */
    async selectedTaskSpace() {
      const state = await readState();
      const wanted = effectiveSelectedId(state);
      if (!wanted) return null;
      const space = state.spaces.find((candidate) => candidate.id === wanted);
      return space ? { ...space } : null;
    },

    async createTabInSelectedSpace(tabs, url) {
      return withStateLock(async (state) => {
        const space = state.spaces.find(
          (candidate) => candidate.id === effectiveSelectedId(state),
        );
        if (!isPanelProcess() && isUserControlled(space)) {
          return userControlResult();
        }
        // Legacy spaces may still carry a never-used blank anchor. Reuse it so
        // upgrades do not strand that tab; new spaces are targetless instead.
        const anchor =
          space && !space.lastContentAt ? await blankAnchor(space) : null;
        if (anchor && url && url !== "about:blank") {
          let sessionId;
          try {
            ({ sessionId } = await cdp.call("Target.attachToTarget", {
              targetId: anchor,
              flatten: true,
            }));
            cdp.claimSession?.(sessionId);
            await cdp.call("Page.navigate", { url }, sessionId);
            space.activeTargetId = anchor;
            cdp.selectTarget?.(anchor);
            await writeState(state);
            if (await shouldAutoFocus(anchor)) {
              await cdp
                .call("Target.activateTarget", { targetId: anchor })
                .catch(() => {});
            }
            return { targetId: anchor };
          } finally {
            if (sessionId) {
              await cdp
                .call("Target.detachFromTarget", { sessionId })
                .catch(() => {});
              cdp.releaseSession?.(sessionId);
            }
          }
        }

        // Open in the selected context when isolation is explicitly enabled.
        let result;
        try {
          result =
            space?.browserContextId && space.storageSeed === "localStorage"
              ? (await createLocalStorageSeededTarget(
                  space.browserContextId,
                  url,
                )) || (await tabs.createTab(url, space.browserContextId))
              : await tabs.createTab(url, space?.browserContextId);
        } catch (error) {
          // A context can disappear on browser restart. Fall back to shared
          // storage and persist that recovery in the same transaction.
          if (
            !space?.browserContextId ||
            !/browser context/i.test(String(error?.message))
          ) {
            throw error;
          }
          space.browserContextId = null;
          space.restored = true;
          result = await tabs.createTab(url);
        }
        if (space && result.targetId) {
          space.targetIds.push(result.targetId);
          space.activeTargetId = result.targetId;
          delete space.pendingFirstTab;
          if (!space.lastContentAt && url && !isBlankUrl(url)) {
            space.lastContentAt = Date.now();
          }
          await closeUnusedWindowAnchor(state);
          await writeState(state);
        }
        return result;
      });
    },

    /** Remember the logical active tab so the next heredoc resumes it. */
    async noteActiveTarget(targetId) {
      if (!targetId) return;
      return withStateLock(async (state) => {
        const space = state.spaces.find(
          (candidate) => candidate.id === effectiveSelectedId(state),
        );
        if (!space?.targetIds?.includes(targetId)) return;
        if (space.activeTargetId === targetId) return;
        space.activeTargetId = targetId;
        space.touchedAt = Date.now();
        await writeState(state);
      });
    },

    pageControlErrorSync,
    assertAgentControl,
  };
}
