import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectMutations } from "../scripts/mutation-check.mjs";

test("mutation collection flips both logical operators", () => {
  const mutations = collectMutations(
    "function combine(a, b, c) { return a && b || c; }",
    [],
  );

  assert.deepEqual(
    mutations.map(({ type, mutated }) => ({ type, mutated })),
    [
      { type: "binary:||→&&", mutated: "a && b && c" },
      { type: "binary:&&→||", mutated: "a || b" },
    ],
  );
});

test("operator mutations preserve strings, comments, and nested operators", () => {
  const cases = [
    ['"===" === value', '"===" !== value'],
    ["left /* === */ === right", "left /* === */ !== right"],
    ["(left + middle) + right", "(left + middle) - right"],
  ];

  for (const [expression, expected] of cases) {
    const [mutation] = collectMutations(
      `function compare(left, middle, right, value) { return ${expression}; }`,
      [],
    );
    assert.equal(mutation.mutated, expected);
    assert.doesNotThrow(() => new Function(`return ${mutation.mutated};`));
  }
});

test("function focus excludes operations after the selected function", () => {
  const mutations = collectMutations(
    `
      function selected(a, b) { return a === b; }
      function unrelated(a, b) { return a !== b; }
      const outside = 1 + 2;
    `,
    ["selected"],
  );

  assert.deepEqual(
    mutations.map(({ original }) => original),
    ["a === b"],
  );
});

test("function focus excludes an operator after a selected function expression", () => {
  const mutations = collectMutations(
    "const holder = function selected() { return true; } === other;",
    ["selected"],
  );

  assert.deepEqual(
    mutations.map(({ type }) => type),
    ["return:true→false"],
  );
});

test("function focus includes the end of a long selected function", () => {
  const mutations = collectMutations(
    `function selected(a, b) { /* ${"padding ".repeat(400)} */ return a === b; }`,
    ["selected"],
  );

  assert.deepEqual(
    mutations.map(({ original }) => original),
    ["a === b"],
  );
});

test("function focus recognizes arrow and assigned function expressions", () => {
  for (const declaration of [
    "const selected = (a, b) => a === b;",
    "const selected = function (a, b) { return a === b; };",
    "const holder = function selected(a, b) { return a === b; };",
  ]) {
    const mutations = collectMutations(
      `${declaration} const unrelated = (a, b) => a !== b;`,
      ["selected"],
    );
    assert.deepEqual(
      mutations.map(({ original }) => original),
      ["a === b"],
    );
  }
});

test("a missing focus function does not mutate unrelated code", () => {
  assert.deepEqual(
    collectMutations("function unrelated(a) { return !a; }", ["missing"]),
    [],
  );
});

test(
  "mutation-check still runs when started through a symlink",
  { skip: process.platform === "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "mutation-check-"));
    try {
      const link = join(dir, "mutation-check.mjs");
      symlinkSync(
        fileURLToPath(
          new URL("../scripts/mutation-check.mjs", import.meta.url),
        ),
        link,
      );
      const result = spawnSync(process.execPath, [link, "no-such-module"], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No matching modules found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
