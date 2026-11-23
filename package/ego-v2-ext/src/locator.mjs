/**
 * Playwright-style locators on v2 Pages: page.locator(), page.getByRole(),
 * getByText(), getByLabel(), getByPlaceholder(), getByAltText(), getByTitle(),
 * getByTestId(). Locator objects are immutable and chainable.
 *
 * Actions delegate to the v2 Page when the locator maps cleanly to a v2-native
 * selector string. When it cannot (getByLabel, chained/scoped locators, filter,
 * nth on role selectors, all reads), elements are resolved in-page via
 * page.evaluate() and — for actions — marked with a temporary CSS attribute so
 * the v2 Page can target them normally.
 */

const DEFAULT_TIMEOUT = 8000;
const POLL_INTERVAL_MS = 50;

// ---------------------------------------------------------------------------
// In-page function — MUST BE SELF-CONTAINED (no outer references).
// All helpers are defined inside the body. page.evaluate() stringifies this
// function and runs it in the browser as: (async __egoPageEvaluate() {
//   return await _EGO_IN_PAGE(JSON.parse(arg));
// })();
// ---------------------------------------------------------------------------
/* eslint-disable no-unused-vars */
async function _EGO_IN_PAGE(cmd) {
  // --- text matching ---
  function matchText(text, pattern, exact) {
    if (pattern !== null && typeof pattern === "object" && "regex" in pattern) {
      try {
        return new RegExp(pattern.regex, pattern.flags || "").test(text);
      } catch {
        return false;
      }
    }
    const p = String(pattern);
    if (exact) return text === p;
    return text.toLowerCase().includes(p.toLowerCase());
  }

  // --- computed role (best-effort ARIA mapping) ---
  function getRole(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    const type = (el.type || "").toLowerCase();
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset")
        return "button";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    const map = {
      a: "link",
      button: "button",
      select: "combobox",
      textarea: "textbox",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
      img: "img",
      nav: "navigation",
      main: "main",
      article: "article",
      ul: "list",
      ol: "list",
      li: "listitem",
      table: "table",
      td: "cell",
      th: "columnheader",
      tr: "row",
      dialog: "dialog",
      form: "form",
      section: "region",
      header: "banner",
      footer: "contentinfo",
      fieldset: "group",
      menu: "menu",
      meter: "meter",
      progress: "progressbar",
      option: "option",
    };
    return map[tag] || "generic";
  }

  // --- accessible name (simplified ARIA computation) ---
  function getAccName(el) {
    const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .trim()
        .split(/\s+/)
        .map((id) => {
          const ref = document.getElementById(id);
          return ref ? ref.textContent.trim() : "";
        })
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "img") return (el.getAttribute && el.getAttribute("alt")) || "";
    if (
      tag === "input" &&
      (el.type === "submit" || el.type === "button" || el.type === "reset")
    ) {
      return el.value || (el.getAttribute && el.getAttribute("value")) || "";
    }
    if (el.id) {
      try {
        const label = document.querySelector(
          'label[for="' + CSS.escape(el.id) + '"]',
        );
        if (label) return label.textContent.trim();
      } catch {}
    }
    const parentLabel = el.closest && el.closest("label");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone
        .querySelectorAll("input,select,textarea")
        .forEach((c) => c.remove());
      return clone.textContent.trim();
    }
    // For interactive/heading elements, text content is the name.
    if (
      [
        "button",
        "a",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "option",
        "summary",
      ].includes(tag)
    ) {
      return el.textContent.trim();
    }
    // Fallback: trim text content.
    return (el.textContent || "").trim();
  }

  // --- describe an element for diagnostics ---
  function describeEl(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : "?";
    return {
      tag,
      role: getRole(el),
      text: (el.textContent || "").trim().slice(0, 80),
      id: el.id || undefined,
    };
  }

  // --- core query engine ---
  function queryAll(spec, root) {
    root = root || document;
    switch (spec.kind) {
      case "raw": {
        // spec.sel is a plain CSS selector for in-page resolution.
        // v2-special prefixes (loc=role:, text=, xpath=, @, etc.) will
        // fail querySelectorAll and return [] from the catch.
        try {
          if (/^xpath=/i.test(spec.sel)) {
            const it = document.evaluate(
              spec.sel.slice(6),
              root,
              null,
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
              null,
            );
            const out = [];
            for (let i = 0; i < it.snapshotLength; i++) {
              const node = it.snapshotItem(i);
              if (node && node.nodeType === 1) out.push(node);
            }
            return out;
          }
          return [...root.querySelectorAll(spec.sel)];
        } catch {
          return [];
        }
      }
      case "role": {
        const els = [...root.querySelectorAll("*")];
        return els.filter((el) => {
          if (getRole(el) !== spec.role) return false;
          if (spec.name === undefined) return true;
          return matchText(getAccName(el), spec.name, spec.exact !== false);
        });
      }
      case "text": {
        // Find elements whose trimmed text content matches; prefer leaf elements.
        const all = [...root.querySelectorAll("*")];
        const hits = all.filter((el) => {
          if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return false;
          const text = (el.textContent || "").trim();
          if (!text) return false;
          return matchText(text, spec.text, spec.exact);
        });
        // An ancestor's textContent contains its children's, so keep only the
        // innermost matches: otherwise body/html/wrappers match every text.
        const set = new Set(hits);
        return hits.filter(
          (el) =>
            ![...el.querySelectorAll("*")].some((child) => set.has(child)),
        );
      }
      case "label": {
        const labels = [...root.querySelectorAll("label")];
        const matched = labels.filter((label) => {
          const clone = label.cloneNode(true);
          clone
            .querySelectorAll("input,select,textarea")
            .forEach((c) => c.remove());
          const text = clone.textContent.trim();
          return matchText(text, spec.text, spec.exact);
        });
        const result = [];
        const seen = new Set();
        for (const label of matched) {
          let ctrl;
          if (label.control) {
            ctrl = label.control;
          } else if (label.htmlFor) {
            ctrl = document.getElementById(label.htmlFor);
          } else {
            ctrl = label.querySelector("input,select,textarea");
          }
          if (ctrl && !seen.has(ctrl)) {
            seen.add(ctrl);
            result.push(ctrl);
          }
        }
        return result;
      }
      case "placeholder": {
        const els = [...root.querySelectorAll("[placeholder]")];
        return els.filter((el) => {
          const ph = el.getAttribute("placeholder") || "";
          return matchText(ph, spec.text, spec.exact);
        });
      }
      case "altText": {
        const els = [...root.querySelectorAll("[alt]")];
        return els.filter((el) => {
          const alt = el.getAttribute("alt") || "";
          return matchText(alt, spec.text, spec.exact);
        });
      }
      case "title": {
        const els = [...root.querySelectorAll("[title]")];
        return els.filter((el) => {
          const title = el.getAttribute("title") || "";
          return matchText(title, spec.text, spec.exact);
        });
      }
      case "testid": {
        try {
          return [...root.querySelectorAll('[data-testid="' + spec.id + '"]')];
        } catch {
          return [];
        }
      }
      case "nth": {
        const base = queryAll(spec.base, root);
        if (spec.index === -1)
          return base.length > 0 ? [base[base.length - 1]] : [];
        return spec.index < base.length ? [base[spec.index]] : [];
      }
      case "scoped": {
        // All child-spec matches that are descendants of any ancestor-spec match.
        const ancestors = queryAll(spec.ancestor, root);
        const seen = new Set();
        const result = [];
        for (const anc of ancestors) {
          const children = queryAll(spec.child, anc);
          for (const ch of children) {
            if (!seen.has(ch)) {
              seen.add(ch);
              result.push(ch);
            }
          }
        }
        return result;
      }
      case "filter": {
        const base = queryAll(spec.base, root);
        return base.filter((el) => {
          if (spec.hasText !== undefined) {
            const text = (el.textContent || "").trim();
            if (!matchText(text, spec.hasText, false)) return false;
          }
          if (spec.hasNotText !== undefined) {
            const text = (el.textContent || "").trim();
            if (matchText(text, spec.hasNotText, false)) return false;
          }
          return true;
        });
      }
      default:
        return [];
    }
  }

  // --- operations ---
  const { op } = cmd;

  if (op === "count") {
    return queryAll(cmd.spec).length;
  }

  if (op === "mark") {
    const els = queryAll(cmd.spec);
    if (els.length !== 1) {
      return {
        ok: false,
        count: els.length,
        candidates: els.slice(0, 5).map(describeEl),
      };
    }
    els[0].setAttribute("data-ego-loc", cmd.id);
    return { ok: true };
  }

  if (op === "unmark") {
    const el = document.querySelector('[data-ego-loc="' + cmd.id + '"]');
    if (el) el.removeAttribute("data-ego-loc");
    return null;
  }

  if (op === "textContent") {
    const els = queryAll(cmd.spec);
    if (els.length !== 1)
      return {
        _strict: true,
        count: els.length,
        candidates: els.slice(0, 5).map(describeEl),
      };
    return { value: els[0].textContent };
  }

  if (op === "innerText") {
    const els = queryAll(cmd.spec);
    if (els.length !== 1)
      return {
        _strict: true,
        count: els.length,
        candidates: els.slice(0, 5).map(describeEl),
      };
    return {
      value:
        els[0] instanceof HTMLElement ? els[0].innerText : els[0].textContent,
    };
  }

  if (op === "innerHTML") {
    const els = queryAll(cmd.spec);
    if (els.length !== 1)
      return {
        _strict: true,
        count: els.length,
        candidates: els.slice(0, 5).map(describeEl),
      };
    return { value: els[0].innerHTML };
  }

  if (op === "inputValue") {
    const els = queryAll(cmd.spec);
    if (els.length !== 1)
      return {
        _strict: true,
        count: els.length,
        candidates: els.slice(0, 5).map(describeEl),
      };
    const el = els[0];
    const ctrl = el instanceof HTMLLabelElement && el.control ? el.control : el;
    if (
      ctrl instanceof HTMLInputElement ||
      ctrl instanceof HTMLTextAreaElement ||
      ctrl instanceof HTMLSelectElement
    ) {
      return { value: ctrl.value };
    }
    return {
      _error: "inputValue target must be an input, textarea, or select",
    };
  }

  if (op === "getAttribute") {
    const els = queryAll(cmd.spec);
    if (els.length !== 1)
      return {
        _strict: true,
        count: els.length,
        candidates: els.slice(0, 5).map(describeEl),
      };
    return { value: els[0].getAttribute(cmd.name) };
  }

  if (op === "isChecked") {
    const els = queryAll(cmd.spec);
    if (els.length !== 1)
      return {
        _strict: true,
        count: els.length,
        candidates: els.slice(0, 5).map(describeEl),
      };
    const el = els[0];
    const ctrl = el instanceof HTMLLabelElement && el.control ? el.control : el;
    if (
      ctrl instanceof HTMLInputElement &&
      (ctrl.type === "checkbox" || ctrl.type === "radio")
    ) {
      return { value: ctrl.checked };
    }
    return {
      _error: "isChecked target must be a checkbox or radio input",
    };
  }

  if (op === "isCheckedForAction") {
    // Non-strict: returns {value: bool|null} — null if 0 matches.
    const els = queryAll(cmd.spec);
    if (els.length === 0) return { value: null };
    const el = els[0];
    const ctrl = el instanceof HTMLLabelElement && el.control ? el.control : el;
    if (
      ctrl instanceof HTMLInputElement &&
      (ctrl.type === "checkbox" || ctrl.type === "radio")
    ) {
      return { value: ctrl.checked };
    }
    return { value: null };
  }

  if (op === "isVisible") {
    const els = queryAll(cmd.spec);
    if (els.length === 0) return { value: false };
    const el = els[0];
    if (!(el instanceof Element)) return { value: false };
    if (typeof el.checkVisibility === "function") {
      return {
        value: el.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        }),
      };
    }
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    )
      return { value: false };
    const rect = el.getBoundingClientRect();
    return { value: rect.width > 0 && rect.height > 0 };
  }

  if (op === "isEnabled") {
    const els = queryAll(cmd.spec);
    if (els.length === 0) return { value: false };
    const el = els[0];
    const ctrl = el instanceof HTMLLabelElement && el.control ? el.control : el;
    if (!(ctrl instanceof Element)) return { value: false };
    if (ctrl.getAttribute("aria-disabled") === "true") return { value: false };
    if ("disabled" in ctrl && ctrl.disabled) return { value: false };
    return { value: !ctrl.closest("fieldset[disabled]") };
  }

  if (op === "isEditable") {
    const els = queryAll(cmd.spec);
    if (els.length === 0) return { value: false };
    const el = els[0];
    const ctrl = el instanceof HTMLLabelElement && el.control ? el.control : el;
    if (!(ctrl instanceof Element)) return { value: false };
    if (ctrl.isContentEditable) return { value: true };
    if (
      ctrl instanceof HTMLInputElement ||
      ctrl instanceof HTMLTextAreaElement
    ) {
      return { value: !ctrl.disabled && !ctrl.readOnly };
    }
    return { value: false };
  }

  if (op === "boundingBox") {
    const els = queryAll(cmd.spec);
    if (els.length !== 1)
      return {
        _strict: true,
        count: els.length,
        candidates: els.slice(0, 5).map(describeEl),
      };
    const el = els[0];
    if (!(el instanceof Element)) return { value: null };
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return { value: null };
    return {
      value: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }

  if (op === "allInnerTexts") {
    const els = queryAll(cmd.spec);
    return els.map((el) =>
      el instanceof HTMLElement ? el.innerText : el.textContent || "",
    );
  }

  if (op === "allTextContents") {
    const els = queryAll(cmd.spec);
    return els.map((el) => el.textContent || null);
  }

  if (op === "evaluate") {
    const els = queryAll(cmd.spec);
    if (els.length !== 1)
      return {
        _strict: true,
        count: els.length,
        candidates: els.slice(0, 5).map(describeEl),
      };
    const fn = (0, eval)("(" + cmd.fn + ")");
    const val = await Promise.resolve(
      fn(els[0], cmd.arg === null ? undefined : cmd.arg),
    );
    return { value: val };
  }

  if (op === "evaluateAll") {
    const els = queryAll(cmd.spec);
    const fn = (0, eval)("(" + cmd.fn + ")");
    const val = await Promise.resolve(
      fn(els, cmd.arg === null ? undefined : cmd.arg),
    );
    return { value: val };
  }

  if (op === "waitForState") {
    const els = queryAll(cmd.spec);
    const { state } = cmd;
    if (state === "attached") return { matched: els.length > 0 };
    if (state === "detached") return { matched: els.length === 0 };
    const el = els[0];
    if (state === "visible") {
      if (!el) return { matched: false };
      if (typeof el.checkVisibility === "function") {
        return {
          matched: el.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }),
        };
      }
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        return { matched: false };
      const rect = el.getBoundingClientRect();
      return { matched: rect.width > 0 && rect.height > 0 };
    }
    if (state === "hidden") {
      if (!el) return { matched: true };
      if (typeof el.checkVisibility === "function") {
        return {
          matched: !el.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }),
        };
      }
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        return { matched: true };
      const rect = el.getBoundingClientRect();
      return { matched: !(rect.width > 0 && rect.height > 0) };
    }
    return { matched: false };
  }

  return null;
}
/* eslint-enable no-unused-vars */

