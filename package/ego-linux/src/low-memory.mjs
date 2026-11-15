// The procfs read lives in platform.mjs; re-exported so callers keep one import.
export { availableMemoryMb } from "./platform.mjs";

/** Below this much available memory a visible browser is not worth its cost. */
export const DEFAULT_LOW_MEMORY_MB = 4096;

/**
 * Flags for a browser launched under memory pressure. They cap what the
 * browser may take rather than change what a page can do: fewer renderer
 * processes, and no extensions from the profile.
 */
export const LOW_MEMORY_FLAGS = [
  "--renderer-process-limit=2",
  "--disable-extensions",
];

/**
 * True when the machine is short enough on memory that the browser should
 * start headless and trimmed. EGO_LINUX_LOW_MEMORY_MB moves the threshold;
 * 0 turns the check off.
 */
export function isLowMemory(availableMb, env = process.env) {
  if (availableMb === null) return false;
  const raw = (env.EGO_LINUX_LOW_MEMORY_MB ?? "").trim();
  const threshold = raw === "" ? DEFAULT_LOW_MEMORY_MB : Number(raw);
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  return availableMb < threshold;
}
