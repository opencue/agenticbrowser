/**
 * CDP transport, shared between the harness and this shim.
 *
 * The harness talks to the native layer through exactly three members
 * (see package/ego-browser/src/browser-runtime.ts):
 *
 *   ego.sendCDPMessage(jsonString)   — a serialized { id, method, params, sessionId? }
 *   ego.onCDPMessage(jsonString)     — a raw protocol message, parsed by handleMessage
 *   ego.onSendCDPMessageError(msg, code)
 *
 * Chrome's browser-level WebSocket speaks that exact wire format when sessions
 * are attached with `flatten: true` (which ensureSession() does), so harness
 * traffic is a straight passthrough.
 *
 * The shim also needs its own calls (Target.getTargets for listTabs, the
 * snapshot's DOM walk, ...). Both parties share one socket, so request ids are
 * partitioned: the harness counts up from 1, the shim from INTERNAL_ID_BASE.
 * Responses to shim ids are consumed here and never reach the harness, which
 * would otherwise see ids it has no pending entry for.
 */

const OPEN_TIMEOUT_MS = 10000;
const CALL_TIMEOUT_MS = 30000;
const INTERNAL_ID_BASE = 1_000_000;
const DESKTOP_VIEWPORT_MIN_WIDTH = 1000;

/**
 * A fixed desktop viewport inside a visible Chrome window creates a smaller
 * renderer surface with grey bands around it. Once Chrome has put a target in
 * that state, clearing the override is not reliable on Linux; prevent the
 * headed desktop override from reaching the target in the first place.
 * Mobile emulation and deterministic headless dimensions remain untouched.
 */
export function normalizeHeadedDesktopViewport(payload, enabled) {
  if (!enabled || !payload.includes("Emulation.setDeviceMetricsOverride")) {
    return payload;
  }
  try {
    const message = JSON.parse(payload);
    const width = Number(message.params?.width);
    const height = Number(message.params?.height);
    if (
      message.method !== "Emulation.setDeviceMetricsOverride" ||
      message.params?.mobile === true ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < DESKTOP_VIEWPORT_MIN_WIDTH ||
      height <= 0
    ) {
      return payload;
    }
    return JSON.stringify({
      ...message,
      method: "Emulation.clearDeviceMetricsOverride",
      params: {},
    });
  } catch {
    return payload;
  }
}

// Fast observation calls should fail fast instead of inheriting the transport's
// 30 second escape hatch. Callers can still override these per operation.
const METHOD_TIMEOUT_MS = new Map([
  ["Target.getTargets", 3000],
  ["Target.getBrowserContexts", 3000],
  ["Browser.getWindowForTarget", 3000],
  ["Browser.getWindowBounds", 3000],
  ["Browser.getVersion", 3000],
  ["Page.captureScreenshot", 2000],
  ["DOMStorage.getDOMStorageItems", 3000],
  ["Storage.getCookies", 5000],
]);

// A timed-out command can still arrive in Chrome after the caller gives up.
// Retry only reads whose late completion cannot duplicate a user-visible act.
const READ_ONLY_RETRY_METHODS = new Set([
  "Target.getTargets",
  "Target.getBrowserContexts",
  "Browser.getWindowForTarget",
  "Browser.getWindowBounds",
  "Browser.getVersion",
  "Page.captureScreenshot",
  "DOMStorage.getDOMStorageItems",
  "Storage.getCookies",
]);

// The harness needs an attached session to capture passive pixels while a human
// owns the page. Everything else crosses the ownership boundary: Target.* can
// open, close, or focus tabs and Browser.* can resize or close the whole browser.
const USER_CONTROL_ALLOWED_METHODS = new Set([
  "Page.captureScreenshot",
  "Browser.getVersion",
  "Browser.getWindowForTarget",
  "Browser.getWindowBounds",
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.getBrowserContexts",
  "Target.attachToTarget",
  "Target.detachFromTarget",
]);

class CdpCallTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`CDP request timed out after ${timeoutMs}ms: ${method}`);
    this.name = "CdpCallTimeoutError";
    this.code = "EGO_CDP_TIMEOUT";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

function callPolicy(method, options = {}) {
  const configuredTimeout = Number(options.timeoutMs);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.round(configuredTimeout)
      : (METHOD_TIMEOUT_MS.get(method) ?? CALL_TIMEOUT_MS);
  const configuredRetries = Number(options.retries);
  const retries =
    Number.isInteger(configuredRetries) && configuredRetries >= 0
      ? configuredRetries
      : READ_ONLY_RETRY_METHODS.has(method)
        ? 1
        : 0;
  return {
    timeoutMs,
    retries,
    retryDelayMs: Number.isFinite(Number(options.retryDelayMs))
      ? Math.max(0, Number(options.retryDelayMs))
      : 25,
    signal: options.signal,
  };
}

