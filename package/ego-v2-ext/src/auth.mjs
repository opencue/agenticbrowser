/**
 * task.loginPreflight(options?) and task.handleChallenge(options?) on v2
 * TaskSpaces, ported from v1's loginPreflightTaskSpace / handleChallengeTaskSpace
 * in package/ego-browser/src/helpers.ts.
 *
 * Key differences from v1:
 * - No nameOrId argument; `this` IS the TaskSpace.
 * - Accepts an optional `options.page` (a v2 Page) to target a specific page
 *   rather than the auto-selected active page.
 * - `evaluate()` is called on a v2 Page (page.evaluate(fn, arg)) instead of
 *   the v1 flat `evaluate(fn, arg)` helper.
 * - `handleChallenge` calls `this.requestUserAction(...)` (installed by
 *   user-action.mjs) instead of the v1 `requestUserActionTaskSpace` helper.
 * - Sleep is a plain Promise/setTimeout; no v1 `waits.waitForTimeout`.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the page to act on.
 *
 * Strategy (matches v1's "current tab" heuristic):
 *  1. Use options.page when explicitly provided.
 *  2. Scan task.tabs() for the tab whose `active` flag is true; use its .page.
 *  3. Fall back to the first item from task.pages() (first managed page).
 *  4. Final fallback: task.page('p1').
 *
 * task.tabs() returns TabInventoryItem[] = { targetId, label, page, title,
 * url, active, openedBy }. Only managed Page instances are eligible for
 * evaluate(); unmanaged tabs are skipped if possible.
 */
async function resolveActivePage(task, options) {
  if (options && options.page != null) return options.page;
  const tabList = await task.tabs();
  const activeTab = tabList.find((t) => t.active);
  if (activeTab && activeTab.page != null) return activeTab.page;
  const pageList = await task.pages();
  if (pageList.length > 0) return pageList[0];
  return task.page("p1");
}

// ---------------------------------------------------------------------------
// In-page helpers (serialised to strings and evaluated in the browser).
// These are plain functions so they serialise cleanly with .toString().
// ---------------------------------------------------------------------------

function inspectLoginPage() {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      !element.disabled &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
  const anchors = inputs.filter((input) => {
    const autocomplete = String(input.autocomplete || "").toLowerCase();
    return (
      input.type === "password" ||
      autocomplete === "current-password" ||
      autocomplete === "one-time-code"
    );
  });
  if (anchors.length === 0) {
    return { detected: false, ready: false, fieldCount: 0, filledCount: 0 };
  }
  const form = anchors[0].form;
  const fields = inputs.filter((input) => {
    if (form && input.form !== form) return false;
    const autocomplete = String(input.autocomplete || "").toLowerCase();
    const identity = `${input.name || ""} ${input.id || ""}`.toLowerCase();
    return (
      anchors.includes(input) ||
      input.type === "email" ||
      autocomplete === "username" ||
      autocomplete === "email" ||
      (/user|email|login/.test(identity) && input.type !== "hidden")
    );
  });
  const filledCount = fields.filter(
    (input) => String(input.value || "").length > 0,
  ).length;
  return {
    detected: true,
    ready: fields.length > 0 && filledCount === fields.length,
    fieldCount: fields.length,
    filledCount,
  };
}

function submitReadyLogin(selector) {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      !element.disabled &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  if (selector) {
    const explicit = document.querySelector(selector);
    if (!explicit || !visible(explicit)) return false;
    explicit.click();
    return true;
  }
  const anchor = Array.from(document.querySelectorAll("input")).find(
    (input) => {
      const autocomplete = String(input.autocomplete || "").toLowerCase();
      return (
        visible(input) &&
        (input.type === "password" ||
          autocomplete === "current-password" ||
          autocomplete === "one-time-code")
      );
    },
  );
  if (!anchor) return false;
  const root = anchor.form || document;
  const submits = Array.from(
    root.querySelectorAll(
      'button[type="submit"],input[type="submit"],button:not([type])',
    ),
  ).filter(visible);
  if (submits.length !== 1) return false;
  submits[0].click();
  return true;
}

function inspectHumanChallenge() {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const findVisible = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && visible(element)) return selector;
    }
    return null;
  };
  const checks = [
    {
      provider: "cloudflare",
      kind: "turnstile",
      responseSelectors: ['input[name="cf-turnstile-response"]'],
      selectors: [".cf-turnstile", "iframe[src*='challenges.cloudflare.com']"],
    },
    {
      provider: "hcaptcha",
      kind: "captcha",
      responseSelectors: [
        'textarea[name="h-captcha-response"]',
        'input[name="h-captcha-response"]',
      ],
      selectors: [".h-captcha", "iframe[src*='hcaptcha.com']"],
    },
    {
      provider: "google",
      kind: "recaptcha",
      responseSelectors: [
        'textarea[name="g-recaptcha-response"]',
        'input[name="g-recaptcha-response"]',
      ],
      selectors: [
        ".g-recaptcha",
        // Not the invisible v3 badge (an anchor iframe with size=invisible),
        // which sits on most reCAPTCHA sites without any challenge.
        "iframe[src*='google.com/recaptcha']:not([src*='size=invisible'])",
        "iframe[src*='recaptcha.net']:not([src*='size=invisible'])",
      ],
    },
  ];
  for (const check of checks) {
    const responses = check.responseSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    );
    if (
      responses.length > 0 &&
      responses.every((input) => String(input.value || "").trim().length > 0)
    ) {
      return { detected: false };
    }
    const target = findVisible(check.selectors);
    if (target) {
      return {
        detected: true,
        provider: check.provider,
        kind: check.kind,
        origin: location.origin,
        target,
      };
    }
  }
  const title = String(document.title || "").toLowerCase();
  if (title.includes("just a moment") || title.includes("attention required")) {
    return {
      detected: true,
      provider: "cloudflare",
      kind: "interstitial",
      origin: location.origin,
      target: "body",
    };
  }
  return { detected: false };
}

