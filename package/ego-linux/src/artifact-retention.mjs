import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_ARTIFACT_TTL_HOURS = 24;

const ARTIFACTS = [
  {
    kind: "file",
    pattern: /^ego-browser-shot-\d+-\d+-\d+\.png$/,
  },
  {
    kind: "file",
    pattern: /^ego-browser-failure-\d+-\d+-\d+\.json$/,
  },
  {
    kind: "directory",
    pattern: /^ego-browser-downloads-\d+-\d+-[a-f0-9]+$/,
  },
];

/** Resolve the configured lifetime. Zero disables automatic cleanup. */
export function artifactTtlMs(env = process.env) {
  const raw = env.EGO_BROWSER_ARTIFACT_TTL_HOURS;
  if (raw === undefined || raw === "") {
    return DEFAULT_ARTIFACT_TTL_HOURS * HOUR_MS;
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    return DEFAULT_ARTIFACT_TTL_HOURS * HOUR_MS;
  }
  return hours * HOUR_MS;
}

function artifactKind(entry) {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return null;
}

function isManagedArtifact(entry) {
  const kind = artifactKind(entry);
  return ARTIFACTS.some(
    (artifact) =>
      artifact.kind === kind && artifact.pattern.test(String(entry.name)),
  );
}

/** Delete only expired Ego-generated artifacts in the OS temp directory. */
export async function cleanupExpiredArtifacts({
  directory = tmpdir(),
  env = process.env,
  now = Date.now(),
} = {}) {
  const ttlMs = artifactTtlMs(env);
  if (ttlMs === 0) return { deleted: 0, disabled: true };

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { deleted: 0 };
  }

  const cutoff = now - ttlMs;
  let deleted = 0;
  for (const entry of entries) {
    if (!isManagedArtifact(entry)) continue;
    const path = join(directory, entry.name);
    try {
      const stats = await lstat(path);
      if (stats.mtimeMs > cutoff) continue;
      await rm(path, {
        recursive: entry.isDirectory(),
        force: true,
        maxRetries: 2,
        retryDelay: 20,
      });
      deleted += 1;
    } catch {
      // Cleanup is maintenance. A locked or concurrently removed artifact must
      // never block browser work.
    }
  }
  return { deleted };
}
