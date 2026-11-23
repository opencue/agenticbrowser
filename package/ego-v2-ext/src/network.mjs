/**
 * page.waitForRequest(urlOrPredicate, options?) and
 * page.waitForResponse(urlOrPredicate, options?) on v2 Pages, ported from the
 * v1 runtime.
 *
 * Event-access strategy
 * ---------------------
 * v2's internal subscribePageEvents() is not part of the public Page API.
 * page.events() is the only way to read CDP events, and it *drains* the
 * buffer (all events are consumed on each call). We therefore use a polling
 * loop over page.events() with a 50 ms interval.
 *
 * The same drain-on-read pattern is used by page.debug(), so concurrently
 * calling page.debug() and page.waitForRequest() will split the event stream.
 * That is a known limitation of the public API surface and matches the
 * existing page.debug() precedent.
 *
 * Network domain management
 * -------------------------
 * The Network domain is enabled for the duration of each wait and is
 * ref-counted per Page (WeakMap) so concurrent waits on the same page share
 * one enable/disable pair and do not fight over the domain.
 */

/** Default timeout: 10 000 ms, matching v1's state.defaultTimeout. */
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

// Per-page Network domain ref-count.
// { count: number, enablePromise: Promise | null, owned: boolean }
const networkState = new WeakMap();

function getNetState(page) {
  if (!networkState.has(page)) {
    networkState.set(page, { count: 0, enablePromise: null, owned: false });
  }
  return networkState.get(page);
}

async function acquireNetwork(page) {
  const s = getNetState(page);
  if (s.count === 0) {
    s.owned = true;
    // Ignore failures — some targets do not expose the Network domain; the
    // waiter will time out with the standard error message.
    s.enablePromise = page.cdp("Network.enable", {}).catch(() => {});
  }
  s.count += 1;
  await s.enablePromise;
}

async function releaseNetwork(page) {
  const s = getNetState(page);
  s.count = Math.max(0, s.count - 1);
  // Never send Network.disable: v2 keeps the domain enabled for its own
  // network-idle tracking, and disabling it clears v2's in-flight requests, so
  // a later waitForLoadState("networkidle") would return too early.
  if (s.count === 0) s.owned = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

function createRequestInfo(params) {
  const req = params.request ?? {};
  return {
    requestId: params.requestId,
    url: req.url ?? "",
    method: req.method ?? "",
    headers: normalizeHeaders(req.headers),
    postData: req.postData ?? null,
    resourceType: String(params.type ?? "").toLowerCase(),
  };
}

function createRequestFacade(info) {
  return {
    url: () => info.url,
    method: () => info.method,
    headers: () => ({ ...info.headers }),
    postData: () => info.postData,
    resourceType: () => info.resourceType,
  };
}

function createResponseFacade(page, info, timeout) {
  const response = info.response ?? {};
  const request =
    info.request ??
    createRequestInfo({
      requestId: info.requestId,
      request: {
        url: response.url ?? "",
        method: "",
        headers: response.requestHeaders ?? {},
      },
      type: response.type,
    });
  const status = Number(response.status ?? 0);
  const headers = normalizeHeaders(response.headers);

  const readBody = async () => {
    if (!page) throw new Error("response body unavailable for redirect");
    return readResponseBody(page, info.requestId, timeout);
  };

  const facade = {
    url: () => response.url ?? request.url ?? "",
    status: () => status,
    statusText: () => response.statusText ?? "",
    ok: () => status >= 200 && status <= 299,
    headers: () => ({ ...headers }),
    request: () => createRequestFacade(request),
    body: async () => {
      const r = await readBody();
      return r.base64Encoded
        ? Buffer.from(r.body ?? "", "base64")
        : Buffer.from(r.body ?? "", "utf8");
    },
    text: async () => {
      const r = await readBody();
      return r.base64Encoded
        ? Buffer.from(r.body ?? "", "base64").toString("utf8")
        : (r.body ?? "");
    },
  };
  facade.json = async () => JSON.parse(await facade.text());
  return facade;
}

async function readResponseBody(page, requestId, timeout) {
  if (!requestId) {
    throw new Error("response body is unavailable without a requestId");
  }
  // page.cdp() returns the full CDP response {id, result, ...}
  const unwrap = (r) => r?.result ?? r;
  try {
    return unwrap(await page.cdp("Network.getResponseBody", { requestId }));
  } catch (firstError) {
    // Body may not be ready yet; poll for loadingFinished/Failed then retry once.
    const deadline = Date.now() + Math.min(timeout || 30_000, 30_000);
    while (Date.now() < deadline) {
      const events = await page.events();
      const done = events.some(
        (e) =>
          (e?.method === "Network.loadingFinished" ||
            e?.method === "Network.loadingFailed") &&
          e?.params?.requestId === requestId,
      );
      if (done) break;
      await sleep(POLL_MS);
    }
    try {
      return unwrap(await page.cdp("Network.getResponseBody", { requestId }));
    } catch (retryError) {
      throw new Error(
        `response body is unavailable for request ${requestId}: ${retryError?.message ?? firstError?.message ?? retryError}`,
      );
    }
  }
}

function networkMatches(facade, matcher, kind) {
  if (typeof matcher === "string") {
    return facade.url() === matcher;
  }
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(facade.url());
  }
  if (typeof matcher === "function") {
    const result = matcher(facade);
    if (result && typeof result.then === "function") {
      throw new Error(
        `page.waitFor${kind === "request" ? "Request" : "Response"} does not support async predicates`,
      );
    }
    return Boolean(result);
  }
  throw new TypeError(
    `page.waitFor${kind === "request" ? "Request" : "Response"} expects a string, RegExp, or function matcher, got ${matcher === null ? "null" : typeof matcher}`,
  );
}

