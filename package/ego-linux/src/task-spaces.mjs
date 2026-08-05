import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { agentIdentity } from "./agent-identity.mjs";
import { STATE_DIR, TASK_SPACE_FILE } from "./paths.mjs";

/**
 * Task spaces, emulated as tracked sets of tabs.
 *
 * The app's Space is isolated *and* inherits your login state. On stock Chromium
 * those two properties look like they pull apart:
 *
 *   Target.createBrowserContext -> real isolation, but a blank cookie jar
 *   sharing the default profile -> your real logins, but no isolation
 *
 * They don't: the empty jar can be filled. A space owns a browser context seeded
 * from the default jar at creation, so it gets both — see createSeededContext
 * below and docs/isolation-with-inherited-logins.md. The seed is a point-in-time
 * copy, not live shared state, and a space that fails to get a context falls
 * back to the shared default jar.
 *
 * Spaces deliberately do NOT get their own browser window. That was the first
 * design, and it was measurably worse: a headless Chrome does not render tabs in
 * background windows, so `document.elementFromPoint` returned null for pages
 * living in a non-foreground window. That broke hit-testing, which in turn made
 * the harness's input-fallback path re-synthesise drags that had already landed
 * (see driver/pointer.ts finishDragProbe) — every canvas case in the upstream
 * e2e suite failed or double-counted strokes. One window, tracked tab sets.
 *
 * Each heredoc is a fresh Node process, so state lives in a file, not memory.
 */

const EMPTY = { spaces: [], selectedId: null, nextId: 1 };

export function createTaskSpacesApi(cdp) {
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
      state.spaces.some((space) => (space.targetIds || []).some((id) => live.has(id)))
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
      if (space.id === state.selectedId) return false;
      // Ever held a real page => not abandoned, only between pages.
      if (space.lastContentAt) return false;
      if (!space.createdAt || Date.now() - space.createdAt < ABANDONED_AFTER_MS) return false;
      const tabs = (space.targetIds || []).map((id) => live.get(id)).filter(Boolean);
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

    const surviving = state.spaces.filter((space) => space.targetIds.length > 0);
    if (surviving.length !== state.spaces.length) {
      // Losing its last tab is how a space ends when the user closes tabs by
      // hand, so its context has to go the same way closeTaskSpace disposes
      // one. Dropping the record alone would strand a live context holding a
      // full copy of the seeded cookie jar until the browser restarts.
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

  /**
   * The harness selects a space with useTaskSpace() and then calls handOff /
   * takeOver / complete / close with NO arguments — they act on whatever is
   * currently selected (see helpers.ts:326-354). Only useTaskSpace, claim and
   * create are passed an id.
   */
  async function requireSpace(state, id, op) {
    const wanted = id === undefined || id === null ? state.selectedId : Number(id);
    const space = state.spaces.find((candidate) => candidate.id === wanted);
    if (!space) {
      throw new Error(
        id === undefined || id === null
          ? `${op}: no task space is selected`
          : `${op}: task space not found: ${id}`,
      );
    }
    return space;
  }

  /** Bring the space's own tab to the front, so the agent lands back on it. */
  async function focusSpace(space) {
    const live = await livePageTargets();
    const targetId = space.targetIds.find((id) => live.has(id));
    if (targetId) {
      await cdp.call("Target.activateTarget", { targetId }).catch(() => {});
    }
  }

  /**
   * Give a space its own cookie jar, pre-filled with the user's.
   *
   * Target.createBrowserContext isolates for real, but starts empty — which on
   * its own would log the agent out of everything, so this port used to take a
   * bare window instead and accept a shared jar. Seeding the new context from
   * the default jar gets both properties at once: measurements and the two
   * reproducible experiments are in docs/isolation-with-inherited-logins.md.
   *
   * These calls carry no sessionId, so the transport sends them at the browser
   * level, which is where browserContextId is accepted.
   *
   * Returns null if the browser refuses a context, so a space degrades to the
   * previous window-only behaviour rather than failing to open at all.
   */
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
      const space = state.spaces?.find(
        (candidate) => candidate.id === state.selectedId,
      );
      return space?.browserContextId ?? null;
    } catch {
      return null;
    }
  }

  async function disposeContext(browserContextId) {
    await cdp
      .call("Target.disposeBrowserContext", { browserContextId })
      .catch(() => {});
  }

  async function createSeededContext() {
    let browserContextId;
    try {
      ({ browserContextId } = await cdp.call("Target.createBrowserContext", {}));
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
      const space = state.spaces.find((candidate) => candidate.id === state.selectedId);
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
      const browserContextId = await createSeededContext();
      let targetId;
      try {
        ({ targetId } = await cdp.call("Target.createTarget", {
          url: "about:blank",
          ...(browserContextId ? { browserContextId } : {}),
        }));
      } catch (err) {
        // Nothing will ever reference this context if the space fails to open.
        if (browserContextId) await disposeContext(browserContextId);
        throw err;
      }
      await cdp.call("Target.activateTarget", { targetId }).catch(() => {});

      const space = {
        id: state.nextId,
        taskId: state.nextId,
        name: String(name ?? `task ${state.nextId}`),
        createdAt: Date.now(),
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
      await writeState(state);
      return space;
    },

    async useTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "useTaskSpace");
      state.selectedId = space.id;
      await writeState(state);
      await focusSpace(space);
      return { done: true };
    },

    async claimTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "claimTaskSpace");
      space.ownership = "agent";
      state.selectedId = space.id;
      await writeState(state);
      await focusSpace(space);
      return space;
    },

    async handOffTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "handOffTaskSpace");
      space.ownership = "agentDelegatedToUser";
      await writeState(state);
      return { done: true };
    },

    async takeOverTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "takeOverTaskSpace");
      space.ownership = "agent";
      state.selectedId = space.id;
      await writeState(state);
      await focusSpace(space);
      return { done: true };
    },

    // Only the `keep: true` path reaches here; the harness routes `keep: false`
    // to closeTaskSpace instead (helpers.ts:299-315).
    async completeTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "completeTaskSpace");
      space.ownership = "user";
      await writeState(state);
      return { done: true };
    },

    async closeTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "closeTaskSpace");
      for (const targetId of space.targetIds) {
        await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
      }
      if (space.browserContextId) {
        // Also drops the space's cookie jar, which is the point of having one.
        await disposeContext(space.browserContextId);
      }
      state.spaces = state.spaces.filter((candidate) => candidate.id !== space.id);
      if (state.selectedId === space.id) state.selectedId = null;
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
      if (!state.selectedId) return null;
      const space = state.spaces.find((candidate) => candidate.id === state.selectedId);
      if (!space) return null;
      return {
        browserContextId: space.browserContextId || null,
        targetIds: new Set(space.targetIds || []),
      };
    },

    async createTabInSelectedSpace(tabs, url) {
      const state = await readState();
      const space = state.spaces.find((candidate) => candidate.id === state.selectedId);
      // Open it inside the space's context, so every tab of a space shares that
      // space's jar rather than the first tab being isolated and the rest not.
      let result;
      try {
        result = await tabs.createTab(url, space?.browserContextId);
      } catch (error) {
        // Browser contexts die with the browser, but the selected space's id
        // outlives it in the state file. Chrome then rejects the create with
        // "Failed to find browser context", which used to leave the port unable
        // to open any tab at all after a restart. Fall back to the default jar
        // and forget the dead id — the space stops being isolated, which is
        // already true, rather than stopping working.
        if (!space?.browserContextId || !/browser context/i.test(String(error?.message))) {
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
  };
}
