import { createSessionResolver } from "./session.mjs";

/**
 * The agent's cursor — the visible "something else is driving this page" mark.
 *
 * The native macOS app draws this itself, over the web view; on Linux the page
 * is the only surface the shim controls, so the cursor is a DOM overlay
 * injected into whichever page the harness is currently acting on. It follows
 * every pointer position the harness sends, pulses where it clicks, and carries
 * the agent's current task state as a label.
 *
 * Two properties keep it from interfering with the automation it illustrates:
 *
 *   - the host element is `pointer-events: none`, so `document.elementFromPoint`
 *     never returns it. That matters beyond cosmetics: the harness's wheel and
 *     drag fallbacks hit-test with elementFromPoint, and an overlay that
 *     answered those probes would swallow input meant for the page.
 *   - every render is fire-and-forget and swallows its own errors, so a page
 *     that refuses the injection, or navigates mid-flight, can never fail an
 *     action. The cursor is allowed to be missing; it is not allowed to break
 *     anything.
 *
 * The overlay is a Runtime.evaluate injection rather than a content script, so
 * it works on pages with a strict CSP and needs no extension.
 *
 * Env: EGO_LINUX_CURSOR=0 turns it off (it is drawn into screenshots, which is
 * usually wanted and occasionally not); EGO_LINUX_CURSOR_NAME renames it from
 * the default "Claude".
 */

const HOST_ID = "ego-agent-cursor-overlay";
const ACCENT = "#d97757";

export function createCursorApi(cdp, { listTabs }) {
  const enabled = process.env.EGO_LINUX_CURSOR !== "0";
  const name = process.env.EGO_LINUX_CURSOR_NAME || "Claude";
  const sessionForActiveTab = createSessionResolver(cdp, {
    listTabs,
    op: "cursor",
  });

  const state = { x: 0, y: 0, label: "", visible: true, placed: false };
  let dirty = false;
  let pendingPulse = false;
  let inFlight = false;

  /**
   * Coalesce renders: a drag dispatches mouse moves far faster than a CDP round
   * trip completes, so only the latest position is ever sent, and a pulse that
   * lands mid-flight is carried over to the next render rather than dropped.
   */
  function schedule() {
    dirty = true;
    if (inFlight) return;
    void flush();
  }

  async function flush() {
    if (!dirty || inFlight) return;
    inFlight = true;
    try {
      while (dirty) {
        dirty = false;
        const payload = {
          x: state.x,
          y: state.y,
          label: state.label,
          name,
          accent: ACCENT,
          hostId: HOST_ID,
          visible: state.visible && state.placed,
          pulse: pendingPulse,
        };
        pendingPulse = false;
        const sessionId = await sessionForActiveTab();
        await cdp.call(
          "Runtime.evaluate",
          {
            expression: `(${renderOverlay.toString()})(${JSON.stringify(payload)})`,
            returnByValue: false,
            awaitPromise: false,
            userGesture: false,
          },
          sessionId,
        );
      }
    } catch {
      // Cosmetic only: a closed tab, a page mid-navigation or a target that
      // rejected the evaluate must never surface as an automation failure.
    } finally {
      inFlight = false;
      if (dirty) void flush();
    }
  }

  return {
    /** Back ego.animationHighlightMouseToPosition(x, y). */
    moveTo(x, y) {
      if (!enabled) return { done: false, reason: "cursor disabled" };
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { done: false };
      if (state.placed && state.x === x && state.y === y) return { done: true };
      state.x = x;
      state.y = y;
      state.placed = true;
      schedule();
      return { done: true };
    },

    /** Back ego.setAgentTaskState(label) — the text shown next to the cursor. */
    setTaskState(taskState) {
      if (!enabled) return { done: false, reason: "cursor disabled" };
      const label = labelOf(taskState);
      if (label === state.label) return { done: true };
      state.label = label;
      schedule();
      return { done: true };
    },

    /** A click landed here: place the cursor and ripple. */
    pulseAt(x, y) {
      if (!enabled) return;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        state.x = x;
        state.y = y;
        state.placed = true;
      }
      pendingPulse = true;
      schedule();
    },

    /** Hidden while the space belongs to the user (handOffTaskSpace). */
    hide() {
      if (!enabled) return;
      if (!state.visible) return;
      state.visible = false;
      schedule();
    },

    /** Shown again when the agent resumes (takeOverTaskSpace). */
    show() {
      if (!enabled) return;
      if (state.visible) return;
      state.visible = true;
      schedule();
    },
  };
}

/**
 * Read the overlay back out of a page: where the cursor is, what it is doing,
 * and how long ago it last moved. The Spaces overview runs this in its own
 * process — the page is the only state the two share, since each heredoc is a
 * separate Node process with its own CDP connection.
 *
 * Returns null when no agent has acted in that page.
 */
export const CURSOR_PROBE_EXPRESSION = `(${probeOverlay.toString()})(${JSON.stringify(HOST_ID)})`;