// ---------------------------------------------------------------------------
// loginPreflight
// ---------------------------------------------------------------------------

/**
 * Wait briefly for password-manager autofill, then submit when all visible
 * credential fields are populated.
 *
 * @param {object} [options]
 * @param {number}  [options.waitForAutofill=1.5]  Seconds to wait for autofill.
 * @param {number}  [options.interval=0.1]          Poll interval in seconds.
 * @param {boolean|string} [options.submit]         false = never submit; CSS
 *   selector string = click that element; true/undefined = auto-detect submit.
 * @param {Page}   [options.page]                   Override the active page.
 * @returns {Promise<{detected:boolean,ready:boolean,needsUser:boolean,fieldCount:number,filledCount:number,submitted:boolean}>}
 */
export async function loginPreflight(task, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("task.loginPreflight options must be an object");
  }
  const waitForAutofill = options.waitForAutofill ?? 1.5;
  const interval = options.interval ?? 0.1;
  if (!Number.isFinite(waitForAutofill) || waitForAutofill < 0) {
    throw new TypeError(
      "task.loginPreflight waitForAutofill must be non-negative",
    );
  }
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new TypeError("task.loginPreflight interval must be positive");
  }
  if (
    options.submit !== undefined &&
    typeof options.submit !== "boolean" &&
    typeof options.submit !== "string"
  ) {
    throw new TypeError(
      "task.loginPreflight submit must be boolean or a CSS selector",
    );
  }

  const page = await resolveActivePage(task, options);

  const deadline = Date.now() + waitForAutofill * 1000;
  let state;
  while (true) {
    state = await page.evaluate(inspectLoginPage);
    if (!state?.detected || state.ready || Date.now() >= deadline) break;
    await sleep(interval * 1000);
  }

  const detected = state?.detected === true;
  const ready = state?.ready === true;
  const fieldCount = Number(state?.fieldCount) || 0;
  const filledCount = Number(state?.filledCount) || 0;

  let submitted = false;
  if (ready && options.submit !== false) {
    const selector =
      typeof options.submit === "string" ? options.submit.trim() : "";
    submitted =
      (await page.evaluate(submitReadyLogin, selector || null)) === true;
  }

  return {
    detected,
    ready,
    needsUser: detected && !ready,
    fieldCount,
    filledCount,
    submitted,
  };
}

// ---------------------------------------------------------------------------
// handleChallenge
// ---------------------------------------------------------------------------

/**
 * Detect a visible Cloudflare / hCaptcha / reCAPTCHA challenge without
 * taking focus. Give automatic verification a brief window; if the challenge
 * persists, hand off to the user via requestUserAction.
 *
 * @param {object} [options]
 * @param {number} [options.waitForAutomatic=5]  Seconds to wait for auto-resolution.
 * @param {number} [options.interval=0.2]         Poll interval in seconds.
 * @param {string} [options.instruction]          Override the user-action prompt.
 * @param {string} [options.doneLabel]            Label for the Done button.
 * @param {string} [options.cancelLabel]          Label for the Cancel button.
 * @param {number} [options.timeout]              Manual-wait timeout in seconds.
 * @param {Page}   [options.page]                 Override the active page.
 * @returns {Promise<
 *   {detected:false,handled:false} |
 *   {detected:true,provider:string,kind:string,handled:false,resolvedAutomatically:true} |
 *   {detected:true,provider:string,kind:string,handled:true,...requestUserActionResult}
 * >}
 */
export async function handleChallenge(task, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("task.handleChallenge options must be an object");
  }
  const waitForAutomatic = options.waitForAutomatic ?? 5;
  const interval = options.interval ?? 0.2;
  if (!Number.isFinite(waitForAutomatic) || waitForAutomatic < 0) {
    throw new TypeError(
      "task.handleChallenge waitForAutomatic must be non-negative",
    );
  }
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new TypeError("task.handleChallenge interval must be positive");
  }

  const page = await resolveActivePage(task, options);

  let challenge = await page.evaluate(inspectHumanChallenge);
  if (challenge?.detected !== true) {
    return { detected: false, handled: false };
  }

  const first = challenge;
  const deadline = Date.now() + waitForAutomatic * 1000;
  while (challenge?.detected === true && Date.now() < deadline) {
    await sleep(interval * 1000);
    challenge = await page.evaluate(inspectHumanChallenge);
  }

  if (challenge?.detected !== true) {
    return {
      detected: true,
      provider: first.provider,
      kind: first.kind,
      handled: false,
      resolvedAutomatically: true,
    };
  }

  const provider = String(challenge.provider || "unknown");
  const kind = String(challenge.kind || "verification");
  const origin = String(challenge.origin || "unknown-origin");

  // requestUserAction is installed on the same prototype by user-action.mjs.
  const result = await task.requestUserAction({
    instruction:
      options.instruction ||
      "Complete the verification in the browser, then press Done.",
    target: challenge.target,
    actionKey: `human-challenge:${provider}:${kind}:${origin}`,
    doneLabel: options.doneLabel,
    cancelLabel: options.cancelLabel,
    timeout: options.timeout,
    interval: options.interval,
  });

  return {
    detected: true,
    provider,
    kind,
    handled: true,
    ...result,
  };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export function installAuthFlows(proto, define) {
  define(proto, "loginPreflight", function (options) {
    return loginPreflight(this, options);
  });
  define(proto, "handleChallenge", function (options) {
    return handleChallenge(this, options);
  });
}
