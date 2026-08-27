import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentIdentity, agentName } from "../src/agent-identity.mjs";

const MARKER = "/.config/cue/runtime/";

/**
 * Run a case against a controlled environment.
 *
 * agentIdentity reads the ambient environment, and this suite runs inside
 * exactly the kind of session it is built to detect — on a cue-managed machine
 * the real profile would leak into every assertion. So each case starts from an
 * environment with the marker, the session id and the panel flag stripped out.
 */
function withEnv(overrides, run) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.includes(MARKER))
      delete process.env[key];
  }
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.OMX_SESSION_ID;
  delete process.env.EGO_BROWSER_SESSION_ID;
  delete process.env.EGO_LINUX_PANEL;
  delete process.env.EGO_LINUX_CURSOR_NAME;
  Object.assign(process.env, overrides);
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe("agent identity", () => {
  it("names the cue profile that launched the session", () => {
    const identity = withEnv(
      { CLAUDE_CONFIG_DIR: "/home/someone/.config/cue/runtime/coolify/claude" },
      () => agentIdentity("/tmp"),
    );
    assert.equal(identity.profile, "coolify");
  });

  it("falls back to a .cue.profile pin, walking up from the working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-identity-"));
    const nested = join(root, "project", "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".cue.profile"), "medusa\n");

    const identity = withEnv({}, () => agentIdentity(nested));
    assert.equal(identity.profile, "medusa");

    await rm(root, { recursive: true, force: true });
  });

  it("prefers the launching profile over a pin file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-identity-"));
    await writeFile(join(root, ".cue.profile"), "pinned\n");

    const identity = withEnv(
      { CLAUDE_CONFIG_DIR: "/home/someone/.config/cue/runtime/coolify/claude" },
      () => agentIdentity(root),
    );
    assert.equal(
      identity.profile,
      "coolify",
      "the live session wins over a directory default",
    );

    await rm(root, { recursive: true, force: true });
  });

  it("claims nothing for the panel's own daemon", () => {
    // The daemon inherits whichever session started it, but a space created by
    // hand from the panel is the user's — attributing it would be a lie.
    const identity = withEnv(
      {
        EGO_LINUX_PANEL: "1",
        CLAUDE_CONFIG_DIR: "/home/someone/.config/cue/runtime/coolify/claude",
        CLAUDE_CODE_SESSION_ID: "dae81a3c-1f45-417f",
      },
      () => agentIdentity("/tmp"),
    );
    assert.deepEqual(identity, { profile: null, session: null });
  });

  it("keeps the full session id for collision-free ownership", () => {
    const identity = withEnv(
      { CLAUDE_CODE_SESSION_ID: "dae81a3c-1f45-417f-9f27-759398198057" },
      () => agentIdentity("/tmp"),
    );
    assert.equal(identity.session, "dae81a3c-1f45-417f-9f27-759398198057");
  });

  it("recognizes a Codex session instead of grouping every Codex agent together", () => {
    const identity = withEnv(
      { CODEX_SESSION_ID: "01a01e09-7f65-7b51-8fa3-0e765501e39b" },
      () => agentIdentity("/tmp"),
    );
    assert.equal(identity.session, "01a01e09-7f65-7b51-8fa3-0e765501e39b");
  });

  it("reports nothing rather than guessing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ego-identity-"));
    const identity = withEnv({}, () => agentIdentity(root));
    assert.deepEqual(identity, { profile: null, session: null });
    await rm(root, { recursive: true, force: true });
  });
});

describe("agent name", () => {
  const ancestry =
    (...names) =>
    () =>
      names;

  it("names codex when codex ran the heredoc", () => {
    const name = withEnv({}, () =>
      agentName({ ancestry: ancestry("node", "bash", "codex") }),
    );
    assert.equal(name, "Codex");
  });

  it("names claude when claude ran the heredoc", () => {
    const name = withEnv({}, () =>
      agentName({ ancestry: ancestry("node", "bash", "claude") }),
    );
    assert.equal(name, "Claude");
  });

  it("credits the nearest harness, not the one that spawned it", () => {
    // One agent delegating to another (acpx, a codex subagent) leaves both in
    // the ancestry. The one actually driving the browser is the closer one.
    const name = withEnv({}, () =>
      agentName({
        ancestry: ancestry("node", "bash", "codex", "bash", "claude"),
      }),
    );
    assert.equal(name, "Codex");
  });

  it("lets the environment override the detected name", () => {
    const name = withEnv({ EGO_LINUX_CURSOR_NAME: "Reviewer" }, () =>
      agentName({ ancestry: ancestry("node", "bash", "claude") }),
    );
    assert.equal(name, "Reviewer");
  });

  it("says Agent rather than naming the wrong one", () => {
    // The old default was "Claude", so every harness drew a Claude badge. An
    // unrecognised one is anonymous, not misattributed.
    const name = withEnv({}, () =>
      agentName({ ancestry: ancestry("node", "bash", "fish") }),
    );
    assert.equal(name, "Agent");
  });

  it("survives a machine with no readable process ancestry", () => {
    const name = withEnv({}, () =>
      agentName({
        ancestry: () => {
          throw new Error("no /proc here");
        },
      }),
    );
    assert.equal(name, "Agent");
  });

  it("reads the real ancestry when nothing is injected", () => {
    // The suite itself runs under a harness, so the value depends on who ran
    // it — but it must be a name, and reading /proc must not throw.
    const name = withEnv({}, () => agentName());
    assert.equal(typeof name, "string");
    assert.ok(name.length > 0);
  });
});