function probeOverlay(hostId) {
  const host = document.getElementById(hostId);
  const state = host && host.__egoState;
  if (!state) return null;
  return {
    x: state.x,
    y: state.y,
    label: state.label || "",
    name: state.name || "",
    ageMs: Date.now() - state.at,
    // The overlay is viewport-fixed; a screenshot clip is not. Hand back what
    // the caller needs to convert, read now rather than at render time because
    // the page may have scrolled since.
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

/**
 * The harness passes a label string, but the native surface is documented only
 * as "task state" — accept the object form rather than printing [object Object].
 */
function labelOf(taskState) {
  if (taskState === null || taskState === undefined) return "";
  if (typeof taskState === "string") return taskState.slice(0, 120);
  if (typeof taskState === "object") {
    const text = taskState.label ?? taskState.state ?? taskState.text;
    return typeof text === "string" ? text.slice(0, 120) : "";
  }
  return String(taskState).slice(0, 120);
}

/**
 * The overlay itself, serialized with Function.prototype.toString() and run
 * inside the page on every update. It must stay self-contained: no imports, no
 * closure over anything in this module, and idempotent — it is re-entered for
 * every move, and re-creates itself after a navigation blew the old one away.
 */
function renderOverlay(payload) {
  const parent = document.body || document.documentElement;
  if (!parent) return;

  let host = document.getElementById(payload.hostId);
  if (!payload.visible) {
    if (host) host.remove();
    return;
  }

  if (!host) {
    host = document.createElement("div");
    host.id = payload.hostId;
    host.setAttribute("aria-hidden", "true");
    // Inline, so page rules cannot win against it, and `pointer-events: none`
    // last so `all: initial` cannot reset it back to auto. Every child inherits
    // that, which is what keeps elementFromPoint blind to the overlay.
    host.style.cssText =
      "all:initial;position:fixed;left:0;top:0;width:0;height:0;" +
      "z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML =
      "<style>" +
      "#pointer{position:absolute;left:0;top:0;" +
      "transition:transform 200ms cubic-bezier(.22,.61,.36,1);will-change:transform}" +
      "#arrow{position:absolute;left:-1px;top:-1px;display:block;" +
      "filter:drop-shadow(0 2px 5px rgba(0,0,0,.35))}" +
      "#pulse{position:absolute;left:-19px;top:-19px;width:38px;height:38px;" +
      "border-radius:50%;border:2px solid " +
      payload.accent +
      ";opacity:0}" +
      "#pulse.on{animation:ego-pulse 500ms ease-out}" +
      "@keyframes ego-pulse{from{transform:scale(.2);opacity:.9}" +
      "to{transform:scale(1);opacity:0}}" +
      "#badge{position:absolute;left:20px;top:22px;display:flex;align-items:center;" +
      "gap:7px;max-width:300px;padding:5px 11px 5px 9px;border-radius:999px;" +
      "background:rgba(24,24,27,.94);color:#fff;box-sizing:border-box;" +
      "font:500 12px/1.35 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;" +
      "box-shadow:0 8px 22px rgba(0,0,0,.3);transition:transform 200ms ease}" +
      "#text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#dot{flex:none;width:7px;height:7px;border-radius:50%;background:" +
      payload.accent +
      ";animation:ego-breathe 1.7s ease-in-out infinite}" +
      "@keyframes ego-breathe{0%,100%{opacity:1}50%{opacity:.35}}" +
      "</style>" +
      '<div id="pointer">' +
      '<div id="pulse"></div>' +
      '<svg id="arrow" width="20" height="26" viewBox="-1.4 -1.4 17 24">' +
      '<path d="M0 0 L0 18.6 L4.6 14.3 L7.7 21.1 L11.1 19.5 L8 12.9 L13.9 12.5 Z" ' +
      'fill="' +
      payload.accent +
      '" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
      '<div id="badge"><span id="dot"></span><span id="text"></span></div>' +
      "</div>";
    host.__egoShadow = shadow;
    parent.appendChild(host);
  }

  const shadow = host.__egoShadow;
  if (!shadow) return;

  const pointer = shadow.getElementById("pointer");
  pointer.style.transform =
    "translate3d(" + payload.x + "px," + payload.y + "px,0)";

  const badge = shadow.getElementById("badge");
  shadow.getElementById("text").textContent = payload.label
    ? payload.name + " · " + payload.label
    : payload.name;

  // Flip the badge back over the cursor near the viewport edges, so the label
  // is never the thing that gets clipped off screen.
  const flipX = payload.x + 340 > window.innerWidth;
  const flipY = payload.y + 70 > window.innerHeight;
  badge.style.transform =
    (flipX ? "translateX(calc(-100% - 40px))" : "") +
    (flipY ? " translateY(-60px)" : "");

  if (payload.pulse) {
    const pulse = shadow.getElementById("pulse");
    pulse.classList.remove("on");
    void pulse.offsetWidth; // restart the animation rather than ignore a re-click
    pulse.classList.add("on");
  }

  // Left for anything reading the page from outside — the Spaces overview uses
  // it to tell a space being worked in from one sitting idle.
  host.__egoState = {
    x: payload.x,
    y: payload.y,
    label: payload.label,
    name: payload.name,
    at: Date.now(),
  };
}
