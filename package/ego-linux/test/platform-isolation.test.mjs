import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The guard that keeps the port from rotting.
 *
 * Windows support is not a one-off translation — it holds only for as long as
 * platform-specific calls stay behind `src/platform.mjs`. A `/proc` read or a
 * SIGTERM added anywhere else still passes every other test on Linux and
 * silently breaks Windows, and nobody would notice until someone ran it there.
 *
 * So this fails the build the moment one reappears, and says what to use
 * instead. It reads the source rather than the behaviour on purpose: the whole
 * point is to catch code that this machine can happily run.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_MODULE = "src/platform.mjs";

/**
 * Each rule is a pattern that must not appear, and the platform.mjs export that
 * replaces it. The message is the whole value of this test — a bare "pattern
 * found" would send the next person hunting.
 */
const RULES = [
  {
    pattern: /\/proc\b/,
    why: "reads procfs, which does not exist on Windows",
    instead: "listProcesses() / processArgv() / processAncestry()",
  },
  {
    pattern: /process\.env\.XDG_/,
    why: "XDG variables are a Linux convention",
    instead: "dataRoot() / stateRoot()",
  },
  {
    pattern: /process\.env\.(LOCALAPPDATA|APPDATA|PROGRAMFILES)/i,
    why: "a Windows environment variable belongs with the other platform facts",
    instead: "dataRoot() / stateRoot() / startMenuProgramsDir()",
  },
  {
    pattern: /process\.kill\s*\(/,
    why: "POSIX signals do not reach a Windows GUI process by pid",
    instead: "terminateProcess() to stop one, processIsAlive() to test one",
  },
  {
    pattern: /spawn\(\s*["']which["']/,
    why: "`which` is not a Windows command",
    instead: "resolveBrowserBinary()",
  },
  {
    pattern: /where\.exe|taskkill|powershell\.exe/i,
    why: "a Windows-only command has no POSIX counterpart here",
    instead: "the platform.mjs helper that wraps it",
  },
  {
    pattern: /Singleton(Lock|Socket|Cookie)/,
    why: "Chrome's profile guard is files on POSIX and kernel objects on Windows",
    instead: "readSingletonOwner() / clearSingletonArtifacts()",
  },
  {
    pattern: /["']\.local["']|["']AppData["']/,
    why: "a per-user directory layout differs between platforms",
    instead: "dataRoot() / stateRoot()",
  },
  {
    pattern: /process\.platform/,
    why: "branching on the platform outside one module is how a port drifts",
    instead: "IS_WINDOWS from platform.mjs, or a new platform.mjs helper",
  },
];

/** Every .mjs under src/ and bin/, as repo-relative paths. */
async function sourceFiles() {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(join(ROOT, dir), {
      withFileTypes: true,
    })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".mjs")) found.push(path);
    }
  }
  await walk("src");
  await walk("bin");
  return found;
}

/**
 * Comments explain platform differences and must stay free to name them, so a
 * line is only evidence if it is code. This is deliberately crude — it drops
 * whole-line comments and JSDoc, which is every comment in this package.
 */
function codeLines(source) {
  return source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return (
        trimmed &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("/*")
      );
    });
}

describe("platform isolation", () => {
  it("keeps every platform-specific call inside platform.mjs", async () => {
    const files = await sourceFiles();
    assert.ok(
      files.length > 5,
      `expected a source tree, found ${files.length}`,
    );

    const violations = [];
    for (const file of files) {
      if (file === PLATFORM_MODULE) continue;
      const source = await readFile(join(ROOT, file), "utf8");
      for (const { line, number } of codeLines(source)) {
        for (const rule of RULES) {
          if (rule.pattern.test(line)) {
            violations.push(
              `${file}:${number} ${rule.why}\n` +
                `    ${line.trim()}\n` +
                `    use ${rule.instead} from ${PLATFORM_MODULE} instead`,
            );
          }
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `platform-specific code outside ${PLATFORM_MODULE}:\n\n${violations.join("\n\n")}\n`,
    );
  });

  it("checks the files it claims to, including the ones that were ported", async () => {
    // A walk that silently found nothing would make the rule above vacuous.
    const files = await sourceFiles();
    // The files the port actually rewired. A module added later is covered by
    // the walk regardless — this list only guards against the walk itself
    // silently finding nothing.
    for (const expected of [
      "src/chrome.mjs",
      "src/paths.mjs",
      "src/agent-identity.mjs",
      "src/desktop.mjs",
      "bin/ego-browser.mjs",
    ]) {
      assert.ok(files.includes(expected), `${expected} is not being scanned`);
    }
  });

  it("keeps the suites off a hardcoded app directory name", async () => {
    // The directory is ego-lite-linux on Linux and ego-lite on Windows. A test
    // that spells it out builds a path to a state file that does not exist on
    // the other platform, reads nothing, and carries on -- which is how three
    // teardowns came to kill no browser at all on Windows, leaving the profile
    // locked and the suite hanging until it timed out.
    const { readdir } = await import("node:fs/promises");
    const violations = [];
    for (const entry of await readdir(join(ROOT, "test"))) {
      if (!entry.endsWith(".mjs")) continue;
      // platform.test.mjs asserts the constant's value, which is the point of
      // it, and this file has to name the literal to be able to look for it.
      if (entry === "platform.test.mjs") continue;
      if (entry === "platform-isolation.test.mjs") continue;
      const source = await readFile(join(ROOT, "test", entry), "utf8");
      for (const { line, number } of codeLines(source)) {
        if (line.includes('"ego-lite-linux"')) {
          violations.push(`test/${entry}:${number} ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `use APP_DIR from ${PLATFORM_MODULE} instead:\n${violations.join("\n")}`,
    );
  });

  it("would actually catch a regression", async () => {
    // Proves the rules match real code and not just their own description.
    const regressions = [
      'const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");',
      "const home = process.env.XDG_DATA_HOME;",
      'process.kill(pid, "SIGTERM");',
      'spawn("which", [name]);',
      'const lock = join(dir, "SingletonLock");',
      'if (process.platform === "win32") return;',
    ];
    for (const line of regressions) {
      assert.ok(
        RULES.some((rule) => rule.pattern.test(line)),
        `no rule catches: ${line}`,
      );
    }
  });

  it("leaves comments and ordinary code alone", async () => {
    const allowed = [
      " * A harness that points EGO_LINUX_PROFILE (or XDG_DATA_HOME) at a scratch tree",
      "// SingletonLock is a symlink on POSIX",
      "return a.localeCompare(b);",
      "const running = await liveSpacesServer();",
    ];
    for (const line of allowed) {
      const isComment = codeLines(line).length === 0;
      const flagged = RULES.some((rule) => rule.pattern.test(line));
      assert.ok(isComment || !flagged, `false positive on: ${line}`);
    }
  });
});