function processNetworkEvent(kind, page, matcher, event, requests, timeout) {
  const method = event?.method;
  const params = event?.params ?? {};

  if (method === "Network.requestWillBeSent") {
    const prev = requests.get(params.requestId);
    // Redirect responses are embedded in a new requestWillBeSent.
    if (kind === "response" && params.redirectResponse) {
      const resp = createResponseFacade(
        page,
        {
          requestId: params.requestId,
          response: params.redirectResponse,
          request: prev,
        },
        timeout,
      );
      if (networkMatches(resp, matcher, kind)) return resp;
    }
    const req = createRequestInfo(params);
    requests.set(params.requestId, req);
    if (kind === "request") {
      const facade = createRequestFacade(req);
      if (networkMatches(facade, matcher, kind)) return facade;
    }
    return null;
  }

  if (kind === "response" && method === "Network.responseReceived") {
    const resp = createResponseFacade(
      page,
      {
        requestId: params.requestId,
        response: params.response ?? {},
        request: requests.get(params.requestId),
      },
      timeout,
    );
    return networkMatches(resp, matcher, kind) ? resp : null;
  }

  return null;
}

async function waitForNetworkMatch(kind, page, matcher, options) {
  const rawTimeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(rawTimeout) || rawTimeout < 0) {
    throw new Error("network wait timeout must be a non-negative number");
  }
  const timeout = rawTimeout;
  // 0 means "no timeout" — use a very large but safe deadline.
  const deadline =
    timeout === 0 ? Date.now() + 2_147_483_647 : Date.now() + timeout;
  const requests = new Map();

  await acquireNetwork(page);
  let matched = null;
  try {
    while (Date.now() < deadline) {
      const events = await page.events();
      for (const event of events) {
        const result = processNetworkEvent(
          kind,
          page,
          matcher,
          event,
          requests,
          timeout,
        );
        if (result) {
          matched = result;
          break;
        }
      }
      if (matched) break;
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleep(Math.min(POLL_MS, remaining));
    }
  } finally {
    await releaseNetwork(page);
  }

  if (!matched) {
    const name = kind === "request" ? "Request" : "Response";
    throw new Error(`page.waitFor${name} timed out after ${timeout}ms`);
  }
  return matched;
}

export function installNetworkWaits(proto, define) {
  define(proto, "waitForRequest", function (urlOrPredicate, options = {}) {
    return waitForNetworkMatch("request", this, urlOrPredicate, options);
  });
  define(proto, "waitForResponse", function (urlOrPredicate, options = {}) {
    return waitForNetworkMatch("response", this, urlOrPredicate, options);
  });
}
