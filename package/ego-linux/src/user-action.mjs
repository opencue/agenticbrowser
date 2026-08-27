import { spawn } from "node:child_process";

import { createSessionResolver } from "./session.mjs";

const HOST_ID = "ego-user-action-overlay";
const ISOLATED_WORLD = "ego-lite-user-action-v1";
const MAX_INSTRUCTION_LENGTH = 360;
const MAX_KEY_LENGTH = 220;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function compactText(value, limit) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function normalizeTarget(target) {
  if (typeof target === "string") {
    const value = compactText(target, 300);
    return value ? { selector: value, text: value } : null;
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return null;
  }
  const selector = compactText(target.selector, 300);
  const text = compactText(target.text, 300);
  return selector || text ? { selector, text } : null;
}

function normalizeAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("showUserAction requires an action object");
  }
  const instruction = compactText(action.instruction, MAX_INSTRUCTION_LENGTH);
  if (!instruction) {
    throw new Error("showUserAction requires a non-empty instruction");
  }
  const key = compactText(action.key, MAX_KEY_LENGTH);
  if (!key) throw new Error("showUserAction requires a non-empty key");
  return {
    key,
    instruction,
    target: normalizeTarget(action.target),
    doneLabel: compactText(action.doneLabel, 40) || "Done",
    cancelLabel: compactText(action.cancelLabel, 40) || "Cancel",
  };
}

/**
 * Interactive user-action panel injected into the selected task-space page.
 *
 * The panel lives in the page so it remains visible after the short-lived CLI
 * process hands control to the user. While a caller waits, a missing panel is
 * re-injected after navigation. Results are stored on the host DOM node and are
 * read through an isolated CDP world. The website can see the closed-shadow host
 * in the DOM, but its JavaScript world cannot read the private expandos that hold
 * the controls, action, or result.
 */
export function createUserActionApi(cdp, { listTabs }) {
  const sessionForActiveTab = createSessionResolver(cdp, {
    listTabs,
    op: "user action",
  });
  let activeAction = null;
  let isolatedContext = null;

  async function contextFor(sessionId) {
    if (isolatedContext?.sessionId === sessionId) return isolatedContext.id;
    const { frameTree } = await cdp.call("Page.getFrameTree", {}, sessionId);
    const frameId = frameTree?.frame?.id;
    if (!frameId)
      throw new Error("user action could not resolve the main frame");
    const { executionContextId } = await cdp.call(
      "Page.createIsolatedWorld",
      {
        frameId,
        worldName: ISOLATED_WORLD,
        grantUniveralAccess: false,
      },
      sessionId,
    );
    if (!executionContextId) {
      throw new Error("user action could not create an isolated world");
    }
    isolatedContext = { sessionId, id: executionContextId };
    return executionContextId;
  }

  async function run(expression, retry = true) {
    const sessionId = await sessionForActiveTab();
    const contextId = await contextFor(sessionId);
    try {
      const { result } = await cdp.call(
        "Runtime.evaluate",
        {
          expression,
          contextId,
          returnByValue: true,
          awaitPromise: false,
        },
        sessionId,
      );
      return result?.value ?? null;
    } catch (error) {
      if (!retry) throw error;
      // Navigation invalidates an isolated execution context without changing
      // the attached target session. Recreate it once, then surface real errors.
      isolatedContext = null;
      return run(expression, false);
    }
  }

  async function probe() {
    return run(
      `(${__egoUserActionProbe.toString()})(${JSON.stringify(HOST_ID)})`,
    );
  }

  async function render(action) {
    return run(
      `(${__egoUserActionRender.toString()})(${JSON.stringify(HOST_ID)},${JSON.stringify(action)})`,
    );
  }

  return {
    async show(action) {
      const normalized = normalizeAction(action);
      const existing = await probe().catch(() => null);
      const alreadyVisible = Boolean(
        existing?.visible && existing.key === normalized.key,
      );
      activeAction = normalized;
      const rendered = await render(normalized);
      return {
        done: true,
        alreadyVisible,
        targetFound: rendered?.targetFound === true,
        ...(existing?.key === normalized.key && existing?.result
          ? { result: existing.result }
          : {}),
      };
    },

    async wait({ key, timeoutMs = 900_000, pollMs = 150 } = {}) {
      const wanted = compactText(key, MAX_KEY_LENGTH);
      if (!wanted) throw new Error("waitForUserAction requires a key");
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error("waitForUserAction timeoutMs must be non-negative");
      }
      if (!Number.isFinite(pollMs) || pollMs <= 0) {
        throw new Error("waitForUserAction pollMs must be positive");
      }
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const current = await probe().catch(() => null);
        if (current?.key === wanted && current.result) {
          return { done: true, result: current.result };
        }
        if (
          (!current || current.key !== wanted) &&
          activeAction?.key === wanted
        ) {
          await render(activeAction).catch(() => {});
        }
        if (Date.now() >= deadline) {
          throw new Error(`waitForUserAction timed out after ${timeoutMs}ms`);
        }
        await sleep(pollMs);
      }
    },

    async clear(key = undefined) {
      const wanted = compactText(key, MAX_KEY_LENGTH);
      activeAction = null;
      await run(
        `(${__egoUserActionClear.toString()})(${JSON.stringify(HOST_ID)},${JSON.stringify(wanted)})`,
      ).catch(() => {});
      return { done: true };
    },
  };
}

