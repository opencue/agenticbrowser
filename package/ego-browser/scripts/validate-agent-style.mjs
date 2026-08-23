import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

const paths = [
  join(repoRoot, "AGENTS.md"),
  join(repoRoot, "README.md"),
  join(packageRoot, "README.md"),
  join(repoRoot, "package/ego-linux/README.md"),
  join(repoRoot, "package/ego-windows-host/README.md"),
  join(repoRoot, "skills/ego-browser/SKILL.md"),
  join(repoRoot, "skills/ego-browser/references/install.md"),
  join(repoRoot, "skills/ego-browser/references/task-spaces.md"),
  ...listFiles(join(repoRoot, "skills/ego-browser/learnings"), ".md"),
  ...listFiles(join(packageRoot, "scripts/real-browser-e2e/cases"), ".mjs"),
];

const legacyOneRoundTaskSpacePatterns = [
  {
    pattern: /const task = await taskSpaces\.useOrCreate\('inspect example page'\)/,
    message: "quick start should use taskSpaces.run(...) for one-round tasks",
  },
  {
    pattern: /const task = await taskSpaces\.useOrCreate\('research task'\)/,
    message: "one-round task example should use taskSpaces.run(...)",
  },
  {
    pattern: /await taskSpaces\.useOrCreate\('demo'\)/,
    message: "demo quick start should use taskSpaces.run(...)",
  },
  {
    pattern: /start from `taskSpaces\.useOrCreate\(name\)`/,
    message: "install docs should prefer taskSpaces.run(...) after setup",
  },
  {
    pattern:
      /Reuse or create a task space: `const task = await taskSpaces\.useOrCreate\(name\)`/,
    message:
      "semantic workflow should mention taskSpaces.run(...) for one-round tasks",
  },
  {
    pattern:
      /Always call `taskSpaces\.complete\(name, \{ keep \}\)` when the task is done — do not leave the space hanging\./,
    message:
      "cleanup guidance should mention taskSpaces.run(...) automatic completion",
  },
];

const legacyFlatHelperCalls = [
  { name: "load", replacement: "page.goto(...)" },
  { name: "snapshot", replacement: "page.snapshot()" },
  { name: "goto", replacement: "page.goto(...)" },
  { name: "navigate", replacement: "page.goto(...)" },
  { name: "waitForLoad", replacement: "page.waitForLoadState(...)" },
  { name: "currentUrl", replacement: "page.url()" },
  { name: "js", replacement: "page.evaluate(...)" },
];

const failures = [];

for (const file of paths) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  const rel = relative(repoRoot, file);
  const lines = content.split(/\r?\n/);

  if (
    rel === "skills/ego-browser/SKILL.md" &&
    !content.includes("await taskSpaces.run('inspect example page'")
  ) {
    failures.push(
      `${rel}: quick start must teach taskSpaces.run(...) as the one-round default`,
    );
  }

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    if (line.includes("agent-style-ok")) continue;

    if (
      /\bpage\.mouse\.click\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?/.test(line)
    ) {
      failures.push(
        `${rel}:${lineNo} avoid fixed coordinate page.mouse.click; prefer locator clicks`,
      );
    }

    const waitMatch = /\bpage\.waitForTimeout\(\s*(\d+)/.exec(line);
    if (waitMatch && Number(waitMatch[1]) >= 1000) {
      failures.push(
        `${rel}:${lineNo} avoid long fixed page.waitForTimeout; prefer locator/page waits`,
      );
    }

    if (/\bpage\.locator\(\s*["']text=/.test(line) && !/compat/i.test(line)) {
      failures.push(
        `${rel}:${lineNo} prefer page.getByText(...) over page.locator("text=...")`,
      );
    }

    for (const { name, replacement } of legacyFlatHelperCalls) {
      const call = `${name}\\(`;
      const directCall = new RegExp(`^\\s*(?:await\\s+)?${call}`);
      const assignedCall = new RegExp(
        `^\\s*(?:(?:const|let|var)\\s+\\w+\\s*=\\s*)?(?:await\\s+)?${call}`,
      );
      if (
        (directCall.test(line) || assignedCall.test(line)) &&
        !/agent-style-ok|removed/i.test(line)
      ) {
        failures.push(
          `${rel}:${lineNo} use ${replacement} instead of removed flat ${name}(...)`,
        );
      }
    }

    for (const { pattern, message } of legacyOneRoundTaskSpacePatterns) {
      if (pattern.test(line)) {
        failures.push(`${rel}:${lineNo} ${message}`);
      }
    }
  }

  if (
    (rel.endsWith(".md") || rel.endsWith("README.md")) &&
    /page\.evaluate\(String\.raw/.test(content) &&
    /document\.querySelectorAll/.test(content)
  ) {
    failures.push(
      `${rel}: prefer locator.extractAll/evaluateAll over page.evaluate(String.raw + querySelectorAll) in agent-facing docs`,
    );
  }
}

if (failures.length) {
  console.error("Agent style validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Agent style validation passed (${paths.length} files).`);

function listFiles(root, extension) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(fullPath, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      result.push(fullPath);
    }
  }
  return result;
}
