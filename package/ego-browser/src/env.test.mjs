import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { agentWorkspace, resolvePath } from "../dist/src/env.js";

test("resolvePath expands the current user's home without dropping it", () => {
  const configuredHome = process.env.HOME || process.env.USERPROFILE || ".";
  assert.equal(resolvePath("~"), resolve(configuredHome));
  assert.equal(
    resolvePath("~/skills/ego-browser"),
    resolve(configuredHome, "skills/ego-browser"),
  );
  assert.equal(resolvePath("~//skills"), resolve(configuredHome, "skills"));
});

test("resolvePath preserves ordinary absolute and relative paths", () => {
  for (const path of [
    "/tmp/ego-skills",
    "skills/ego-browser",
    "~another-user",
  ]) {
    assert.equal(resolvePath(path), resolve(path));
  }
});

test("agentWorkspace expands a tilde-relative workspace override", (t) => {
  const previous = process.env.EGO_BROWSER_AGENT_WORKSPACE;
  t.after(() => {
    if (previous === undefined) delete process.env.EGO_BROWSER_AGENT_WORKSPACE;
    else process.env.EGO_BROWSER_AGENT_WORKSPACE = previous;
  });
  process.env.EGO_BROWSER_AGENT_WORKSPACE = "~/agent-skills";
  assert.equal(
    agentWorkspace(),
    resolve(process.env.HOME || process.env.USERPROFILE || ".", "agent-skills"),
  );
});
