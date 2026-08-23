// One half of the concurrency check in test/state-write.test.mjs.
//
// A separate process on purpose: the failure only exists between processes, so
// two async loops in one would prove nothing. It has to be a script file rather
// than `node -e`, because node reads what follows -e as its own options.
import { readFile } from "node:fs/promises";

import { replaceFile } from "../../src/atomic-write.mjs";

const [role, file, iterations] = process.argv.slice(2);
const rounds = Number(iterations);

/** About the size task-spaces.json reaches with a handful of spaces open. */
const document = (n) =>
  JSON.stringify(
    {
      selectedId: n,
      spaces: Array.from({ length: 8 }, (_, i) => ({
        id: i,
        name: `space ${i} ${"x".repeat(200)}`,
        targetIds: [`TARGET${i}${n}`.padEnd(32, "0")],
        owner: "agent",
      })),
    },
    null,
    2,
  );

if (role === "writer") {
  for (let i = 0; i < rounds; i += 1) await replaceFile(file, document(i));
} else if (role === "reader") {
  let torn = 0;
  for (let i = 0; i < rounds; i += 1) {
    try {
      JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      // ENOENT is the file not existing yet, which is not a torn read. Anything
      // else here is a fragment -- and readState()'s own catch cannot tell the
      // two apart either, which is exactly why this matters.
      if (error?.code !== "ENOENT") torn += 1;
    }
  }
  process.stdout.write(String(torn));
} else {
  throw new Error(`unknown role: ${role}`);
}
