import { chmod, mkdir, writeFile } from "node:fs/promises";

import { STATE_DIR } from "./paths.mjs";

/** Keep runtime control state private even when the caller's umask is permissive. */
export async function ensurePrivateStateDir() {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATE_DIR, 0o700);
}

/** Write a state file that can contain browser-control or task metadata. */
export async function writePrivateStateFile(path, contents, options = {}) {
  await ensurePrivateStateDir();
  await writeFile(path, contents, { ...options, mode: 0o600 });
  await chmod(path, 0o600);
}

/** Tighten a renamed state file without rewriting its contents. */
export async function securePrivateStateFile(path) {
  await ensurePrivateStateDir();
  await chmod(path, 0o600);
}
