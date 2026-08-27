import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
let cachedBuildId = null;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(path);
  }
  return files;
}

/**
 * Identify the exact Linux runtime source loaded by a Spaces daemon.
 *
 * Package versions do not change during local development, so a version string
 * cannot detect a daemon that outlived an edit. Hashing the executable sources
 * once at process startup gives old and new processes stable, comparable ids.
 */
export function runtimeBuildId() {
  if (!cachedBuildId) {
    cachedBuildId = (async () => {
      const files = [
        join(PACKAGE_ROOT, "package.json"),
        ...(await sourceFiles(join(PACKAGE_ROOT, "bin"))),
        ...(await sourceFiles(join(PACKAGE_ROOT, "src"))),
      ].sort();
      const hash = createHash("sha256");
      for (const file of files) {
        hash.update(relative(PACKAGE_ROOT, file));
        hash.update("\0");
        hash.update(await readFile(file));
        hash.update("\0");
      }
      return hash.digest("hex").slice(0, 16);
    })();
  }
  return cachedBuildId;
}
