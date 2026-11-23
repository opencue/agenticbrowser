// Fail when there is nothing to test. `node --test` with a glob that matches no
// file exits 0, so a test directory that never reached the repository (it was
// once ignored by .gitignore) made CI report a green suite that ran nothing.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test");
let count = 0;
try {
  count = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).length;
} catch {
  count = 0;
}
if (count === 0) {
  console.error(
    `no test files in ${dir}; refusing to report an empty suite as passing`,
  );
  process.exit(1);
}
console.log(`${count} test files`);
