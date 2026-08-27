import { rename, rm, writeFile } from "node:fs/promises";

/**
 * Replace a file's contents in one step, so a reader never sees it half-written.
 *
 * Every heredoc is its own process and the Spaces panel is another, so the
 * files this package keeps state in have overlapping writers as a matter of
 * course. Writing in place is not atomic: a reader can open the file after
 * truncation and before the new bytes land, and get a fragment. Measured
 * against a document the size of task-spaces.json, that happened on roughly one
 * read in three while another process was writing.
 *
 * What makes it dangerous rather than merely annoying is what the readers do
 * with it. They parse JSON inside a try/catch and treat a failure as "no state
 * yet", which is indistinguishable from a fragment -- so a torn read becomes an
 * empty document, and the next write makes that permanent. Every task space
 * disappears, and the agent that created one a moment ago is told it does not
 * exist.
 *
 * A rename cannot be observed half-done, so a reader gets either the previous
 * document or the new one. This does not serialise two writers -- a concurrent
 * read-modify-write can still lose an update, which needs a lock -- but it does
 * stop one process's write turning another's read into data loss.
 */

/** Distinguishes concurrent writes from within one process. */
let sequence = 0;

/** How long Windows is given to let go of a file another process is reading. */
const RETRY_LIMIT = 10;
const RETRY_DELAY_MS = 20;

/**
 * @param {string} path The file to replace.
 * @param {string} contents What it should hold.
 * @param {import("node:fs").WriteFileOptions} [options] Scratch-file options.
 */
export async function replaceFile(path, contents, options) {
  // Unique per process and per call: two writes from this process must not
  // land on the same scratch file, and neither must two processes.
  sequence += 1;
  const scratch = `${path}.${process.pid}.${sequence}.tmp`;
  await writeFile(scratch, contents, options);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(scratch, path);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process holds open, which a
      // reader does for a moment. POSIX has no such rule and never lands here.
      const transient = error?.code === "EPERM" || error?.code === "EBUSY";
      if (!transient || attempt >= RETRY_LIMIT) {
        // Leaving the scratch file behind would litter the state directory with
        // one more copy on every failure.
        await rm(scratch, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}