/** Best-effort desktop fallback when Chromium could not be presented. */
export function notifyUserAction(
  { instruction, reason } = {},
  { spawnProcess = spawn } = {},
) {
  const detail = compactText(instruction, MAX_INSTRUCTION_LENGTH);
  const why = compactText(reason, 80);
  const body = detail || "The agent needs a manual browser action.";
  const child = spawnProcess(
    "notify-send",
    [
      "--app-name=Ego Lite",
      "--urgency=critical",
      "Ego Lite needs your input",
      why ? `${body}\n(${why})` : body,
    ],
    {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.on?.("error", () => {});
  child.unref?.();
  return { done: true };
}

function __egoUserActionProbe(hostId) {
  const host = document.getElementById(hostId);
  const action = host?.__egoAction;
  if (!host || !action) return null;
  const result = host.__egoResult;
  return {
    key: action.key,
    result: result?.key === action.key ? result.result : null,
    visible: host.isConnected,
    targetFound: host.__egoTargetFound === true,
  };
}

function __egoUserActionClear(hostId, key) {
  const host = document.getElementById(hostId);
  if (!host?.__egoShadow) return true;
  if (key && host.__egoAction?.key !== key) return false;
  if (window.__egoUserActionSync) {
    window.removeEventListener("scroll", window.__egoUserActionSync);
    window.removeEventListener("resize", window.__egoUserActionSync);
    window.__egoUserActionSync = null;
  }
  host.remove();
  return true;
}

function __egoUserActionRender(hostId, action) {
  const parent = document.body || document.documentElement;
  if (!parent) return { targetFound: false };

  let host = document.getElementById(hostId);
  // A site may deliberately reserve our public host id. Its DOM wrapper has no
  // isolated-world state, so replace it rather than trusting or mutating it.
  if (host && !host.__egoShadow) {
    host.remove();
    host = null;
  }
  if (!host) {
    host = document.createElement("div");
    host.id = hostId;
    host.style.cssText =
      "all:initial;position:fixed;inset:0;width:0;height:0;" +
      "z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    const css =
      ":host{all:initial}" +
      "#ring{display:none;position:fixed;pointer-events:none;border:3px solid #ffb020;" +
      "border-radius:10px;box-sizing:border-box;box-shadow:0 0 0 6px rgba(255,176,32,.24);" +
      "animation:ego-action-pulse 1.25s ease-in-out infinite}" +
      "@keyframes ego-action-pulse{0%,100%{box-shadow:0 0 0 5px rgba(255,176,32,.20)}" +
      "50%{box-shadow:0 0 0 11px rgba(255,176,32,.08)}}" +
      "#panel{position:fixed;right:20px;bottom:20px;width:min(420px,calc(100vw - 40px));" +
      "padding:18px;border-radius:16px;box-sizing:border-box;pointer-events:auto;" +
      "background:rgba(22,24,30,.96);color:#fff;border:1px solid rgba(255,255,255,.14);" +
      "box-shadow:0 22px 70px rgba(0,0,0,.42);backdrop-filter:blur(16px);" +
      "font:14px/1.45 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}" +
      "#title{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;" +
      "color:#ffbf47;margin-bottom:7px}" +
      "#instruction{font-size:16px;font-weight:620;white-space:pre-wrap;overflow-wrap:anywhere}" +
      "#hint{min-height:18px;margin-top:8px;color:rgba(255,255,255,.65);font-size:12px}" +
      "#buttons{display:flex;justify-content:flex-end;gap:9px;margin-top:16px}" +
      "button{appearance:none;border:1px solid rgba(255,255,255,.22);border-radius:999px;" +
      "padding:9px 15px;background:transparent;color:#fff;font:600 13px/1 system-ui;cursor:pointer}" +
      "button:hover{border-color:rgba(255,255,255,.55)}" +
      "#done{background:#2f6df6;border-color:#2f6df6}" +
      "#panel.resolved button{display:none}";
    if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in shadow) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
      } catch {
        const style = document.createElement("style");
        style.textContent = css;
        shadow.append(style);
      }
    } else {
      const style = document.createElement("style");
      style.textContent = css;
      shadow.append(style);
    }
    const ring = document.createElement("div");
    ring.id = "ring";
    const panel = document.createElement("section");
    panel.id = "panel";
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("aria-live", "assertive");
    panel.innerHTML =
      '<div id="title">Agent needs your help</div>' +
      '<div id="instruction"></div><div id="hint"></div>' +
      '<div id="buttons"><button id="cancel"></button><button id="done"></button></div>';
    shadow.append(ring, panel);
    host.__egoShadow = shadow;
    parent.append(host);
  }

  const previousKey = host.__egoAction?.key;
  if (previousKey !== action.key) host.__egoResult = null;
  host.__egoAction = action;
  const shadow = host.__egoShadow;
  const panel = shadow.getElementById("panel");
  const hint = shadow.getElementById("hint");
  shadow.getElementById("instruction").textContent = action.instruction;
  const done = shadow.getElementById("done");
  const cancel = shadow.getElementById("cancel");
  done.textContent = action.doneLabel;
  cancel.textContent = action.cancelLabel;

  const resolve = (result) => {
    host.__egoResult = { key: action.key, result, at: Date.now() };
    panel.classList.add("resolved");
    hint.textContent =
      result === "done"
        ? "Done — the agent can resume."
        : "Cancelled — the agent will remain stopped.";
  };
  done.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    resolve("done");
  };
  cancel.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    resolve("cancel");
  };

  const existingResult = host.__egoResult;
  panel.classList.toggle(
    "resolved",
    existingResult?.key === action.key && Boolean(existingResult.result),
  );
  if (existingResult?.key === action.key && existingResult.result) {
    hint.textContent =
      existingResult.result === "done"
        ? "Done — the agent can resume."
        : "Cancelled — the agent will remain stopped.";
  }

  const findTarget = () => {
    const request = action.target;
    if (!request) return null;
    if (request.selector) {
      try {
        const selected = document.querySelector(request.selector);
        if (selected) return selected;
      } catch {
        // A human-readable text target is often not valid CSS.
      }
    }
    const needle = String(request.text || "")
      .trim()
      .toLowerCase();
    if (!needle) return null;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
    );
    while (walker.nextNode()) {
      const element = walker.currentNode;
      if (element.closest?.(`#${hostId}`)) continue;
      const text = String(element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (text && text.length < 240 && text.includes(needle)) return element;
    }
    return null;
  };

  const target = findTarget();
  if (target && previousKey !== action.key) {
    const before = target.getBoundingClientRect();
    if (before.bottom < 0 || before.top > window.innerHeight) {
      target.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }
  const sync = () => {
    const ring = shadow.getElementById("ring");
    const found = findTarget();
    host.__egoTargetFound = Boolean(found);
    if (!found) {
      ring.style.display = "none";
      if (action.target && !host.__egoResult) {
        hint.textContent =
          "Follow the instruction; the target could not be highlighted.";
      }
      return;
    }
    const rect = found.getBoundingClientRect();
    ring.style.display = "block";
    ring.style.left = Math.max(2, rect.left - 5) + "px";
    ring.style.top = Math.max(2, rect.top - 5) + "px";
    ring.style.width = Math.max(10, rect.width + 10) + "px";
    ring.style.height = Math.max(10, rect.height + 10) + "px";
    if (!host.__egoResult)
      hint.textContent =
        "Complete the highlighted step, then choose an option.";
  };
  if (window.__egoUserActionSync) {
    window.removeEventListener("scroll", window.__egoUserActionSync);
    window.removeEventListener("resize", window.__egoUserActionSync);
  }
  window.__egoUserActionSync = sync;
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync, { passive: true });
  sync();
  return { targetFound: host.__egoTargetFound === true };
}
