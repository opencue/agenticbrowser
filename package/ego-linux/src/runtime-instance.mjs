/**
 * The v2 runtime keeps Page labels (`p1`, `p2`, …) in a ledger scoped by
 * "browser instance", which it derives as `browser-host:${process.ppid}`
 * (package/ego-browser-v2/src/page-ledger.ts `runtimeInstanceId`). In the
 * native app the script runs inside the browser's own Node host, so the parent
 * pid is stable for the life of the browser. Here every round is a fresh CLI
 * process started by the agent's shell, so the parent pid changes every round:
 * each round read an empty ledger, `task.page("p1")` failed with "page label
 * not found", and `finish()` handed the space to the user as unknown tabs.
 *
 * Pin the instance id to the backing browser instead: the GUID in its DevTools
 * websocket URL is unique per browser launch and the same for every process
 * that attaches to it — the same scope the native app gets.
 */
export function browserInstanceKey(wsUrl) {
  const guid = /\/devtools\/browser\/([^/?#]+)/.exec(String(wsUrl ?? ""))?.[1];
  return guid ? `browser-${guid}` : null;
}

/** Make `process.ppid` report `key` for this process. Returns whether it did. */
export function pinRuntimeInstance(key, target = process) {
  if (!key) return false;
  // `process.ppid` is an own data property that ignores plain assignment;
  // deleting it first lets the redefinition stick.
  delete target.ppid;
  Object.defineProperty(target, "ppid", {
    value: key,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return target.ppid === key;
}
