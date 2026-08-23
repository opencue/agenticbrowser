import { state } from "./state.js";
import { assertNoEgoError, buildEgoError } from "./ego-errors.js";

const RESPONSE_TIMEOUT_MS = 15000;
const SESSION_TTL_MS = 2000;
// Upper bound for buffered CDP events. The runtime can be long-lived (installEgoSdk
// inside the browser); without a cap, undrained events grow without bound.
const MAX_BUFFERED_EVENTS = 10000;
const MAX_TRACE_ENTRIES = 2000;
const SESSION_LOST =
  /Session (?:with given id )?not found|Target closed|No session/i;
const BROWSER_LEVEL = (method, params: any = {}) =>
  method.startsWith("Target.") ||
  (method.startsWith("Browser.") &&
    !(method === "Browser.getWindowForTarget" && !params?.targetId));
type BrowserEventSubscriber = {
  method: string;
  sessionId?: string;
  listener: (event: any) => void;
};
let nextMessageId = 1;
let nextTraceSeq = 1;
const pending = new Map();
const events = [];
const traceEntries = [];
const eventWaiters = [];
const eventSubscribers = new Set<BrowserEventSubscriber>();
const pageEnabledSessions = new Set();
const pendingDialogs = new Map();
export function isBrowserRuntime() {
  return Boolean(
    globalThis.ego && typeof globalThis.ego.sendCDPMessage === "function",
  );
}

export function browserEgo() {
  if (!globalThis.ego) {
    throw new Error("browser runtime is not available");
  }
  return globalThis.ego;
}

