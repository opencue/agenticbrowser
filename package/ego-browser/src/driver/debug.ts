import { state } from "../state.js";
import { isEgoHardStopError } from "../ego-errors.js";
import * as nav from "./nav.js";
import * as observe from "./observe.js";

type DebugOptions = {
  includeEvents?: boolean;
  includeScreenshot?: boolean;
  includeSnapshot?: boolean;
  snapshotScope?: "only_within_viewport" | "full_page";
  maxSnapshotChars?: number;
  eventLimit?: number;
  redact?: boolean;
};

const DEFAULT_EVENT_LIMIT = 20;
const DEFAULT_SNAPSHOT_CHARS = 2000;
const URL_REDACTED = "REDACTED";

/**
 * Capture an agent-friendly page debug dump.
 *
 * The dump is JSON-serializable and intentionally compact: page info, tabs,
 * viewport snapshot excerpt, screenshot path, recent CDP event summaries, and
 * helper/session state. Section failures are reported under `errors` so agents
 * can still see partial state. Task-space hard stops are rethrown.
 *
 * @param {{includeEvents?: boolean, includeScreenshot?: boolean, includeSnapshot?: boolean, snapshotScope?: "only_within_viewport"|"full_page", maxSnapshotChars?: number, eventLimit?: number, redact?: boolean}} [options]
 * @returns {Promise<object>}
 */
export async function debug(options: DebugOptions = {}) {
  const redact = options.redact !== false;
  const errors: Record<string, object> = {};
  const dump: Record<string, any> = {
    timestamp: new Date(state.now()).toISOString(),
    session: {
      hasSession: Boolean(state.sessionId),
      targetId: state.sessionTargetId || null,
      preferredTargetId: state.preferredTargetId || null,
      defaultTimeout: state.defaultTimeout,
      networkDomainEnabled: state.networkDomainEnabled,
    },
  };

  const info = await safeSection("info", errors, () => nav.pageInfo());
  if (info) {
    dump.info = redactPageInfo(info, redact);
  }

  const tabs = await safeSection("tabs", errors, () =>
    nav.listTabs({ includeChrome: true }),
  );
  if (tabs) {
    dump.tabs = tabs.map((tab) => redactTab(tab, redact));
  }

  const currentTab = await safeSection("currentTab", errors, () =>
    nav.currentTab(),
  );
  if (currentTab) {
    dump.currentTab = redactTab(currentTab, redact);
  }

  if (options.includeSnapshot !== false) {
    const scope = options.snapshotScope ?? "only_within_viewport";
    const snapshot = await safeSection("snapshot", errors, () =>
      observe.snapshotRaw({ scope }),
    );
    if (snapshot) {
      const content = String(snapshot.content || "");
      dump.snapshot = {
        scope,
        chars: content.length,
        excerpt: truncate(
          content,
          effectiveLimit(options.maxSnapshotChars, DEFAULT_SNAPSHOT_CHARS),
        ),
        refCount: Array.isArray(snapshot.refs) ? snapshot.refs.length : 0,
      };
    }
  }

  if (options.includeScreenshot !== false) {
    const screenshotPath = await safeSection("screenshot", errors, () =>
      observe.screenshot(),
    );
    if (screenshotPath) {
      dump.screenshot = { path: screenshotPath };
    }
  }

  if (options.includeEvents !== false) {
    const events = await safeSection("events", errors, () =>
      observe.drainEvents(),
    );
    if (events) {
      const limit = effectiveLimit(options.eventLimit, DEFAULT_EVENT_LIMIT);
      const shown = limit === 0 ? [] : events.slice(-limit);
      dump.events = {
        drained: true,
        count: events.length,
        shown: shown.length,
        items: shown.map((event) => summarizeEvent(event, redact)),
      };
    }
  }

  if (Object.keys(errors).length) {
    dump.errors = errors;
  }
  return dump;
}

async function safeSection(
  name: string,
  errors: Record<string, object>,
  fn: () => Promise<any>,
) {
  try {
    return await fn();
  } catch (error) {
    if (isEgoHardStopError(error)) throw error;
    errors[name] = errorSummary(error);
    return undefined;
  }
}

function errorSummary(error: unknown) {
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const out: Record<string, unknown> = {
      name: typeof obj.name === "string" ? obj.name : "Error",
      message:
        typeof obj.message === "string" ? obj.message : formatUnknown(error),
    };
    if (typeof obj.error_code === "string") {
      out.code = obj.error_code;
    }
    return out;
  }
  return { name: "Error", message: formatUnknown(error) };
}

function redactPageInfo(info: any, redact: boolean) {
  if (!info || typeof info !== "object" || !("url" in info)) {
    return info;
  }
  return { ...info, url: redactUrl(info.url, redact) };
}

function redactTab(tab: any, redact: boolean) {
  if (!tab || typeof tab !== "object") return tab;
  return { ...tab, url: redactUrl(tab.url, redact) };
}

function summarizeEvent(event: any, redact: boolean) {
  const params = event?.params || {};
  const out: Record<string, unknown> = {
    method: String(event?.method || "unknown"),
  };
  if (event?.sessionId) out.sessionId = String(event.sessionId);
  copyScalar(out, params, "requestId");
  copyScalar(out, params, "loaderId");
  copyScalar(out, params, "frameId");
  copyScalar(out, params, "type");
  copyScalar(out, params, "errorText");
  copyScalar(out, params, "reason");
  copyScalar(out, params, "name");

  const url =
    params.url ||
    params.request?.url ||
    params.response?.url ||
    params.targetInfo?.url;
  if (url) out.url = redactUrl(url, redact);

  if (params.response?.status !== undefined) {
    out.status = params.response.status;
  }
  if (params.targetInfo) {
    out.target = {
      targetId: params.targetInfo.targetId,
      type: params.targetInfo.type,
      title: params.targetInfo.title,
      url: redactUrl(params.targetInfo.url, redact),
    };
  }
  if (params.message) {
    out.message = truncate(String(params.message), 500);
  }
  if (Array.isArray(params.args)) {
    out.args = params.args.slice(0, 5).map((arg) =>
      truncate(
        String(
          arg?.value ??
            arg?.unserializableValue ??
            arg?.description ??
            arg?.type,
        ),
        200,
      ),
    );
  }
  if (params.exceptionDetails) {
    out.exception = {
      text: truncate(String(params.exceptionDetails.text || ""), 300),
      description: truncate(
        String(params.exceptionDetails.exception?.description || ""),
        500,
      ),
    };
  }
  return out;
}

function copyScalar(out: Record<string, unknown>, params: any, key: string) {
  if (
    params[key] === undefined ||
    params[key] === null ||
    (typeof params[key] !== "string" &&
      typeof params[key] !== "number" &&
      typeof params[key] !== "boolean")
  ) {
    return;
  }
  out[key] = params[key];
}

function redactUrl(value: unknown, redact: boolean) {
  if (typeof value !== "string" || !value) return value;
  if (!redact) return truncate(value, 1000);
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, URL_REDACTED);
    }
    if (url.hash) {
      url.hash = `#${URL_REDACTED}`;
    }
    return truncate(url.toString(), 1000);
  } catch {
    return truncate(value, 1000);
  }
}

function effectiveLimit(value: unknown, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function formatUnknown(value: unknown) {
  try {
    return String(value);
  } catch {
    return "Unknown error";
  }
}
