import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { replaceFile } from "./atomic-write.mjs";
import { acquireDirectoryLock } from "./launch-lock.mjs";
import { COLLABORATION_REQUEST_FILE, STATE_DIR } from "./paths.mjs";
import {
  ensurePrivateStateDir,
  securePrivateStateFile,
} from "./private-state.mjs";

const STORE_VERSION = 1;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_REQUESTS = 100;
const COLLABORATION_LOCK = join(STATE_DIR, "collaboration-requests.lock");

function compactText(value, limit) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function failure(message, { status = 400, code, request } = {}) {
  return Object.assign(new Error(message), {
    status,
    ...(code ? { code } : {}),
    ...(request ? { request: clone(request) } : {}),
  });
}

function normalizeTarget(target) {
  if (typeof target === "string") {
    return compactText(target, 300)
      ? { description: "Highlighted page element" }
      : null;
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return null;
  }
  const hasSelector = Boolean(compactText(target.selector, 300));
  const description =
    compactText(target.text, 240) ||
    (hasSelector ? "Highlighted page element" : "");
  return description ? { description } : null;
}

function normalizeAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw failure("collaboration request must be an object");
  }
  const actionKey = compactText(action.actionKey ?? action.key, 220);
  const instruction = compactText(action.instruction, 1000);
  const taskSpaceId = Number(action.taskSpaceId);
  if (!actionKey) throw failure("collaboration request requires an action key");
  if (!instruction) {
    throw failure("collaboration request requires an instruction");
  }
  if (!Number.isInteger(taskSpaceId) || taskSpaceId <= 0) {
    throw failure("collaboration request requires a numeric task-space id");
  }
  return {
    actionKey,
    taskSpaceId,
    taskSpaceName:
      compactText(action.taskSpaceName, 160) || `Task space ${taskSpaceId}`,
    agentProfile:
      compactText(action.agentProfile ?? action.profile, 160) || null,
    agentSession:
      compactText(action.agentSession ?? action.session, 160) || null,
    type: "manual",
    title: compactText(action.title, 120) || "Agent needs your help",
    instruction,
    target: normalizeTarget(action.target),
    risk: ["routine", "sensitive", "destructive"].includes(action.risk)
      ? action.risk
      : "routine",
    preview: ["none", "page", "target"].includes(action.preview)
      ? action.preview
      : "none",
    doneLabel: compactText(action.doneLabel, 40) || "Done",
    cancelLabel: compactText(action.cancelLabel, 40) || "Cancel",
  };
}

function requestContent(request) {
  return JSON.stringify({
    actionKey: request.actionKey,
    taskSpaceId: request.taskSpaceId,
    type: request.type,
    title: request.title,
    instruction: request.instruction,
    target: request.target,
    risk: request.risk,
    preview: request.preview,
    doneLabel: request.doneLabel,
    cancelLabel: request.cancelLabel,
  });
}

function emptyState() {
  return { version: STORE_VERSION, requests: [] };
}

function parseState(contents) {
  const state = JSON.parse(contents);
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new SyntaxError("collaboration state must be an object");
  }
  if (state.version !== STORE_VERSION || !Array.isArray(state.requests)) {
    throw new SyntaxError("unsupported collaboration state schema");
  }
  return state;
}

function retainState(state, now) {
  const pending = state.requests.filter(
    (request) => request.status === "pending",
  );
  const terminal = state.requests
    .filter(
      (request) =>
        request.status !== "pending" &&
        Number(request.terminalAt) >= now - TERMINAL_RETENTION_MS,
    )
    .sort((left, right) => Number(right.terminalAt) - Number(left.terminalAt))
    .slice(0, MAX_TERMINAL_REQUESTS);
  state.requests = [...pending, ...terminal];
  return state;
}

export function collaborationInboxEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(
    String(env.EGO_LINUX_COLLABORATION_INBOX || ""),
  );
}

