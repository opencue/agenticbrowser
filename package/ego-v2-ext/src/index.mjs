/**
 * Port extensions for the v2 TaskSpace/Page runtime.
 *
 * `package/ego-browser-v2` is a byte-for-byte mirror of upstream and must stay
 * that way. The features this port carried in its v1 runtime — Playwright-style
 * locators, the fastObserve/fastAct loop, page.debug() and
 * task.requestUserAction() — are added here instead, onto the v2 objects at run
 * time.
 *
 * How they get there: v2 runs a script as `AsyncFunction(...helperNames, code)`,
 * so `taskSpace`, `claimTaskSpace` and `takeOverTaskSpace` are parameters of the
 * script. PRELUDE reassigns those parameters to wrappers, on the script's first
 * line so reported line numbers do not move. The first TaskSpace a wrapper sees
 * has its prototype patched once: its page-returning methods extend whatever
 * Page they hand out, and the first Page gets the page features on its
 * prototype. Every later TaskSpace and Page — popups included — shares those
 * prototypes.
 */
import { installPageLocators } from "./locator.mjs";
import { installFastLoop } from "./fast.mjs";
import { installPageDebug } from "./debug.mjs";
import { installUserAction } from "./user-action.mjs";
import { installAuthFlows } from "./auth.mjs";
import { installNetworkWaits } from "./network.mjs";
import { installRecording } from "./recording.mjs";

const GLOBAL_KEY = "__egoV2Ext";

/** Helpers whose result is a TaskSpace. All exist in the v2 script context. */
export const TASK_FACTORIES = [
  "taskSpace",
  "claimTaskSpace",
  "takeOverTaskSpace",
];

/** One line, no newline: prepended to the script so line numbers are kept. */
export const PRELUDE = TASK_FACTORIES.map(
  (name) => `${name}=globalThis.${GLOBAL_KEY}.wrap(${name});`,
).join("");

/** TaskSpace methods that return a Page, or (pages) an array of Pages. */
const PAGE_RETURNING = ["page", "userPage", "newPage", "adopt", "pages"];

const patched = new WeakSet();

function isObject(value) {
  return value !== null && typeof value === "object";
}

function defineMethod(proto, name, fn) {
  // Never shadow something v2 already has: if upstream adds a method with the
  // same name, the upstream one wins.
  if (name in proto) return false;
  Object.defineProperty(proto, name, {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return true;
}

export function extendPage(page) {
  if (!isObject(page)) return page;
  const proto = Object.getPrototypeOf(page);
  if (!proto || proto === Object.prototype || patched.has(proto)) return page;
  patched.add(proto);
  installPageLocators(proto, defineMethod);
  installFastLoop(proto, defineMethod);
  installPageDebug(proto, defineMethod);
  installNetworkWaits(proto, defineMethod);
  installRecording(proto, defineMethod);
  return page;
}

function extendResult(result) {
  if (Array.isArray(result)) {
    for (const item of result) extendPage(item);
    return result;
  }
  return extendPage(result);
}

export function extendTask(task) {
  if (!isObject(task)) return task;
  const proto = Object.getPrototypeOf(task);
  if (!proto || proto === Object.prototype || patched.has(proto)) return task;
  patched.add(proto);
  for (const name of PAGE_RETURNING) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    Object.defineProperty(proto, name, {
      value: function (...args) {
        const result = original.apply(this, args);
        return result && typeof result.then === "function"
          ? result.then(extendResult)
          : extendResult(result);
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  installUserAction(proto, defineMethod);
  installAuthFlows(proto, defineMethod);
  return task;
}

export function wrap(factory) {
  if (typeof factory !== "function") return factory;
  const wrapped = async (...args) => extendTask(await factory(...args));
  Object.defineProperty(wrapped, "name", { value: factory.name });
  return wrapped;
}

/** Make the wrappers reachable from PRELUDE and return the source to run. */
export function withExtensions(code, target = globalThis) {
  target[GLOBAL_KEY] = { wrap, extendTask, extendPage };
  return PRELUDE + code;
}