function abortError() {
  return Object.assign(new Error("CDP request aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

export async function connectCdp(
  wsUrl,
  { nativeDesktopViewport = false } = {},
) {
  const socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";

  const internalPending = new Map();
  let nextInternalId = INTERNAL_ID_BASE;
  let runtime = null;
  let closed = false;
  let activeTargetId = null;
  let attachedTargetId = null;
  let mouseWatcher = null;
  // Sessions the shim opened for its own reads. Their events belong to the
  // shim, not to the harness.
  const shimSessions = new Set();
  const shimEvents = new Map();
  let keyWatcher = null;
  let navWatcher = null;
  let viewportWatcher = null;
  let activeTargetWatcher = null;
  let downloadContextResolver = null;
  let pageControlGuard = null;
  let backgroundAgentTabs = false;

  /** Track which tab the harness last brought to the front, and which it drives. */
  function noteActivation(payload) {
    try {
      const message = JSON.parse(payload);
      if (message.method === "Input.dispatchMouseEvent") {
        // Where the agent's pointer actually is. The harness announces intent
        // through ego.animationHighlightMouseToPosition, but only these carry
        // the drag path and the press itself, which is what the cursor overlay
        // needs to look like a hand on the mouse rather than a teleport.
        mouseWatcher?.(message.params || {});
      } else if (
        message.method === "Input.dispatchKeyEvent" ||
        message.method === "Input.insertText"
      ) {
        // Typing is the one thing an agent does that leaves no trace until the
        // text appears. Both paths matter: keystrokes and fill()'s bulk insert.
        keyWatcher?.(message.params || {});
      } else if (message.method === "Page.navigate" && message.params?.url) {
        // Whether a space ever held a real page can only be seen as it happens:
        // a tab is about:blank again the moment it navigates away, so polling
        // its url later cannot tell "never used" from "between pages".
        if (message.params.url !== "about:blank")
          navWatcher?.(message.params.url, attachedTargetId);
      } else if (message.method === "Emulation.setDeviceMetricsOverride") {
        // Emulation resizes the page's viewport, never the OS window — so a
        // mobile layout renders as a narrow strip inside a desktop-sized window.
        viewportWatcher?.(message.params || {});
      } else if (message.method === "Emulation.clearDeviceMetricsOverride") {
        // Explicitly the other half: leaving emulation has to put the window
        // back, or it stays phone-shaped for the rest of the session.
        viewportWatcher?.({ width: 0, height: 0 });
      } else if (
        message.method === "Target.activateTarget" &&
        message.params?.targetId
      ) {
        activeTargetId = message.params.targetId;
        try {
          activeTargetWatcher?.(activeTargetId);
        } catch {
          // Selection tracking must never block the CDP request itself.
        }
      } else if (
        message.method === "Target.attachToTarget" &&
        message.params?.targetId
      ) {
        // ensureSession() attaches to whatever the harness considers current —
        // its preferredTargetId, which the shim cannot see any other way. The
        // shim's own page reads (snapshot) must target the same tab, or the
        // agent observes one page while acting on another.
        attachedTargetId = message.params.targetId;
      } else if (
        message.method === "Target.closeTarget" &&
        message.params?.targetId === activeTargetId
      ) {
        activeTargetId = null;
      }
    } catch {
      // Not our concern: the send itself is what matters.
    }
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`CDP WebSocket did not open within ${OPEN_TIMEOUT_MS}ms`),
        ),
      OPEN_TIMEOUT_MS,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`failed to connect to CDP endpoint: ${wsUrl}`));
      },
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    const text =
      typeof event.data === "string"
        ? event.data
        : new TextDecoder().decode(event.data);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof data.id === "number" && data.id >= INTERNAL_ID_BASE) {
      const entry = internalPending.get(data.id);
      if (!entry) return;
      internalPending.delete(data.id);
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener("abort", entry.abortHandler);
      if (data.error) {
        entry.reject(
          new Error(data.error.message || JSON.stringify(data.error)),
        );
      } else {
        entry.resolve(data.result ?? {});
      }
      return;
    }

    // Events from a session the shim opened are the shim's business. Forwarding
    // them would push them into the harness's event buffer, where drainEvents()
    // hands them to the agent — a screencast alone would bury a task's real
    // events under dozens of frames a second.
    if (data.sessionId && shimSessions.has(data.sessionId)) {
      shimEvents.get(data.method)?.(data.params || {}, data.sessionId);
      return;
    }

    runtime?.onCDPMessage?.(text);
  });

  socket.addEventListener("close", () => {
    closed = true;
    for (const entry of internalPending.values()) {
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener("abort", entry.abortHandler);
      entry.reject(new Error("browser connection closed"));
    }
    internalPending.clear();
    // Mirrors the native bridge's task-level failure: every in-flight harness
    // request fails the same way, so they are all rejected at once.
    runtime?.onSendCDPMessageError?.(
      "browser connection closed",
      "EGO_CDP_CHANNEL_UNAVAILABLE",
    );
  });

  /**
   * Point the harness's download setup at the space the agent is working in.
   *
   * Browser.setDownloadBehavior with no browserContextId configures the DEFAULT
   * context. That was right when a task space was a plain window, but a space
   * now owns its own context — so the harness's call, which cannot know that,
   * would arm downloads on a context nothing is downloading in. No
   * Page.downloadWillBegin ever fires and page.waitForEvent("download") hangs
   * until it times out.
   *
   * Rewriting on the way out keeps the harness unmodified and keeps the
   * download path the harness chose, which download.path() then reads from.
   */
  function aimDownloadsAtCurrentSpace(payload) {
    if (!downloadContextResolver) return payload;
    if (!payload.includes("Browser.setDownloadBehavior")) return payload;
    try {
      const message = JSON.parse(payload);
      if (message.method !== "Browser.setDownloadBehavior") return payload;
      if (message.params?.browserContextId) return payload;
      const browserContextId = downloadContextResolver();
      if (!browserContextId) return payload;
      return JSON.stringify({
        ...message,
        params: { ...message.params, browserContextId },
      });
    } catch {
      // A payload we cannot parse is one we have no business rewriting.
      return payload;
    }
  }

  function assertOpen() {
    if (closed || socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP channel is not open");
    }
  }

  // Keep this allowlist exact. Every CDP domain contains commands that can alter
  // the page, tab, window, browser process, or ownership-visible presentation.
  function isUserControlObservationPayload(payload) {
    try {
      return USER_CONTROL_ALLOWED_METHODS.has(JSON.parse(payload)?.method);
    } catch {
      return false;
    }
  }

  function pageControlError(payload) {
    if (!pageControlGuard || isUserControlObservationPayload(payload)) {
      return null;
    }
    return pageControlGuard();
  }

  /**
   * Treat a harness tab switch as a logical selection without changing the tab
   * a person is looking at.
   *
   * The harness follows Target.activateTarget with a fresh attachment to the
   * selected target. It does not need Chrome to paint that target in front; it
   * only needs the request to succeed and activeHint() to remember the target.
   * Explicit user presentation uses the shim's internal cdp.call path instead,
   * so Open / handoff still performs a real foreground activation.
   */
  function acknowledgeBackgroundActivation(payload) {
    if (!backgroundAgentTabs || !payload.includes("Target.activateTarget")) {
      return false;
    }
    try {
      const message = JSON.parse(payload);
      if (message.method !== "Target.activateTarget") return false;
      const response = JSON.stringify({
        id: message.id,
        result: {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      });
      queueMicrotask(() => runtime?.onCDPMessage?.(response));
      return true;
    } catch {
      return false;
    }
  }

  return {
    /** Raw passthrough for harness-authored payloads (ids below the shim's base). */
    sendRaw(payload) {
      assertOpen();
      const blocked = pageControlError(payload);
      if (blocked) {
        runtime?.onSendCDPMessageError?.(blocked.error, blocked.error_code);
        return;
      }
      const normalized = normalizeHeadedDesktopViewport(
        payload,
        nativeDesktopViewport,
      );
      noteActivation(normalized);
      if (acknowledgeBackgroundActivation(normalized)) return;
      socket.send(aimDownloadsAtCurrentSpace(normalized));
    },

    /** Keep harness-authored tab switches logical until the user asks to see one. */
    setBackgroundAgentTabs(enabled) {
      backgroundAgentTabs = enabled === true;
    },

    /** Select the target for this agent connection without foregrounding it. */
    selectTarget(targetId) {
      activeTargetId = targetId || null;
      try {
        activeTargetWatcher?.(activeTargetId);
      } catch {
        // Selection tracking is best-effort at this transport boundary.
      }
    },

    /** Persist logical tab selection outside this short-lived connection. */
    watchActiveTarget(watcher) {
      activeTargetWatcher = typeof watcher === "function" ? watcher : null;
    },

    /**
     * Tell the transport which browser context downloads should be armed for.
     * Set by the shim to the selected task space; see the rewrite below.
     */
    setDownloadContext(resolver) {
      downloadContextResolver = resolver;
    },

    /**
     * Synchronous native-boundary ownership check for harness-authored page CDP.
     *
     * sendRaw cannot await: browser-runtime expects native send failures through
     * onSendCDPMessageError, not a later Promise. The task-space layer therefore
     * exposes a sync state-file read. Only exact passive observation and session
     * attach/detach methods bypass it; takeover itself uses the shim's internal
     * CDP path rather than this harness-authored passthrough.
     */
    setPageControlGuard(guard) {
      pageControlGuard = guard;
    },

    /**
     * The last target the harness explicitly activated, or null.
     * CDP cannot be asked which tab is focused, so the authoritative signal is
     * the harness's own Target.activateTarget call (what browser.switchTab and
     * openOrReuseTab issue). Without this, currentTab() does not follow
     * switchTab() and every helper that reads "the active tab" drifts.
     */
    activeHint: () => activeTargetId,

    /** The target the harness's own CDP session is attached to, or null. */
    attachedHint: () => attachedTargetId,

    /**
     * Observe the harness's mouse input as it goes out. Read-only: the callback
     * runs before the send and its errors are swallowed by noteActivation's
     * catch, so a watcher can never hold up or fail an action.
     */
    watchMouse(handler) {
      mouseWatcher = handler;
    },

    /** Observe the harness's keyboard input, on the same read-only terms. */
    watchKeys(handler) {
      keyWatcher = handler;
    },

    /**
     * Claim a session the shim opened, so its events stop at the shim.
     * Sessions the harness opens are untouched and keep flowing to it.
     */
    claimSession(sessionId) {
      if (sessionId) shimSessions.add(sessionId);
    },

    releaseSession(sessionId) {
      shimSessions.delete(sessionId);
    },

    /** Handle one CDP event method arriving on a claimed session. */
    onShimEvent(method, handler) {
      shimEvents.set(method, handler);
    },

    /** Observe viewport emulation, on the same read-only terms. */
    watchViewport(handler) {
      viewportWatcher = handler;
    },

    /** Observe navigations to real pages, on the same read-only terms. */
    watchNavigation(handler) {
      navWatcher = handler;
    },

    /**
     * The shim's own request/response calls.
     *
     * The fourth argument is deliberately separate from sessionId so every
     * existing three-argument call stays source-compatible.
     */
    async call(method, params = {}, sessionId = undefined, options = {}) {
      assertOpen();
      if (method === "Target.activateTarget" && params.targetId) {
        activeTargetId = params.targetId;
      }
      const policy = callPolicy(method, options);

      const sendOnce = () =>
        new Promise((resolve, reject) => {
          if (policy.signal?.aborted) {
            reject(abortError());
            return;
          }
          const id = ++nextInternalId;
          const payload = JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          });
          const abortHandler = () => {
            const entry = internalPending.get(id);
            if (!entry) return;
            clearTimeout(entry.timer);
            internalPending.delete(id);
            reject(abortError());
          };
          const timer = setTimeout(() => {
            internalPending.delete(id);
            policy.signal?.removeEventListener("abort", abortHandler);
            reject(new CdpCallTimeoutError(method, policy.timeoutMs));
          }, policy.timeoutMs);
          internalPending.set(id, {
            resolve,
            reject,
            timer,
            signal: policy.signal,
            abortHandler,
          });
          policy.signal?.addEventListener("abort", abortHandler, {
            once: true,
          });
          try {
            socket.send(payload);
          } catch (error) {
            clearTimeout(timer);
            internalPending.delete(id);
            policy.signal?.removeEventListener("abort", abortHandler);
            reject(error);
          }
        });

      for (let attempt = 0; ; attempt += 1) {
        try {
          return await sendOnce();
        } catch (error) {
          if (error?.code !== "EGO_CDP_TIMEOUT" || attempt >= policy.retries) {
            throw error;
          }
          if (policy.retryDelayMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, policy.retryDelayMs),
            );
          }
        }
      }
    },

    /** Route protocol traffic into the harness once its callbacks are installed. */
    bind(egoRuntime) {
      runtime = egoRuntime;
    },

    close() {
      runtime = null;
      try {
        socket.close();
      } catch {
        // already gone
      }
    },
  };
}