// ---------------------------------------------------------------------------
// Spec → v2-native selector string conversion
// Returns null when v2 cannot express the spec.
// ---------------------------------------------------------------------------

function escapeAttr(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function specToV2Sel(spec) {
  switch (spec.kind) {
    case "raw":
      // Passthrough; already a v2-compatible selector string.
      return spec.sel;
    case "role": {
      if (spec.name === undefined) return `loc=role:${spec.role}`;
      // exact is true by default for role name matching.
      const exact = spec.exact !== false;
      const nameOp = exact ? "=" : "*=";
      return `loc=role:${spec.role}[name${nameOp}"${escapeAttr(spec.name)}"]`;
    }
    case "text":
      if (spec.exact) return `text="${escapeAttr(spec.text)}"`;
      // v2 reads an unquoted text= body that starts and ends with a quote as an
      // exact match and trims it, so such text, and text with surrounding
      // whitespace, goes through the in-page engine to stay a substring match.
      if (/^["']|["']$|^\s|\s$/.test(spec.text)) return null;
      return `text=${spec.text}`;
    case "testid":
      return `[data-testid="${escapeAttr(spec.id)}"]`;
    case "placeholder":
      return spec.exact
        ? `[placeholder="${escapeAttr(spec.text)}"]`
        : `[placeholder*="${escapeAttr(spec.text)}"]`;
    case "altText":
      return spec.exact
        ? `[alt="${escapeAttr(spec.text)}"]`
        : `[alt*="${escapeAttr(spec.text)}"]`;
    case "title":
      return spec.exact
        ? `[title="${escapeAttr(spec.text)}"]`
        : `[title*="${escapeAttr(spec.text)}"]`;
    case "nth": {
      const baseSel = specToV2Sel(spec.base);
      if (baseSel === null) return null;
      // >> nth=N is supported after CSS, text=, loc=href: — not loc=role:.
      if (/^loc=role:/i.test(baseSel) || /^xpath=/i.test(baseSel)) return null;
      return `${baseSel} >> nth=${spec.index}`;
    }
    // label, scoped, filter → needs in-page resolution.
    default:
      return null;
  }
}

// Human-readable description for error messages.
function describeSpec(spec) {
  switch (spec.kind) {
    case "raw":
      return spec.sel;
    case "role":
      return spec.name !== undefined
        ? `role=${spec.role}[name="${spec.name}"]`
        : `role=${spec.role}`;
    case "text":
      return spec.exact ? `text="${spec.text}"` : `text=${spec.text}`;
    case "label":
      return `label="${spec.text}"`;
    case "placeholder":
      return `placeholder="${spec.text}"`;
    case "altText":
      return `alt="${spec.text}"`;
    case "title":
      return `title="${spec.text}"`;
    case "testid":
      return `testid="${spec.id}"`;
    case "nth":
      return `${describeSpec(spec.base)} >> nth=${spec.index}`;
    case "scoped":
      return `${describeSpec(spec.ancestor)} >> ${describeSpec(spec.child)}`;
    case "filter": {
      const parts = [describeSpec(spec.base)];
      if (spec.hasText !== undefined) parts.push(`.filter(hasText)`);
      return parts.join("");
    }
    default:
      return JSON.stringify(spec);
  }
}

// Serialize a hasText/hasNotText value for the spec.
function textMatcher(value) {
  if (value instanceof RegExp) {
    return { regex: value.source, flags: value.flags };
  }
  return String(value);
}

// Is the spec a @ref or ref= selector that cannot be resolved in-page?
function isRefSelector(spec) {
  if (spec.kind !== "raw") return false;
  const sel = String(spec.sel);
  return sel.startsWith("@") || sel.startsWith("ref=");
}

// ---------------------------------------------------------------------------
// LocatorError
// ---------------------------------------------------------------------------

class LocatorError extends Error {
  constructor(description, count, candidates) {
    let msg =
      count === 0
        ? `Locator "${description}" resolved to 0 elements`
        : `Locator "${description}" resolved to ${count} elements (expected exactly 1)`;
    if (candidates && candidates.length > 0) {
      msg +=
        "\n\nLocator diagnostics:\n" +
        candidates
          .map(
            (c) =>
              `  ${c.tag}[role=${c.role}]${c.id ? `#${c.id}` : ""} "${c.text}"`,
          )
          .join("\n");
    }
    super(msg);
    this.name = "LocatorError";
  }
}

// ---------------------------------------------------------------------------
// Locator class
// ---------------------------------------------------------------------------

class Locator {
  constructor(page, spec) {
    this._page = page;
    this._spec = spec;
  }

  // ---- Chaining / scoping ------------------------------------------------

  locator(selector) {
    const childSpec =
      typeof selector === "string"
        ? specFromSelector(selector)
        : selector._spec;
    return new Locator(this._page, {
      kind: "scoped",
      ancestor: this._spec,
      child: childSpec,
    });
  }

  getByRole(role, opts = {}) {
    return new Locator(this._page, {
      kind: "scoped",
      ancestor: this._spec,
      child: { kind: "role", role: String(role).toLowerCase(), ...opts },
    });
  }

  getByText(text, opts = {}) {
    return new Locator(this._page, {
      kind: "scoped",
      ancestor: this._spec,
      child: { kind: "text", text, exact: Boolean(opts.exact) },
    });
  }

  getByLabel(text, opts = {}) {
    return new Locator(this._page, {
      kind: "scoped",
      ancestor: this._spec,
      child: { kind: "label", text, exact: Boolean(opts.exact) },
    });
  }

  getByPlaceholder(text, opts = {}) {
    return new Locator(this._page, {
      kind: "scoped",
      ancestor: this._spec,
      child: { kind: "placeholder", text, exact: Boolean(opts.exact) },
    });
  }

  getByAltText(text, opts = {}) {
    return new Locator(this._page, {
      kind: "scoped",
      ancestor: this._spec,
      child: { kind: "altText", text, exact: Boolean(opts.exact) },
    });
  }

  getByTitle(text, opts = {}) {
    return new Locator(this._page, {
      kind: "scoped",
      ancestor: this._spec,
      child: { kind: "title", text, exact: Boolean(opts.exact) },
    });
  }

  getByTestId(id) {
    return new Locator(this._page, {
      kind: "scoped",
      ancestor: this._spec,
      child: { kind: "testid", id: String(id) },
    });
  }

  // ---- Narrowing ---------------------------------------------------------

  nth(index) {
    const value = Number(index);
    if (!Number.isInteger(value) || value < -1) {
      throw new TypeError(
        "locator.nth requires a non-negative integer (or -1 for last)",
      );
    }
    return new Locator(this._page, {
      kind: "nth",
      base: this._spec,
      index: value,
    });
  }

  first() {
    return new Locator(this._page, { kind: "nth", base: this._spec, index: 0 });
  }

  last() {
    return new Locator(this._page, {
      kind: "nth",
      base: this._spec,
      index: -1,
    });
  }

  filter(opts = {}) {
    const spec = { kind: "filter", base: this._spec };
    if (Object.prototype.hasOwnProperty.call(opts, "hasText")) {
      spec.hasText = textMatcher(opts.hasText);
    }
    if (Object.prototype.hasOwnProperty.call(opts, "hasNotText")) {
      spec.hasNotText = textMatcher(opts.hasNotText);
    }
    return new Locator(this._page, spec);
  }

  // ---- Internal helpers --------------------------------------------------

  /**
   * Resolve the locator to exactly one element for an action.
   * For v2-native selectors: returns the selector string directly (v2 handles
   * auto-wait). For in-page specs: marks the element with a temp attr and
   * returns its CSS selector plus a cleanup callback.
   */
  async _resolve(opts = {}) {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    // forceMark: the caller runs its own document.querySelector(sel), which
    // only understands CSS, so a v2 selector (loc=role:, text=) will not do.
    const v2sel = opts.forceMark ? null : specToV2Sel(this._spec);
    if (v2sel !== null) {
      // v2's own action methods handle auto-wait and actionability.
      return { sel: v2sel, cleanup: null };
    }
    // In-page resolution with marking.
    const id = `ego${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + timeout;
    while (true) {
      const result = await this._page.evaluate(_EGO_IN_PAGE, {
        op: "mark",
        spec: this._spec,
        id,
      });
      if (result && result.ok) {
        const sel = `[data-ego-loc="${id}"]`;
        return {
          sel,
          cleanup: () =>
            this._page
              .evaluate(_EGO_IN_PAGE, { op: "unmark", id })
              .catch(() => {}),
        };
      }
      const count = result ? result.count : 0;
      if (count === 0 && Date.now() < deadline) {
        await _sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw new LocatorError(
        describeSpec(this._spec),
        count,
        result ? result.candidates : [],
      );
    }
  }

  /**
   * Run a read op via page.evaluate with auto-wait for exactly 1 match.
   * Throws LocatorError on strictness violation.
   */
  async _readOne(op, extra = {}, opts = {}) {
    if (isRefSelector(this._spec)) {
      throw new Error(
        `Locator reads are not supported for @ref selectors; ` +
          `use page.evaluate() or a CSS/role locator instead`,
      );
    }
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    const deadline = Date.now() + timeout;
    while (true) {
      const result = await this._page.evaluate(_EGO_IN_PAGE, {
        op,
        spec: this._spec,
        ...extra,
      });
      if (result && result._strict) {
        if (result.count === 0 && Date.now() < deadline) {
          await _sleep(POLL_INTERVAL_MS);
          continue;
        }
        throw new LocatorError(
          describeSpec(this._spec),
          result.count,
          result.candidates,
        );
      }
      return result;
    }
  }

  // ---- Actions -----------------------------------------------------------

  async click(opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      return await this._page.click(sel, opts);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async dblclick(opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      return await this._page.dblclick(sel, opts);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async hover(opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      return await this._page.hover(sel, opts);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async focus(opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      return await this._page.focus(sel, opts);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async fill(value, opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      return await this._page.fill(sel, value, opts);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async clear(opts = {}) {
    return this.fill("", opts);
  }

  async press(key, opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      return await this._page.press(sel, key, opts);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async pressSequentially(text, opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      await this._page.focus(sel);
      for (const char of String(text)) {
        await this._page.press(sel, char, opts);
      }
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async check(opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      // Only click if currently unchecked.
      const r = await this._page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const ctrl =
          el instanceof HTMLLabelElement && el.control ? el.control : el;
        if (
          ctrl instanceof HTMLInputElement &&
          (ctrl.type === "checkbox" || ctrl.type === "radio")
        ) {
          return ctrl.checked;
        }
        return null;
      }, sel);
      if (r !== true) {
        await this._page.click(sel, opts);
      }
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async uncheck(opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      const r = await this._page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const ctrl =
          el instanceof HTMLLabelElement && el.control ? el.control : el;
        if (
          ctrl instanceof HTMLInputElement &&
          (ctrl.type === "checkbox" || ctrl.type === "radio")
        ) {
          return ctrl.checked;
        }
        return null;
      }, sel);
      if (r !== false) {
        await this._page.click(sel, opts);
      }
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async setChecked(checked, opts = {}) {
    return checked ? this.check(opts) : this.uncheck(opts);
  }

  async selectOption(value, opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      return await this._page.selectOption(sel, value, opts);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async setInputFiles(paths, opts = {}) {
    const { sel, cleanup } = await this._resolve(opts);
    try {
      return await this._page.setInputFiles(sel, paths);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async scrollIntoViewIfNeeded(opts = {}) {
    const { sel, cleanup } = await this._resolve({ ...opts, forceMark: true });
    try {
      await this._page.evaluate((s) => {
        document
          .querySelector(s)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }, sel);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async dispatchEvent(type, eventInit = {}, opts = {}) {
    const { sel, cleanup } = await this._resolve({ ...opts, forceMark: true });
    try {
      await this._page.evaluate(
        ([s, t, init]) => {
          const el = document.querySelector(s);
          if (el) el.dispatchEvent(new Event(t, init));
        },
        [sel, type, eventInit],
      );
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async blur(opts = {}) {
    const { sel, cleanup } = await this._resolve({ ...opts, forceMark: true });
    try {
      await this._page.evaluate((s) => {
        document.querySelector(s)?.blur();
      }, sel);
    } finally {
      if (cleanup) await cleanup();
    }
  }

  async dragTo(targetLocator, opts = {}) {
    const { sel: srcSel, cleanup: srcCleanup } = await this._resolve(opts);
    const { sel: dstSel, cleanup: dstCleanup } =
      await targetLocator._resolve(opts);
    try {
      return await this._page.dragAndDrop(srcSel, dstSel, opts);
    } finally {
      if (srcCleanup) await srcCleanup();
      if (dstCleanup) await dstCleanup();
    }
  }

  // ---- Reads (auto-wait for exactly 1 match) -----------------------------

  async textContent(opts = {}) {
    const r = await this._readOne("textContent", {}, opts);
    return r.value;
  }

  async innerText(opts = {}) {
    const r = await this._readOne("innerText", {}, opts);
    return r.value;
  }

  async innerHTML(opts = {}) {
    const r = await this._readOne("innerHTML", {}, opts);
    return r.value;
  }

  async inputValue(opts = {}) {
    const r = await this._readOne("inputValue", {}, opts);
    if (r._error) throw new Error(r._error);
    return r.value;
  }

  async getAttribute(name, opts = {}) {
    const r = await this._readOne("getAttribute", { name }, opts);
    return r.value;
  }

  async isChecked(opts = {}) {
    const r = await this._readOne("isChecked", {}, opts);
    if (r._error) throw new Error(r._error);
    return r.value;
  }

  async isVisible() {
    const r = await this._page.evaluate(_EGO_IN_PAGE, {
      op: "isVisible",
      spec: this._spec,
    });
    return r.value;
  }

  async isHidden() {
    return !(await this.isVisible());
  }

  async isEnabled() {
    const r = await this._page.evaluate(_EGO_IN_PAGE, {
      op: "isEnabled",
      spec: this._spec,
    });
    return r.value;
  }

  async isDisabled() {
    return !(await this.isEnabled());
  }

  async isEditable() {
    const r = await this._page.evaluate(_EGO_IN_PAGE, {
      op: "isEditable",
      spec: this._spec,
    });
    return r.value;
  }

  async boundingBox(opts = {}) {
    const r = await this._readOne("boundingBox", {}, opts);
    return r.value;
  }

  // ---- Non-strict reads --------------------------------------------------

  async count() {
    if (isRefSelector(this._spec)) return 1;
    return this._page.evaluate(_EGO_IN_PAGE, {
      op: "count",
      spec: this._spec,
    });
  }

  async allInnerTexts() {
    return this._page.evaluate(_EGO_IN_PAGE, {
      op: "allInnerTexts",
      spec: this._spec,
    });
  }

  async allTextContents() {
    return this._page.evaluate(_EGO_IN_PAGE, {
      op: "allTextContents",
      spec: this._spec,
    });
  }

  async evaluate(fn, arg) {
    const fnStr = typeof fn === "function" ? fn.toString() : String(fn);
    const r = await this._readOne("evaluate", {
      fn: fnStr,
      arg: arg === undefined ? null : arg,
    });
    if (r._error) throw new Error(r._error);
    return r.value;
  }

  async evaluateAll(fn, arg) {
    if (isRefSelector(this._spec)) {
      throw new Error(
        "locator.evaluateAll is not supported for @ref selectors",
      );
    }
    const fnStr = typeof fn === "function" ? fn.toString() : String(fn);
    const r = await this._page.evaluate(_EGO_IN_PAGE, {
      op: "evaluateAll",
      spec: this._spec,
      fn: fnStr,
      arg: arg === undefined ? null : arg,
    });
    if (r && r._error) throw new Error(r._error);
    return r.value;
  }

  // ---- waitFor -----------------------------------------------------------

  async waitFor(opts = {}) {
    const state = opts.state ?? "visible";
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    const v2sel = specToV2Sel(this._spec);

    if (v2sel !== null) {
      return this._page.waitForSelector(v2sel, { state, timeout });
    }

    // In-page polling for complex specs.
    const deadline = Date.now() + timeout;
    while (true) {
      const r = await this._page.evaluate(_EGO_IN_PAGE, {
        op: "waitForState",
        spec: this._spec,
        state,
      });
      if (r && r.matched) return true;
      if (Date.now() >= deadline) {
        throw new Error(
          `Locator "${describeSpec(this._spec)}" did not reach state ` +
            `"${state}" within ${timeout}ms`,
        );
      }
      await _sleep(POLL_INTERVAL_MS);
    }
  }

  // ---- Screenshot --------------------------------------------------------

  async screenshot(opts = {}) {
    const box = await this.boundingBox(opts);
    if (!box) {
      throw new Error(
        `Locator "${describeSpec(this._spec)}" has no bounding box`,
      );
    }
    return this._page.screenshot({ ...opts, clip: box });
  }
}

// ---------------------------------------------------------------------------
// Sleep helper (not in-page, used by polling loops)
// ---------------------------------------------------------------------------

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// installPageLocators
// ---------------------------------------------------------------------------

/**
 * Turn the selector strings the v2 snapshot prints (loc=role:, loc=testid:,
 * loc=css:, css=, text=) into specs the in-page engine can also read, so
 * page.locator("loc=role:button[name=\"Save\"]").count() works like an action
 * on the same selector. Anything else stays a raw selector for v2.
 */
export function specFromSelector(selector) {
  const sel = String(selector);
  let m =
    /^loc=role:([a-z][a-z-]*)(?:\[name(\*?)="((?:[^"\\]|\\.)*)"\])?$/i.exec(
      sel,
    );
  if (m) {
    const spec = { kind: "role", role: m[1].toLowerCase() };
    if (m[3] !== undefined) {
      spec.name = m[3].replace(/\\(.)/g, "$1");
      spec.exact = m[2] !== "*";
    }
    return spec;
  }
  m = /^loc=testid:(.+)$/i.exec(sel);
  if (m) return { kind: "testid", id: m[1] };
  m = /^(?:loc=css:|css=)(.+)$/i.exec(sel);
  if (m) return { kind: "raw", sel: m[1] };
  m = /^text="((?:[^"\\]|\\.)*)"$/.exec(sel);
  if (m)
    return { kind: "text", text: m[1].replace(/\\(.)/g, "$1"), exact: true };
  m = /^text=(.+)$/.exec(sel);
  if (m) return { kind: "text", text: m[1], exact: false };
  return { kind: "raw", sel };
}

export function installPageLocators(proto, define) {
  define(proto, "locator", function (selector) {
    return new Locator(this, specFromSelector(selector));
  });

  define(proto, "getByRole", function (role, opts = {}) {
    return new Locator(this, {
      kind: "role",
      role: String(role).toLowerCase(),
      name: opts.name,
      exact: opts.exact,
    });
  });

  define(proto, "getByText", function (text, opts = {}) {
    return new Locator(this, {
      kind: "text",
      text,
      exact: Boolean(opts.exact),
    });
  });

  define(proto, "getByLabel", function (text, opts = {}) {
    return new Locator(this, {
      kind: "label",
      text,
      exact: Boolean(opts.exact),
    });
  });

  define(proto, "getByPlaceholder", function (text, opts = {}) {
    return new Locator(this, {
      kind: "placeholder",
      text,
      exact: Boolean(opts.exact),
    });
  });

  define(proto, "getByAltText", function (text, opts = {}) {
    return new Locator(this, {
      kind: "altText",
      text,
      exact: Boolean(opts.exact),
    });
  });

  define(proto, "getByTitle", function (text, opts = {}) {
    return new Locator(this, {
      kind: "title",
      text,
      exact: Boolean(opts.exact),
    });
  });

  define(proto, "getByTestId", function (id) {
    return new Locator(this, { kind: "testid", id: String(id) });
  });
}

// Export Locator and helpers for testing.
export { Locator, specToV2Sel, describeSpec, LocatorError, _EGO_IN_PAGE };