function rawCdp(
  method,
  params: any = {},
  sessionId = undefined,
  timeoutMs = RESPONSE_TIMEOUT_MS,
) {
  const runtime = browserEgo();
  runtime.onCDPMessage = handleMessage;
  runtime.onSendCDPMessageError = handleSendError;
  const id = nextMessageId++;
  const payload = JSON.stringify({
    id,
    method,
    params,
    ...(sessionId ? { sessionId } : {}),
  });
  return new Promise<any>((resolve, reject) => {
    const startedAt = state.now();
    let timer: ReturnType<typeof setTimeout>;
    recordTraceEntry({
      kind: "cdp.request",
      method,
      sessionId,
      params: summarizeRequestParams(method, params),
    });
    const entry = {
      method,
      startedAt,
      resolve: (response) => {
        clearTimeout(timer);
        recordTraceEntry({
          kind: "cdp.response",
          method,
          sessionId,
          durationMs: state.now() - startedAt,
          result: summarizeResponseResult(method, response),
        });
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        recordTraceEntry({
          kind: "cdp.error",
          method,
          sessionId,
          durationMs: state.now() - startedAt,
          error: summarizeTraceError(error),
        });
        reject(error);
      },
    };
    timer = setTimeout(() => {
      pending.delete(id);
      entry.reject(new Error(`CDP request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, entry);
    try {
      runtime.sendCDPMessage(payload);
    } catch (error) {
      pending.delete(id);
      entry.reject(error);
    }
  });
}

export async function browserCdp(
  method,
  params: any = {},
  sessionId = undefined,
  timeoutMs = RESPONSE_TIMEOUT_MS,
) {
  // Test mock: cdpOverride bypasses everything including session injection.
  if (state.cdpOverride) {
    return state.cdpOverride(method, params, sessionId, timeoutMs);
  }
  const explicit = sessionId !== undefined;
  const browserLevel = BROWSER_LEVEL(method, params);
  let effective = sessionId;
  if (!explicit && !browserLevel) {
    effective = await ensureSession();
  }
  try {
    return await rawCdp(method, params, effective, timeoutMs);
  } catch (error) {
    const lost = SESSION_LOST.test(error?.message || "");
    if (lost && !explicit && !browserLevel) {
      invalidateSession();
      const fresh = await ensureSession();
      return rawCdp(method, params, fresh, timeoutMs);
    }
    throw error;
  }
}

export async function ensureSession() {
  if (state.sessionId && Date.now() - state.sessionAt < SESSION_TTL_MS) {
    return state.sessionId;
  }
  if (state.sessionInflight) {
    return state.sessionInflight;
  }
  state.sessionInflight = (async () => {
    try {
      const ego = browserEgo();
      const result = assertNoEgoError(await ego.listTabs());
      const tabs = result?.tabs || result?.targetInfos || [];
      const preferred = state.preferredTargetId
        ? tabs.find((t) => t.targetId === state.preferredTargetId)
        : null;
      let active =
        preferred || tabs.find((t) => t.active) || tabs[tabs.length - 1];
      if (!active && typeof ego.createTab === "function") {
        const created = assertNoEgoError(
          await ego.createTab("about:blank"),
          "createTab",
        );
        if (created?.targetId) {
          active = {
            targetId: created.targetId,
            url: "about:blank",
            active: true,
          };
        }
      }
      if (!active) {
        throw new Error("no active tab to attach session");
      }
      const targetId = active.targetId;
      if (targetId !== state.sessionTargetId || !state.sessionId) {
        const attached = await rawCdp(
          "Target.attachToTarget",
          { targetId, flatten: true },
          undefined,
        );
        state.sessionId = attached.result?.sessionId || attached.sessionId;
        state.sessionTargetId = targetId;
      }
      await enablePageEvents(state.sessionId);
      state.sessionAt = Date.now();
      return state.sessionId;
    } finally {
      state.sessionInflight = null;
    }
  })();
  return state.sessionInflight;
}

export function invalidateSession() {
  if (state.sessionId) {
    pageEnabledSessions.delete(state.sessionId);
    pendingDialogs.delete(state.sessionId);
  }
  state.sessionId = null;
  state.sessionTargetId = null;
  state.sessionAt = 0;
}

export function setPreferredTarget(targetId) {
  state.preferredTargetId = targetId || null;
}

export function clearPreferredTarget() {
  state.preferredTargetId = null;
}

export function drainBrowserEvents() {
  const out = events.splice(0, events.length);
  return out;
}

export function drainBrowserTrace() {
  const out = traceEntries.splice(0, traceEntries.length);
  return out;
}

export function waitForBrowserEvent(
  predicate,
  timeoutMs = state.defaultTimeout,
) {
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = eventWaiters.indexOf(waiter);
        if (index >= 0) eventWaiters.splice(index, 1);
        reject(new Error("page.waitForEvent timed out"));
      }, timeoutMs),
    };
    eventWaiters.push(waiter);
  });
}

export function subscribeBrowserEvent(
  method: string,
  sessionId: string | undefined,
  listener: (event: any) => void,
) {
  const subscriber = { method, sessionId, listener };
  eventSubscribers.add(subscriber);
  return () => eventSubscribers.delete(subscriber);
}

export function pendingDialog(sessionId = state.sessionId) {
  if (sessionId && pendingDialogs.has(sessionId)) {
    return { ...pendingDialogs.get(sessionId) };
  }
  return null;
}

async function enablePageEvents(sessionId) {
  if (!sessionId || pageEnabledSessions.has(sessionId)) {
    return;
  }
  try {
    await rawCdp("Page.enable", {}, sessionId);
    pageEnabledSessions.add(sessionId);
  } catch {
    // Dialog tracking is best-effort. Do not make all helpers fail on targets
    // that reject Page.enable, such as unusual internal pages.
  }
}

// Local send failures for ego.sendCDPMessage() arrive here (task inactive,
// user-controlled, not selected/claimed, host gone) instead of as a CDP
// response, so the matching request would otherwise sit until the 15s timeout.
// The callback carries no request id; these failures are task-level (every
// in-flight send fails the same way), so reject all pending requests, routing
// the stable code through buildEgoError to use the ego-browser-owned wording.
function handleSendError(message, error_code) {
  if (pending.size === 0) return;
  const error = buildEgoError({ error: message, error_code });
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.reject(error);
}

function handleMessage(message) {
  let data;
  try {
    data = JSON.parse(message);
  } catch {
    return;
  }
  if (Object.hasOwn(data, "id")) {
    const entry = pending.get(data.id);
    if (!entry) {
      return;
    }
    pending.delete(data.id);
    if (data.error) {
      entry.reject(new Error(data.error.message || data.error));
      return;
    }
    entry.resolve(data);
    return;
  }
  if (
    data.method === "Target.detachedFromTarget" ||
    data.method === "Target.targetDestroyed"
  ) {
    const sessionId = data.params?.sessionId || data.sessionId;
    if (sessionId) {
      pageEnabledSessions.delete(sessionId);
      pendingDialogs.delete(sessionId);
    }
    const targetId = data.params?.targetId || data.params?.targetInfo?.targetId;
    if (targetId && targetId === state.sessionTargetId) {
      invalidateSession();
    }
  }
  if (data.method === "Page.javascriptDialogOpening") {
    const sessionId = data.sessionId || state.sessionId;
    if (sessionId) {
      pendingDialogs.set(sessionId, data.params || {});
    }
  } else if (data.method === "Page.javascriptDialogClosed") {
    const sessionId = data.sessionId || state.sessionId;
    if (sessionId) {
      pendingDialogs.delete(sessionId);
    }
  }
  let deliveredToSubscriber = false;
  for (const subscriber of eventSubscribers) {
    if (subscriber.method !== data.method) continue;
    if (subscriber.sessionId && subscriber.sessionId !== data.sessionId) {
      continue;
    }
    deliveredToSubscriber = true;
    subscriber.listener(data);
  }
  if (!(deliveredToSubscriber && data.method === "Page.screencastFrame")) {
    events.push(data);
    if (events.length > MAX_BUFFERED_EVENTS) {
      events.splice(0, events.length - MAX_BUFFERED_EVENTS);
    }
  }
  recordTraceEntry({
    kind: "cdp.event",
    method: data.method,
    sessionId: data.sessionId,
    params: summarizeEventParams(data.method, data.params || {}),
  });
  for (const waiter of [...eventWaiters]) {
    let matched = false;
    try {
      matched = waiter.predicate(data);
    } catch (error) {
      clearTimeout(waiter.timer);
      eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
      waiter.reject(error);
      continue;
    }
    if (!matched) continue;
    clearTimeout(waiter.timer);
    eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
    waiter.resolve(data);
  }
}

function recordTraceEntry(entry) {
  traceEntries.push({
    seq: nextTraceSeq++,
    at: state.now(),
    ...entry,
  });
  if (traceEntries.length > MAX_TRACE_ENTRIES) {
    traceEntries.splice(0, traceEntries.length - MAX_TRACE_ENTRIES);
  }
}

function summarizeRequestParams(method, params: any = {}) {
  const out: Record<string, unknown> = {};
  if (method === "Page.navigate") {
    copyTraceScalar(out, params, "url");
  } else if (method === "Runtime.evaluate") {
    if (typeof params.expression === "string") {
      out.expressionChars = params.expression.length;
    }
    copyTraceScalar(out, params, "awaitPromise");
    copyTraceScalar(out, params, "returnByValue");
  } else if (method === "Input.dispatchMouseEvent") {
    copyTraceScalar(out, params, "type");
    copyTraceScalar(out, params, "x");
    copyTraceScalar(out, params, "y");
    copyTraceScalar(out, params, "button");
    copyTraceScalar(out, params, "clickCount");
  } else if (method === "Input.dispatchKeyEvent") {
    copyTraceScalar(out, params, "type");
    copyTraceScalar(out, params, "key");
    copyTraceScalar(out, params, "code");
    copyTraceScalar(out, params, "modifiers");
  } else if (method === "Page.captureScreenshot") {
    copyTraceScalar(out, params, "format");
    out.hasClip = Boolean(params.clip);
    out.captureBeyondViewport = Boolean(params.captureBeyondViewport);
  } else {
    copyTraceScalar(out, params, "targetId");
    copyTraceScalar(out, params, "requestId");
    copyTraceScalar(out, params, "frameId");
    copyTraceScalar(out, params, "backendNodeId");
    copyTraceScalar(out, params, "objectId");
  }
  return out;
}

function summarizeResponseResult(method, response: any = {}) {
  const result = response?.result || {};
  const out: Record<string, unknown> = {};
  if (method === "Page.navigate") {
    copyTraceScalar(out, result, "frameId");
    copyTraceScalar(out, result, "loaderId");
    copyTraceScalar(out, result, "errorText");
  } else if (method === "Target.attachToTarget") {
    copyTraceScalar(out, result, "sessionId");
  } else if (method === "Runtime.evaluate") {
    if (result.result) {
      copyTraceScalar(out, result.result, "type");
      copyTraceScalar(out, result.result, "subtype");
      out.hasObjectId = Boolean(result.result.objectId);
      out.hasValue = Object.hasOwn(result.result, "value");
    }
    if (result.exceptionDetails) {
      out.exceptionText = String(result.exceptionDetails.text || "");
    }
  } else if (method === "Page.captureScreenshot") {
    if (typeof result.data === "string") {
      out.dataChars = result.data.length;
    }
  } else if (Object.keys(result).length) {
    out.ok = true;
  }
  return out;
}

function summarizeEventParams(method, params: any = {}) {
  const out: Record<string, unknown> = {};
  copyTraceScalar(out, params, "requestId");
  copyTraceScalar(out, params, "loaderId");
  copyTraceScalar(out, params, "frameId");
  copyTraceScalar(out, params, "type");
  copyTraceScalar(out, params, "timestamp");
  copyTraceScalar(out, params, "wallTime");
  copyTraceScalar(out, params, "errorText");
  copyTraceScalar(out, params, "reason");
  copyTraceScalar(out, params, "name");
  copyTraceScalar(out, params, "message");
  copyTraceScalar(out, params, "suggestedFilename");
  copyTraceScalar(out, params, "guid");

  const url =
    params.url ||
    params.request?.url ||
    params.response?.url ||
    params.frame?.url ||
    params.targetInfo?.url;
  if (url) out.url = url;

  if (params.request) {
    copyTraceScalar(out, params.request, "method");
  }
  if (params.response) {
    copyTraceScalar(out, params.response, "status");
  }
  if (Array.isArray(params.args)) {
    out.args = params.args
      .slice(0, 5)
      .map((arg) =>
        String(
          arg?.value ??
            arg?.unserializableValue ??
            arg?.description ??
            arg?.type ??
            "",
        ),
      );
  }
  if (params.exceptionDetails) {
    out.exceptionText = String(params.exceptionDetails.text || "");
    out.exceptionDescription = String(
      params.exceptionDetails.exception?.description || "",
    );
  }
  return out;
}

function summarizeTraceError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.error_code,
  };
}

function copyTraceScalar(
  out: Record<string, unknown>,
  params: any,
  key: string,
) {
  const value = params?.[key];
  if (
    value === undefined ||
    value === null ||
    (typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean")
  ) {
    return;
  }
  out[key] = value;
}

export function browserSnapshotRefsToRefMap(refMap, refs = []) {
  refMap.clear();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") {
      continue;
    }
    if (ref.backendNodeId === undefined || ref.backendNodeId === null) {
      continue;
    }
    refMap.add(
      String(ref.backendNodeId),
      ref.backendNodeId,
      ref.role,
      ref.name,
      undefined,
    );
  }
}