/** Durable cross-process source of truth for manual agent/user handoffs. */
export function createCollaborationStore({
  file = COLLABORATION_REQUEST_FILE,
  lock = COLLABORATION_LOCK,
  now = () => Date.now(),
  id = () => randomUUID(),
} = {}) {
  async function readState() {
    try {
      return retainState(parseState(await readFile(file, "utf8")), now());
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      if (!(error instanceof SyntaxError)) throw error;
      const quarantine = `${file}.corrupt-${now()}`;
      await rename(file, quarantine);
      await securePrivateStateFile(quarantine);
      return emptyState();
    }
  }

  async function writeState(state) {
    retainState(state, now());
    await replaceFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    await securePrivateStateFile(file);
  }

  async function withLock(operation) {
    await ensurePrivateStateDir();
    const release = await acquireDirectoryLock(lock, { pollMs: 5 });
    try {
      return await operation(await readState());
    } finally {
      await release();
    }
  }

  function requireRequest(state, requestId) {
    const request = state.requests.find(
      (candidate) => candidate.id === requestId,
    );
    if (!request) {
      throw failure("collaboration request not found", {
        status: 404,
        code: "EGO_COLLAB_NOT_FOUND",
      });
    }
    return request;
  }

  function conflict(message, request) {
    throw failure(message, {
      status: 409,
      code: "EGO_COLLAB_CONFLICT",
      request,
    });
  }

  return {
    async create(action) {
      const normalized = normalizeAction(action);
      return withLock(async (state) => {
        const existing = state.requests.find(
          (request) =>
            request.status === "pending" &&
            request.taskSpaceId === normalized.taskSpaceId &&
            request.actionKey === normalized.actionKey,
        );
        if (existing) {
          if (requestContent(existing) !== requestContent(normalized)) {
            conflict(
              "action key is already used by a different request",
              existing,
            );
          }
          return clone(existing);
        }
        const createdAt = now();
        const request = {
          id: id(),
          version: 1,
          ...normalized,
          status: "pending",
          createdAt,
        };
        state.requests.push(request);
        await writeState(state);
        return clone(request);
      });
    },

    async get(requestId) {
      return withLock(async (state) =>
        clone(
          state.requests.find((request) => request.id === requestId) ?? null,
        ),
      );
    },

    async findByAction(actionKey, taskSpaceId) {
      const wantedKey = compactText(actionKey, 220);
      const wantedSpace = Number(taskSpaceId);
      return withLock(async (state) => {
        const matches = state.requests
          .filter(
            (request) =>
              request.actionKey === wantedKey &&
              (!Number.isInteger(wantedSpace) ||
                request.taskSpaceId === wantedSpace),
          )
          .sort((left, right) => right.createdAt - left.createdAt);
        return clone(matches[0] ?? null);
      });
    },

    async list({ view = "pending" } = {}) {
      if (!new Set(["pending", "recent", "all"]).has(view)) {
        throw failure("invalid collaboration request view");
      }
      return withLock(async (state) => {
        const requests = state.requests
          .filter((request) => {
            if (view === "pending") return request.status === "pending";
            if (view === "recent") {
              return (
                request.status !== "pending" && request.status !== "archived"
              );
            }
            return request.status !== "archived";
          })
          .sort((left, right) => {
            if (left.status === "pending" && right.status === "pending") {
              return left.createdAt - right.createdAt;
            }
            return (
              Number(right.terminalAt ?? right.createdAt) -
              Number(left.terminalAt ?? left.createdAt)
            );
          });
        return clone(requests);
      });
    },

    async open(requestId, { requestVersion } = {}) {
      return withLock(async (state) => {
        const request = requireRequest(state, requestId);
        if (request.status !== "pending") return clone(request);
        if (requestVersion !== request.version) {
          conflict("collaboration request version changed", request);
        }
        if (!request.openedAt) {
          request.openedAt = now();
          request.version += 1;
          await writeState(state);
        }
        return clone(request);
      });
    },

    async respond(requestId, { requestVersion, result } = {}) {
      if (result !== "done" && result !== "cancel") {
        throw failure("manual response must be done or cancel", {
          status: 422,
          code: "EGO_COLLAB_INVALID_RESPONSE",
        });
      }
      return withLock(async (state) => {
        const request = requireRequest(state, requestId);
        if (request.status !== "pending") {
          if (request.response?.result === result) return clone(request);
          conflict("collaboration request was already answered", request);
        }
        if (requestVersion !== request.version) {
          conflict("collaboration request version changed", request);
        }
        request.status = result === "done" ? "resolved" : "cancelled";
        request.terminalAt = now();
        request.response = {
          result,
          respondedAt: request.terminalAt,
          resumed: false,
        };
        request.version += 1;
        await writeState(state);
        return clone(request);
      });
    },

    async markResume(
      requestId,
      { resumed, expectedResult = "done", reason = null } = {},
    ) {
      return withLock(async (state) => {
        const request = requireRequest(state, requestId);
        if (request.response?.result !== expectedResult) {
          conflict("collaboration response no longer matches", request);
        }
        const normalizedResumed = resumed === true;
        const normalizedReason = compactText(reason, 160) || null;
        if (
          request.response.resumed === normalizedResumed &&
          (request.response.resumeFailure ?? null) === normalizedReason
        ) {
          return clone(request);
        }
        request.response.resumed = normalizedResumed;
        if (normalizedReason) request.response.resumeFailure = normalizedReason;
        else delete request.response.resumeFailure;
        request.version += 1;
        await writeState(state);
        return clone(request);
      });
    },

    async archive(requestId, { requestVersion } = {}) {
      return withLock(async (state) => {
        const request = requireRequest(state, requestId);
        if (request.status === "pending") {
          throw failure("pending requests cannot be archived", {
            status: 422,
            code: "EGO_COLLAB_PENDING",
          });
        }
        if (request.status === "archived") return clone(request);
        if (requestVersion !== request.version) {
          conflict("collaboration request version changed", request);
        }
        request.status = "archived";
        request.version += 1;
        await writeState(state);
        return clone(request);
      });
    },
  };
}
