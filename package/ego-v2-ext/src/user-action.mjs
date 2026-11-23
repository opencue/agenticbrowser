/**
 * task.requestUserAction({ instruction, target?, actionKey?, doneLabel?,
 * cancelLabel?, wait?, timeout?, interval? })
 *
 * Ported from the v1 runtime's taskSpaces.requestUserAction. Hands the space to
 * the user, shows the port's in-page action card (persisted in the Spaces
 * "Needs You" inbox), checks the page is actually visible, sends one desktop
 * notification per action key, and by default waits for Done / Cancel. Done
 * returns control to the agent; Cancel leaves it with the user.
 *
 * The hand-off goes through v2's own task.handOff(), so v2's page ledger knows
 * the user is in control; the card, presentation and notification use the
 * port's `globalThis.ego` bridge, exactly as v1 did.
 */

function egoResult(value, label) {
  if (value && typeof value === "object" && typeof value.error === "string") {
    const error = new Error(`${label}: ${value.error}`);
    if (value.error_code) error.code = value.error_code;
    throw error;
  }
  return value;
}

export function normalizeUserActionOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("task.requestUserAction options must be an object");
  }
  const instruction = String(options.instruction ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
  const wait = options.wait ?? Boolean(instruction);
  const timeout = options.timeout ?? 900;
  const interval = options.interval ?? 0.15;
  if (typeof wait !== "boolean") {
    throw new TypeError("task.requestUserAction wait must be boolean");
  }
  if (wait && !instruction) {
    throw new TypeError(
      "task.requestUserAction wait:true requires a non-empty instruction",
    );
  }
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TypeError(
      "task.requestUserAction timeout must be a non-negative number of seconds",
    );
  }
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new TypeError(
      "task.requestUserAction interval must be a positive number of seconds",
    );
  }
  const actionKey = instruction
    ? String(
        options.actionKey ||
          `manual:${instruction}:${JSON.stringify(options.target ?? null)}`,
      )
        .trim()
        .slice(0, 220)
    : "";
  if (instruction && !actionKey) {
    throw new TypeError("task.requestUserAction actionKey must not be empty");
  }
  return { ...options, instruction, wait, timeout, interval, actionKey };
}

export async function requestUserAction(
  task,
  rawOptions = {},
  ego = globalThis.ego,
) {
  const options = normalizeUserActionOptions(rawOptions);
  const { instruction, wait, timeout, interval, actionKey } = options;
  if (!ego || typeof ego.presentTaskSpace !== "function") {
    throw new Error(
      "task.requestUserAction requires ego task-space presentation",
    );
  }
  const id = task.spaceId;

  let presentation;
  if (task.ownership === "user") {
    presentation = "bring-to-front";
  } else {
    presentation = "hand-off";
    if (task.ownership !== "agentDelegatedToUser") await task.handOff();
  }

  let panel = null;
  if (instruction && typeof ego.showUserAction === "function") {
    panel = egoResult(
      await ego.showUserAction({
        key: actionKey,
        taskSpaceId: id,
        taskSpaceName: task.name,
        instruction,
        target: options.target,
        doneLabel: options.doneLabel,
        cancelLabel: options.cancelLabel,
      }),
      "task.requestUserAction",
    );
  }

  // Asking for a manual action is not permission to take the user's focus:
  // present focus-protected, and notify once per action key.
  const notify = Boolean(instruction) && panel?.alreadyVisible !== true;
  const shown = egoResult(
    await ego.presentTaskSpace(id),
    "task.requestUserAction",
  );
  if (shown?.visible !== true) {
    const reason =
      typeof shown?.reason === "string" ? shown.reason : "not-visible";
    // A headless browser has no window: a desktop notice asking the user to
    // act in it would only mislead them, so say nothing there.
    if (
      instruction &&
      reason !== "headless" &&
      typeof ego.notifyUserAction === "function"
    ) {
      await Promise.resolve(
        ego.notifyUserAction({ instruction, reason }),
      ).catch(() => {});
    }
    throw new Error(
      `task.requestUserAction: the page is not visible (${reason}); do not ask the user to act until presentation succeeds`,
    );
  }
  if (notify && typeof ego.notifyUserAction === "function") {
    await Promise.resolve(ego.notifyUserAction({ instruction })).catch(
      () => {},
    );
  }

  const base = {
    done: true,
    visible: true,
    presentation,
    ...(instruction
      ? {
          actionKey,
          focused: false,
          ...(panel?.requestId ? { requestId: panel.requestId } : {}),
        }
      : {}),
  };
  if (!wait) return base;
  if (
    typeof ego.waitForUserAction !== "function" ||
    typeof ego.clearUserAction !== "function"
  ) {
    throw new Error(
      "task.requestUserAction wait:true requires the user-action runtime",
    );
  }
  const waited = panel?.result
    ? { result: panel.result }
    : egoResult(
        await ego.waitForUserAction({
          key: actionKey,
          requestId: panel?.requestId,
          timeoutMs: timeout * 1000,
          pollMs: interval * 1000,
        }),
        "task.requestUserAction",
      );
  const decision = waited?.result;
  if (decision === "cancel") {
    await ego.clearUserAction(actionKey);
    return { ...base, userResult: "cancel", resumed: false };
  }
  if (decision !== "done") {
    await ego.clearUserAction(actionKey);
    throw new Error(
      `task.requestUserAction received an invalid user result: ${JSON.stringify(decision)}`,
    );
  }
  if (waited?.resumed !== true) {
    const takeOver = globalThis.takeOverTaskSpace;
    if (typeof takeOver !== "function") {
      throw new Error(
        "task.requestUserAction needs takeOverTaskSpace to resume",
      );
    }
    await takeOver(id);
  }
  await ego.clearUserAction(actionKey);
  return { ...base, userResult: "done", resumed: true };
}

export function installUserAction(proto, define) {
  define(proto, "requestUserAction", function (options) {
    return requestUserAction(this, options);
  });
}
