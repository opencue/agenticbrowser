import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { IS_WINDOWS } from "./platform.mjs";

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * A deterministic kernel-owned endpoint for this user and logical lock path.
 *
 * Linux abstract sockets and Windows named pipes disappear with their owning
 * process. Binding one is atomic, so there is neither an ownerless publication
 * window nor a stale filesystem entry another contender has to delete.
 */
function lockEndpoint(lockDir) {
  const user =
    (typeof process.getuid === "function" && String(process.getuid())) ||
    process.env.USERNAME ||
    process.env.USER ||
    "unknown";
  const key = createHash("sha256")
    .update(`${user}\0${resolve(lockDir)}`)
    .digest("hex")
    .slice(0, 40);
  return IS_WINDOWS ? `\\\\.\\pipe\\ego-lite-${key}` : `\0ego-lite-${key}`;
}

function tryAcquire(endpoint) {
  return new Promise((resolveAttempt, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (error) => {
      if (error?.code === "EADDRINUSE") {
        resolveAttempt(null);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.removeListener("error", onError);
      resolveAttempt(async () => {
        if (!server.listening) return;
        await new Promise((resolveClose, rejectClose) => {
          server.close((error) =>
            error ? rejectClose(error) : resolveClose(),
          );
        });
      });
    });
  });
}

/**
 * Serialize processes with a kernel-owned lock that is released on process exit.
 *
 * `ownerGraceMs` remains accepted for compatibility with older callers but is
 * unnecessary: the operating system, rather than a stale-owner heuristic, owns
 * cleanup.
 */
export async function acquireDirectoryLock(
  lockDir,
  { timeoutMs = 30000, pollMs = 50 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const endpoint = lockEndpoint(lockDir);

  while (Date.now() < deadline) {
    const release = await tryAcquire(endpoint);
    if (release) return release;
    await wait(pollMs);
  }
  throw new Error(`timed out waiting for lock: ${lockDir}`);
}

// Kept as the intent-revealing public name used by the Spaces launcher.
export const acquireLaunchLock = acquireDirectoryLock;
