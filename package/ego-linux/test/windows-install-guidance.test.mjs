import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function read(path) {
  return readFile(join(ROOT, path), "utf8");
}

describe("native Windows installation guidance", () => {
  it("routes Windows users to PowerShell instead of WSL", async () => {
    const skill = await read("skills/ego-browser/SKILL.md");
    const install = await read("skills/ego-browser/references/install.md");

    assert.match(skill, /Linux and Windows port/i);
    assert.match(install, /Install steps \(Windows/i);
    assert.match(install, /install-windows\.ps1/);
    assert.match(install, /Do not install WSL/i);
  });

  it("ships a native checkout installer that never invokes WSL", async () => {
    const script = await read("skills/ego-browser/scripts/install-windows.ps1");

    assert.match(script, /package[\\/]ego-browser/i);
    assert.match(script, /package[\\/]ego-linux/i);
    assert.match(script, /ego-browser\.cmd/i);
    assert.doesNotMatch(script, /\bwsl(?:\.exe)?\b/i);
  });

  it("publishes the compiled Windows installer with tagged releases", async () => {
    const workflow = await read(".github/workflows/ci.yml");

    assert.match(
      workflow,
      /release:\s*[\s\S]*needs:\s*\[[^\]]*build-windows-installer/,
    );
    assert.match(workflow, /release:\s*[\s\S]*needs:\s*\[[^\]]*test-windows/);
    assert.match(workflow, /actions\/download-artifact@v4/);
    assert.match(workflow, /ego-lite-setup\.exe/);
    assert.match(workflow, /install-windows\.ps1/);
  });

  it("advertises Windows support from the repository entry point", async () => {
    const readme = await read("README.md");

    assert.match(readme, /Linux and Windows/);
    assert.match(readme, /Install on Windows/);
    assert.doesNotMatch(
      readme,
      /We do not develop, test, or ship for\s+macOS or Windows/,
    );
  });
});
