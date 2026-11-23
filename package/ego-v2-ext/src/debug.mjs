/**
 * page.debug({ includeScreenshot = true, snapshotChars = 4000, events = 40 })
 *
 * One JSON-serializable dump for an agent that is stuck, ported from the v1
 * runtime: page info (url/title/size/scroll, or the pending dialog), a
 * viewport snapshot excerpt, a screenshot path, and a summary of the recent
 * CDP events (console errors, failed requests, navigations). Like v1 it drains
 * the event buffer. Every part is collected independently, so one failing
 * part is reported in `errors` instead of losing the rest of the dump.
 */

const SECRET_QUERY =
  /([?&](?:token|access_token|code|key|secret|password|auth|session)[^=&]*=)[^&#]*/gi;

export function redactUrl(url) {
  return typeof url === "string"
    ? url.replace(SECRET_QUERY, "$1<redacted>")
    : url;
}

export function summarizeEvents(events, limit = 40) {
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    const method = event?.method;
    const params = event?.params ?? {};
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails ?? {};
      out.push({
        kind: "exception",
        text: String(
          details.exception?.description ?? details.text ?? "",
        ).slice(0, 300),
      });
    } else if (method === "Runtime.consoleAPICalled") {
      if (params.type !== "error" && params.type !== "warning") continue;
      const text = (params.args ?? [])
        .map((arg) => arg?.value ?? arg?.description ?? "")
        .join(" ");
      out.push({
        kind: `console.${params.type}`,
        text: String(text).slice(0, 300),
      });
    } else if (method === "Log.entryAdded") {
      const entry = params.entry ?? {};
      if (entry.level !== "error" && entry.level !== "warning") continue;
      out.push({
        kind: `log.${entry.level}`,
        text: String(entry.text ?? "").slice(0, 300),
        url: redactUrl(entry.url),
      });
    } else if (method === "Network.loadingFailed") {
      out.push({
        kind: "request.failed",
        text: String(params.errorText ?? ""),
        blocked: params.blockedReason,
      });
    } else if (method === "Network.responseReceived") {
      const status = params.response?.status;
      if (!(status >= 400)) continue;
      out.push({
        kind: "response.error",
        status,
        url: redactUrl(params.response?.url),
      });
    } else if (method === "Page.frameNavigated" && !params.frame?.parentId) {
      out.push({ kind: "navigated", url: redactUrl(params.frame?.url) });
    } else if (method === "Page.javascriptDialogOpening") {
      out.push({
        kind: "dialog",
        type: params.type,
        text: String(params.message ?? "").slice(0, 300),
      });
    }
  }
  return out.slice(-limit);
}

export async function pageDebug(page, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("page.debug options must be an object");
  }
  const includeScreenshot = options.includeScreenshot !== false;
  const snapshotChars = Number.isFinite(options.snapshotChars)
    ? options.snapshotChars
    : 4000;
  const eventLimit = Number.isFinite(options.events) ? options.events : 40;
  const dump = { label: page.label, spaceId: page.spaceId, errors: {} };

  const part = async (name, fn) => {
    try {
      return await fn();
    } catch (error) {
      dump.errors[name] = String(error?.message ?? error).slice(0, 300);
      return undefined;
    }
  };

  const info = await part("info", () => page.info());
  if (info) dump.page = { ...info, url: redactUrl(info.url) };
  const snapshot = await part("snapshot", () => page.snapshot());
  if (typeof snapshot === "string") {
    dump.snapshot =
      snapshot.length > snapshotChars
        ? `${snapshot.slice(0, snapshotChars)}\n[... ${snapshot.length - snapshotChars} more characters]`
        : snapshot;
  }
  if (includeScreenshot) {
    dump.screenshot = await part("screenshot", () => page.screenshot());
  }
  const events = await part("events", () => page.events());
  if (events) {
    dump.events = summarizeEvents(events, eventLimit);
    dump.eventCount = events.length;
  }
  if (Object.keys(dump.errors).length === 0) delete dump.errors;
  return dump;
}

export function installPageDebug(proto, define) {
  define(proto, "debug", function (options) {
    return pageDebug(this, options);
  });
}
