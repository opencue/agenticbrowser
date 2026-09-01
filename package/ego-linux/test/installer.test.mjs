import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stage } from "../installer/stage.mjs";

/**
 * What the Windows installer ships, checked without Windows.
 *
 * `iscc` only runs on Windows, so the compile itself belongs in CI. What does
 * not need Windows — and is where this actually goes wrong — is the payload:
 * a renamed or moved file still compiles into a perfectly valid installer that
 * fails on the user's machine, with nothing between the rename and that user.
 *
 * So this stages for real and then reads `ego-lite.iss` back, checking every
 * path it points at against what was staged.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ISS = join(HERE, "..", "installer", "ego-lite.iss");

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-installer-"));
after(() => rm(SANDBOX, { recursive: true, force: true }));

const NODE_STUB = join(SANDBOX, "node.exe");
await writeFile(NODE_STUB, "not really node, but a file that exists");

const staged = await stage({
  out: join(SANDBOX, "payload"),
  nodeExe: NODE_STUB,
});
const iss = await readFile(ISS, "utf8");

/** Resolve the .iss preprocessor defines, so `{#IconPath}` reads as a path. */
function expandDefines(text) {
  const defines = new Map();
  for (const [, name, value] of text.matchAll(
    /^#define\s+(\w+)\s+"([^"]*)"/gm,
  )) {
    defines.set(name, value);
  }
  return text.replace(/\{#(\w+)\}/g, (whole, name) =>
    defines.has(name) ? defines.get(name) : whole,
  );
}

/** Every `{app}`-relative path the script points at, as staged-payload paths. */
function appPaths(text) {
  const found = new Set();
  for (const [, path] of expandDefines(text).matchAll(
    /\{app\}\\([^"';\s]+)/g,
  )) {
    found.add(path.replaceAll("\\", "/"));
  }
  return [...found];
}

describe("the installer payload", () => {
  it("ships the CLI, the port's modules and the harness the port runs", () => {
    for (const required of [
      "ego-browser.cmd",
      "ego-browser-mcp.cmd",
      "package/ego-linux/bin/ego-browser.mjs",
      "package/ego-linux/bin/ego-browser-mcp.mjs",
      "package/ego-linux/src/mcp-server.mjs",
      "package/ego-linux/src/platform.mjs",
      "package/ego-linux/package.json",
      "package/ego-linux/package-lock.json",
      "package/ego-linux/node_modules/@modelcontextprotocol/server/package.json",
      "package/ego-linux/node_modules/@modelcontextprotocol/core/package.json",
      "package/ego-linux/node_modules/zod/package.json",
      "package/ego-linux/assets/ego-lite.ico",
      "package/ego-browser/dist/out/index.js",
    ]) {
      assert.ok(
        staged.files.includes(required),
        `${required} is not in the payload`,
      );
    }
  });

  it("keeps the harness where the CLI looks for it", () => {
    // Resolved exactly as bin/ego-browser.mjs does it, against the real staged
    // tree — not against an idea of the layout. If the staging stopped
    // mirroring the monorepo, every install would fail on first use with
    // ERR_MODULE_NOT_FOUND, and this is the only thing between that and a user.
    const cli = pathToFileURL(
      join(staged.payload, "package", "ego-linux", "bin", "ego-browser.mjs"),
    );
    const harness = new URL("../../ego-browser/dist/out/index.js", cli);
    assert.ok(
      existsSync(fileURLToPath(harness)),
      `the CLI would look for the harness at ${fileURLToPath(harness)}, which the payload does not have`,
    );
  });

  it("ships the skill package the runtime reads its learnings from", () => {
    assert.ok(
      staged.files.some((f) =>
        f.startsWith("package/ego-browser/dist/out/ego-browser/"),
      ),
      "the skill directory beside the bundle is missing",
    );
  });

  it("puts the bundled runtime where the shim looks for it", () => {
    assert.ok(staged.files.includes("node/node.exe"));
  });

  it("refuses to stage a payload with a missing piece", async () => {
    await assert.rejects(
      () =>
        stage({
          out: join(SANDBOX, "bad"),
          nodeExe: join(SANDBOX, "nope.exe"),
        }),
      /--node points at nothing/,
    );
  });
});

describe("the PATH shim", () => {
  it("runs the CLI through the bundled runtime, relative to itself", async () => {
    const shim = await readFile(
      join(staged.payload, "ego-browser.cmd"),
      "utf8",
    );
    // %~dp0 ends with a separator and is what makes the install relocatable.
    assert.match(shim, /"%~dp0node\\node\.exe"/);
    assert.match(shim, /"%~dp0package\\ego-linux\\bin\\ego-browser\.mjs"/);
    assert.match(shim, /%\*/, "arguments have to reach the CLI");
  });

  it("runs the MCP server through the bundled runtime and shipped dependencies", async () => {
    const shim = await readFile(
      join(staged.payload, "ego-browser-mcp.cmd"),
      "utf8",
    );
    assert.match(shim, /"%~dp0node\\node\.exe"/);
    assert.match(shim, /"%~dp0package\\ego-linux\\bin\\ego-browser-mcp\.mjs"/);
    assert.ok(
      !staged.files.includes(
        "package/ego-linux/node_modules/@modelcontextprotocol/client/package.json",
      ),
    );
  });

  it("is CRLF, which is what cmd.exe requires", async () => {
    const shim = await readFile(
      join(staged.payload, "ego-browser.cmd"),
      "utf8",
    );
    assert.ok(shim.includes("\r\n"), "LF-only .cmd files misparse on Windows");
    assert.ok(!/[^\r]\n/.test(shim), "every line ending has to be CRLF");
  });
});

describe("ego-lite.iss", () => {
  it("points every {app} path at something the payload actually contains", () => {
    const referenced = appPaths(iss);
    // Without this the check passes by finding nothing, which is the failure
    // mode a regex over a config file always eventually has.
    assert.ok(
      referenced.length >= 2,
      `expected the script to reference {app} paths, found ${referenced.length}`,
    );
    const missing = referenced.filter((path) => !staged.files.includes(path));
    assert.deepEqual(
      missing,
      [],
      `the installer references files that were never staged: ${missing.join(", ")}`,
    );
  });

  it("installs per user, so no administrator and no UAC prompt", () => {
    assert.match(iss, /^PrivilegesRequired=lowest$/m);
    assert.match(iss, /^DefaultDirName=\{localappdata\}/m);
  });

  it("announces the PATH change, or a new shell would not see it", () => {
    assert.match(iss, /^ChangesEnvironment=yes$/m);
    assert.match(iss, /ValueName: "Path"/);
    // And takes it back out again, or the entries accumulate.
    assert.match(iss, /procedure CurUninstallStepChanged/);
    assert.match(iss, /RemoveFromPath/);
  });

  it("keeps a stable AppId, because a new one breaks every upgrade", () => {
    assert.match(
      iss,
      /^AppId=\{\{A69F19E2-57DD-498D-820E-7E481F9F3380\}$/m,
      "changing this makes an upgrade install a second copy alongside the first",
    );
  });

  it("uses the icon that scripts/make-icon.mjs builds", () => {
    assert.match(iss, /^SetupIconFile=\.\.\\assets\\ego-lite\.ico$/m);
    assert.ok(
      appPaths(iss).includes("package/ego-linux/assets/ego-lite.ico"),
      "the shortcuts and the uninstaller entry all draw this",
    );
  });

  it("keeps the [Code] section free of brace comments", () => {
    // A Pascal block comment does not nest, so `{ ... {app} ... }` ends at the
    // closing brace of {app} and the rest of the sentence is compiled as code.
    // That is a compile error only ISCC can report, and ISCC only runs on
    // Windows -- so the rule is checked here instead: line comments in [Code].
    const code = iss.split("[Code]")[1] ?? "";
    assert.ok(
      code.includes("function NeedsAddPath"),
      "found no [Code] section",
    );
    const braceComments = code
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.trimStart().startsWith("{"));
    assert.deepEqual(
      braceComments.map((c) => c.line.trim()),
      [],
      "use // comments in [Code]; a { } comment ends at the first } it meets",
    );
  });

  it("only launches flags the CLI actually has", () => {
    // An installer whose finish-page checkbox errors out is a bad first minute.
    const supported = new Set([
      "--help",
      "--doctor",
      "--status",
      "--stop",
      "--import-chrome-profile",
      "--prune-spaces",
      "--spaces",
      "--spaces-daemon",
      "--install-desktop-entry",
      "--open",
    ]);
    const used = [...iss.matchAll(/Parameters: "(--[\w-]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(used.length > 0, "expected the shortcuts to pass a flag");
    for (const flag of used) {
      assert.ok(
        supported.has(flag),
        `${flag} is not a flag bin/ego-browser.mjs handles`,
      );
    }
  });
});
