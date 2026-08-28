import {
  listProcessesByEnvironment,
  processIsAlive,
  terminateProcess,
} from "./platform.mjs";

export const SESSION_ENV_NAMES = [
  "EGO_BROWSER_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "OMX_SESSION_ID",
];

const NEXT_BIN =
  /(?:^|[\\/])(?:node_modules[\\/]\.bin[\\/]next|next[\\/]dist[\\/]bin[\\/]next(?:\.js)?)$/i;
const VITE_BIN =
  /(?:^|[\\/])(?:node_modules[\\/](?:\.bin[\\/]vite|vite[\\/]bin[\\/]vite(?:\.js)?)|vite(?:\.js)?)$/i;
const REACT_SCRIPTS_BIN =
  /(?:^|[\\/])(?:node_modules[\\/]\.bin[\\/]react-scripts|react-scripts[\\/]bin[\\/]react-scripts(?:\.js)?)$/i;

/** Whether argv proves this is a known development-server entrypoint. */
export function isRecognizedDevServer(argv) {
  if (!Array.isArray(argv)) return false;
  const args = argv.map((arg) => String(arg));
  const nextIndex = args.findIndex((arg) => NEXT_BIN.test(arg));
  if (nextIndex !== -1) return args.slice(nextIndex + 1).includes("dev");

  const viteIndex = args.findIndex((arg) => VITE_BIN.test(arg));
  if (viteIndex !== -1) {
    return !args
      .slice(viteIndex + 1)
      .some((arg) => ["build", "preview", "optimize"].includes(arg));
  }

  const reactIndex = args.findIndex((arg) => REACT_SCRIPTS_BIN.test(arg));
  return reactIndex !== -1 && args.slice(reactIndex + 1).includes("start");
}

const nativePlatform = {
  listProcessesByEnvironment,
  processIsAlive,
  terminateProcess,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilStopped(pids, platform, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let remaining = pids.filter((pid) => platform.processIsAlive(pid));
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    remaining = remaining.filter((pid) => platform.processIsAlive(pid));
  }
  return remaining;
}

/** Stop development servers attributable to one exact agent session. */
export async function stopSessionDevServers(
  session,
  { platform = nativePlatform, timeoutMs = 2000 } = {},
) {
  const empty = {
    matched: 0,
    signaled: 0,
    stopped: 0,
    pids: [],
    remaining: [],
  };
  if (typeof session !== "string" || !session) {
    return { ...empty, skipped: "no-session" };
  }

  const processes = await platform.listProcessesByEnvironment({
    names: SESSION_ENV_NAMES,
    value: session,
  });
  const matched = processes.filter(
    (entry) => entry.pid !== process.pid && isRecognizedDevServer(entry.argv),
  );
  const pids = [];
  for (const entry of matched) {
    if (await platform.terminateProcess(entry.pid)) pids.push(entry.pid);
  }
  const remaining = await waitUntilStopped(pids, platform, timeoutMs);
  return {
    matched: matched.length,
    signaled: pids.length,
    stopped: pids.length - remaining.length,
    pids,
    remaining,
  };
}
