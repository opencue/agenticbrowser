import { writeFile } from "node:fs/promises";

import { agentWorkspace, loadEnv } from "./env.js";
import { browserCdp } from "./browser-runtime.js";

loadEnv();

export const NAME = process.env.EGO_BROWSER_NAME || "default";

async function defaultSend(req) {
  if (!req || typeof req !== "object" || !req.method) {
    throw new Error(
      `unsupported browser runtime request: ${JSON.stringify(req)}`,
    );
  }
  const response = await browserCdp(
    req.method,
    req.params || {},
    req.session_id,
  );
  return { result: response.result || {} };
}

export const state = {
  send: defaultSend,
  cdpOverride: null,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
  agentWorkspace: () => agentWorkspace(),
  writeFile,
  sessionId: null,
  sessionTargetId: null,
  sessionAt: 0,
  sessionInflight: null,
  preferredTargetId: null,
  defaultTimeout: 10000,
  // Set by observeTaskSpace: this run is watching a space another agent is
  // driving, so the mutating helpers refuse rather than act. Cleared by every
  // helper that takes control (see OBSERVER_RELEASING in helpers.ts).
  observing: false,
  // Last observed Network domain state on the default session (tracked in cdp()).
  networkDomainEnabled: false,
};

/**
 * Refuse a call that would change the page while this session is only watching.
 *
 * Guards the *public facade bindings*, never the shared implementations under
 * them: page.info, screenshot and waitForLoadState all read the page through the
 * same evaluate() that page.evaluate exposes, so guarding evaluate itself would
 * break exactly the reads an observer exists to make.
 *
 * Everything that reaches CDP is refused a second time in the backing layer's
 * transport, which is the load-bearing guard — it covers both the CLI and SDK
 * entry points and every route through them. This one exists for the calls that
 * layer cannot judge: arbitrary JS, which it sees only as Runtime.evaluate, the
 * same method the snapshot it must allow is made of.
 */
export function assertNotObserving(op: string) {
  if (!state.observing) return;
  throw new Error(
    `${op} is not allowed while observing a task space: this session is watching ` +
      `it, not driving it. Reads (snapshot, screenshot, textContent, waitFor*) ` +
      `still work. Call takeOverTaskSpace(<name or id>) to take control.`,
  );
}

export async function send(req) {
  return state.send(req);
}

export function cdpAvailable() {
  return Boolean(state.cdpOverride) || state.send !== defaultSend;
}

export function setOverrides(overrides) {
  const previous = { ...state };
  Object.assign(state, overrides);
  return () => {
    Object.assign(state, previous);
  };
}
