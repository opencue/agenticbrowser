import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  validateLearning,
  validateLearnings,
} from "../../dist/src/learning/validate-learning-format.js";

async function makeSiteDir(root, id, manifest, files = {}) {
  const siteDir = join(root, id);
  await mkdir(join(siteDir, "notes"), { recursive: true });
  await mkdir(join(siteDir, "tools"), { recursive: true });
  await mkdir(join(siteDir, "browser-tools"), { recursive: true });
  await writeFile(join(siteDir, "manifest.json"), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(siteDir, rel), content);
  }
  return siteDir;
}

const BASE_MANIFEST = (id = "site-a") => ({
  id,
  name: "Site A",
  domains: ["example.com"],
  notes: [],
  nodeTools: {},
  browserTools: {},
});

// Finding #11: isValidDomain rejects port-qualified patterns
test("validateLearning rejects port-qualified domain", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-val-test-"));
  const siteDir = await makeSiteDir(root, "site-port", {
    ...BASE_MANIFEST("site-port"),
    domains: ["localhost:3000"],
  });
  const errors = await validateLearning(siteDir);
  assert.ok(
    errors.some((e) => e.includes("localhost:3000")),
    `Expected error about localhost:3000, got: ${JSON.stringify(errors)}`,
  );
});

test("validateLearning accepts hostname without port", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-val-test-"));
  const siteDir = await makeSiteDir(root, "site-ok", BASE_MANIFEST("site-ok"));
  const errors = await validateLearning(siteDir);
  assert.equal(errors.length, 0, `Unexpected errors: ${JSON.stringify(errors)}`);
});

// Finding #12: browser-tool source must be a bare function expression
test("validateLearning rejects browser tool with export statement", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-val-test-"));
  const siteDir = await makeSiteDir(
    root,
    "site-bt",
    {
      ...BASE_MANIFEST("site-bt"),
      browserTools: {
        my_tool: {
          description: "A tool.",
          path: "browser-tools/my-tool.js",
          args: {},
          returns: { type: "string", description: "Result." },
        },
      },
    },
    {
      "browser-tools/my-tool.js":
        "export async function myTool() { return 'hi'; }\n",
    },
  );
  const errors = await validateLearning(siteDir);
  assert.ok(
    errors.some((e) => e.includes("my_tool") && e.includes("bare function expression")),
    `Expected source-shape error, got: ${JSON.stringify(errors)}`,
  );
});

test("validateLearning accepts browser tool with bare async function", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-val-test-"));
  const siteDir = await makeSiteDir(
    root,
    "site-bt2",
    {
      ...BASE_MANIFEST("site-bt2"),
      browserTools: {
        my_tool: {
          description: "A tool.",
          path: "browser-tools/my-tool.js",
          args: {},
          returns: { type: "string", description: "Result." },
        },
      },
    },
    { "browser-tools/my-tool.js": "async function(args) { return 'hi'; }\n" },
  );
  const errors = await validateLearning(siteDir);
  assert.ok(
    !errors.some((e) => e.includes("bare function expression")),
    `Unexpected source-shape error: ${JSON.stringify(errors)}`,
  );
});

// Finding #13: unknown top-level manifest keys
test("validateLearning rejects unknown top-level keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-val-test-"));
  const siteDir = await makeSiteDir(root, "site-unk", {
    ...BASE_MANIFEST("site-unk"),
    nodeTool: {},  // typo — should be nodeTools
  });
  const errors = await validateLearning(siteDir);
  assert.ok(
    errors.some((e) => e.includes("nodeTool")),
    `Expected error about unknown key "nodeTool", got: ${JSON.stringify(errors)}`,
  );
});

// Finding #14 intra-site: redundant subdomain covered by wildcard
test("validateLearning flags redundant explicit subdomain covered by wildcard", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-val-test-"));
  const siteDir = await makeSiteDir(root, "site-red", {
    ...BASE_MANIFEST("site-red"),
    domains: ["example.com", "*.example.com", "www.example.com"],
  });
  const errors = await validateLearning(siteDir);
  assert.ok(
    errors.some((e) => e.includes("www.example.com") && e.includes("redundant")),
    `Expected redundancy error, got: ${JSON.stringify(errors)}`,
  );
});

// Finding #10: cross-site domain collision
test("validateLearnings detects cross-site domain collision", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-val-test-"));
  await makeSiteDir(root, "site-x", { ...BASE_MANIFEST("site-x"), domains: ["clash.com"] });
  await makeSiteDir(root, "site-y", { ...BASE_MANIFEST("site-y"), id: "site-y", name: "Site Y", domains: ["clash.com"] });
  const errors = await validateLearnings(root);
  assert.ok(
    errors.some((e) => e.includes("collision") && e.includes("clash.com")),
    `Expected collision error, got: ${JSON.stringify(errors)}`,
  );
});
