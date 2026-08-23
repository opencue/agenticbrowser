import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { agentIdentity } from "./agent-identity.mjs";
import { STATE_DIR, TASK_SPACE_FILE } from "./paths.mjs";

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
 *
 * Membership comes from tracked target ids by default, and from browserContextId
 * first for opt-in isolated or restart-adopted context-backed spaces.
 *
 * Each heredoc is a fresh Node process, so state lives in a file, not memory.
 */

const EMPTY = { spaces: [], selectedId: null, nextId: 1, closedSpaces: [] };
const USER_CONTROL_ERROR = "The task is under user control";
const USER_CONTROL_CODE = "EGO_TASK_SPACE_USER_IN_CONTROL";
const ISOLATED_STORAGE_RE =
  /^(1|true|yes|on|isolated|context|browser-context|cookie-copy)$/i;

/**
 * How many idle-closed spaces to remember.
 *
 * Enough that a session returning from a long break still finds its own, few
 * enough that the state file cannot grow without bound.
 */
const REMEMBERED_CLOSURES = 20;

export function createTaskSpacesApi(
  cdp,
  { shouldAutoFocus = async () => true } = {},
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

  function useIsolatedStorage() {
    return ISOLATED_STORAGE_RE.test(
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
      const parsed = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
      return { ...EMPTY, ...parsed };
    } catch {
      return { ...EMPTY };
    }
  }

  async function writeState(state) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(TASK_SPACE_FILE, JSON.stringify(state, null, 2));
  }

  function pageControlErrorSync() {
    try {
      const parsed = JSON.parse(readFileSync(TASK_SPACE_FILE, "utf8"));
      return pageControlErrorForState({
        ...EMPTY,
        ...parsed,
        spaces: parsed.spaces ?? [],
      });
    } catch {
      return null;
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
   */
  const ABANDONED_AFTER_MS = 120000;

  async function pruneAbandoned(state, live) {
    const doomed = state.spaces.filter((space) => {
      if (space.id === effectiveSelectedId(state)) return false;
      // Ever held a real page => not abandoned, only between pages.
      if (space.lastContentAt) return false;
      if (!space.createdAt || Date.now() - space.createdAt < ABANDONED_AFTER_MS)
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
    const closures = state.closedSpaces || [];
    for (const space of doomed) {
      closures.unshift({
        name: space.name,
        urls: (space.urls || []).filter((url) => url && url !== "about:blank"),
        closedAt: now,
        idleMinutes: Math.round((now - space.touchedAt) / 60000),
      });
    }
    state.closedSpaces = closures.slice(0, REMEMBERED_CLOSURES);

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
      (space) => space.targetIds.length > 0,
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

  /** Select the space for this agent connection and optionally foreground it. */
  async function focusSpace(space) {
    const live = await livePageTargets();
    const target = space.targetIds.map((id) => live.get(id)).find(Boolean);
    if (!target) return;
    cdp.selectTarget?.(target.targetId);
    if (!space.lastContentAt && isBlankUrl(target.url)) {
      return;
    }
    if (await shouldAutoFocus(target.targetId)) {
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
   * Put the space where a person can actually see it.
   *
   * focusSpace() selects the tab, which is all an agent ever needs — it observes
   * through CDP either way, so a buried window costs it nothing. Handing control
   * to the user is the one moment someone has to find that window on their own
   * desktop, and a minimized window behind an IDE looks exactly like nothing
   * happened.
   *
   * Resolves to whether the page was actually raised, with a reason when it was
   * not, so the caller can say the right thing instead of treating every failure
   * as "headless".
   */
  async function presentSpace(space) {
    const live = await livePageTargets().catch(() => new Map());
    const targetId = (space.targetIds || []).find((id) => live.has(id));
    if (!targetId) return { visible: false, reason: "no-live-tab" };
    await cdp.call("Target.activateTarget", { targetId }).catch(() => {});
    if (!(await hasWindow())) return { visible: false, reason: "headless" };

    try {
      const { windowId } = await cdp.call("Browser.getWindowForTarget", {
        targetId,
      });
      const { bounds } = await cdp.call("Browser.getWindowBounds", {
        windowId,
      });
      // Only a minimized window is restored. Sending "normal" unconditionally
      // would un-maximize a window the user maximized themselves — taking the
      // browser away from them on the call that hands it to them.
      if (bounds?.windowState === "minimized") {
        await cdp.call("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
      }
    } catch {
      // No window manager, or a compositor that refuses the bounds change.
    }

    let sessionId;
    try {
      ({ sessionId } = await cdp.call("Target.attachToTarget", {
        targetId,
        flatten: true,
      }));
      cdp.claimSession?.(sessionId);
      await cdp.call("Page.bringToFront", {}, sessionId);
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
    return (
      `ego-browser: handed off task space ${space.id}, but the browser window could not ` +
      `be raised. The user may need to open the ego lite browser window manually before ` +
      `acting on the page.\n`
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

  async function createBlankAnchor(browserContextId) {
    const params = {
      url: "about:blank",
      ...(browserContextId ? { browserContextId } : {}),
    };
    try {
      return await cdp.call("Target.createTarget", {
        ...params,
        background: true,
        focus: false,
      });
    } catch (error) {
      try {
        return await cdp.call("Target.createTarget", params);
      } catch {
        throw error;
      }
    }
  }

  async function paintBlankAnchor(targetId) {
    let sessionId;
    try {
      ({ sessionId } = await cdp.call("Target.attachToTarget", {
        targetId,
        flatten: true,
      }));
      await cdp.call(
        "Runtime.evaluate",
        {
          expression: String.raw`(() => {
            document.title = "Ego Lite agent space";
            document.body.innerHTML = "";
            document.body.style.cssText = [
              "margin:0",
              "font:15px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
              "background:#0f172a",
              "color:#e5e7eb",
              "display:grid",
              "place-items:center",
              "min-height:100vh"
            ].join(";");
            const card = document.createElement("main");
            card.style.cssText = [
              "max-width:560px",
              "padding:28px 32px",
              "border:1px solid rgba(148,163,184,.35)",
              "border-radius:18px",
              "background:rgba(15,23,42,.84)",
              "box-shadow:0 24px 80px rgba(0,0,0,.35)"
            ].join(";");
            card.innerHTML = [
              "<h1 style='margin:0 0 10px;font-size:22px'>Ego Lite agent space is ready</h1>",
              "<p style='margin:0;color:#cbd5e1;line-height:1.55'>The agent has created a browser task space and should navigate this tab shortly.</p>",
              "<p style='margin:14px 0 0;color:#94a3b8;line-height:1.55'>If this page stays here, the agent stopped before opening the requested site. It is safe to close this task space.</p>"
            ].join("");
            document.body.append(card);
          })()`,
          awaitPromise: false,
          returnByValue: false,
        },
        sessionId,
      );
    } catch {
      // Cosmetic only. A plain about:blank anchor is still functional.
    } finally {
      if (sessionId) {
        await cdp
          .call("Target.detachFromTarget", { sessionId })
          .catch(() => {});
      }
    }
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

  return {
    selectedContextId,

    /**
     * Remember that the selected space received a real page.
     *
     * This is what keeps a working space out of the abandoned sweep: its tab is
     * about:blank again on every navigation, so the current url can never tell
     * "never used" apart from "between pages". Recorded once, never cleared.
     */
    async noteContent() {
      const state = await readState();
      const space = state.spaces.find(
        (candidate) => candidate.id === effectiveSelectedId(state),
      );
      if (!space || space.lastContentAt) return;
      space.lastContentAt = Date.now();
      await writeState(state);
    },

    async listTaskSpaces() {
      const { state, live } = await reconcile(await readState());
      return { taskSpaces: state.spaces.map((space) => decorate(space, live)) };
    },

    async createTaskSpace(name) {
      const state = await readState();
      const browserContextId = useIsolatedStorage()
        ? await createSeededContext()
        : null;
      let targetId;
      try {
        ({ targetId } = await createBlankAnchor(browserContextId));
      } catch (err) {
        // Nothing will ever reference this context if the space fails to open.
        if (browserContextId) await disposeContext(browserContextId);
        throw err;
      }
      await paintBlankAnchor(targetId);

      const space = {
        id: state.nextId,
        taskId: state.nextId,
        name: String(name ?? `task ${state.nextId}`),
        createdAt: Date.now(),
        touchedAt: Date.now(),
        ownership: "agent",
        createdBy: "agent",
        // Which agent profile opened it — the overview's right-hand label.
        ...agentIdentity(),
        browserContextId,
        targetIds: [targetId],
      };
      state.spaces.push(space);
      state.nextId += 1;
      state.selectedId = space.id;
      pinnedSpaceId = space.id;

      // useOrCreate lands here whenever it cannot find the name it was given —
      // including when the idle sweep closed that very space while its agent was
      // away. Handing back what the old one held is the difference between
      // "resumed" and "started over without noticing". Consumed on use, so it is
      // reported once rather than on every later run of the same name.
      const closures = state.closedSpaces || [];
      const index = closures.findIndex((entry) => entry.name === space.name);
      if (index !== -1) {
        const [previous] = closures.splice(index, 1);
        state.closedSpaces = closures;
        space.previously = {
          closedAt: previous.closedAt,
          idleMinutes: previous.idleMinutes,
          urls: previous.urls,
          note:
            `a task space named ${JSON.stringify(space.name)} was closed after ` +
            `${previous.idleMinutes} minutes idle; this is a new, empty one. ` +
            (previous.urls.length
              ? `It had these pages open: ${previous.urls.join(", ")}`
              : "It had no pages open."),
        };
      }

      await writeState(state);
      return space;
    },

    async useTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "useTaskSpace");
      if (!isPanelProcess() && space.ownership === "user") {
        return userControlResult();
      }
      state.selectedId = space.id;
      pinnedSpaceId = space.id;
      // Selected first, so the space this session came back for is the one the
      // sweep protects rather than the one it closes.
      await pruneIdle(state);
      await writeState(state);
      await focusSpace(space);
      return { done: true };
    },

    async claimTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "claimTaskSpace");
      space.ownership = "agent";
      state.selectedId = space.id;
      pinnedSpaceId = space.id;
      await writeState(state);
      await focusSpace(space);
      return space;
    },

    async handOffTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "handOffTaskSpace");
      // Raised before ownership moves: past this line the agent stops driving,
      // so it is the last moment anything can put the page in front of the
      // person who is about to be asked to act on it.
      const presentation = await presentSpace(space);
      space.ownership = "agentDelegatedToUser";
      await writeState(state);
      if (!presentation.visible) {
        // Not an error. Headless is a supported way to run and CI hands off
        // with nobody watching; the handoff itself is still valid. It only
        // becomes a lie when the agent goes on to say "click the button in the
        // browser", so this says otherwise on the channel the agent reads.
        process.stderr.write(handoffWarning(space, presentation.reason));
      }
      return { done: true, ...presentation };
    },

    async presentTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "presentTaskSpace");
      const presentation = await presentSpace(space);
      await writeState(state);
      return { done: true, ...presentation };
    },

    async takeOverTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "takeOverTaskSpace");
      space.ownership = "agent";
      state.selectedId = space.id;
      pinnedSpaceId = space.id;
      await writeState(state);
      await focusSpace(space);
      return { done: true };
    },

    // Only the `keep: true` path reaches here; the harness routes `keep: false`
    // to closeTaskSpace instead (helpers.ts:299-315).
    async completeTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "completeTaskSpace");
      // `keep: true` exists to leave a page for the user to look at, so the same
      // rule as handoff applies: raise it, and report whether there was
      // anything to raise.
      const presentation = await presentSpace(space);
      space.ownership = "user";
      await writeState(state);
      return { done: true, ...presentation };
    },

    async closeTaskSpace(id) {
      const state = await readState();
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

    async createTabInSelectedSpace(tabs, url) {
      const state = await readState();
      const space = state.spaces.find(
        (candidate) => candidate.id === effectiveSelectedId(state),
      );
      if (!isPanelProcess() && isUserControlled(space)) {
        return userControlResult();
      }
      // A space is anchored by a tab — one with none is reaped as soon as it is
      // reconciled — so it opens on about:blank before it has anywhere to go.
      // Creating a second tab for the first navigation strands that anchor, and
      // the window then shows a blank tab beside the real page for the rest of
      // the session. Navigating the anchor is what it was opened for.
      //
      // Guarded on lastContentAt rather than on the tab's current url: a tab is
      // about:blank for a moment during every navigation, so matching on the url
      // alone would hijack a tab that is already carrying work. "Never held a
      // page" is only true of a space that has not started yet.
      const anchor =
        space && !space.lastContentAt ? await blankAnchor(space) : null;
      if (anchor && url && url !== "about:blank") {
        const { sessionId } = await cdp.call("Target.attachToTarget", {
          targetId: anchor,
          flatten: true,
        });
        await cdp.call("Page.navigate", { url }, sessionId);
        if (await shouldAutoFocus(anchor)) {
          await cdp
            .call("Target.activateTarget", { targetId: anchor })
            .catch(() => {});
        }
        return { targetId: anchor };
      }

      // Open it inside the space's context when opt-in isolated storage is
      // enabled; otherwise omit browserContextId so the tab shares the live
      // agent profile and its non-cookie storage.
      let result;
      try {
        result = await tabs.createTab(url, space?.browserContextId);
      } catch (error) {
        // Browser contexts die with the browser, but the selected space's id
        // outlives it in the state file. Chrome then rejects the create with
        // "Failed to find browser context", which used to leave the port unable
        // to open any tab at all after a restart. Fall back to the default jar
        // and forget the dead id — the space falls back to the shared live
        // profile rather than stopping working.
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
        await writeState(state);
      }
      return result;
    },

    pageControlErrorSync,
    assertAgentControl,
  };
}
