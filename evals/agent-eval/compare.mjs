#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { compareReports } from "./harness.mjs";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  process.stderr.write(
    "Usage: node evals/agent-eval/compare.mjs <baseline.json> <candidate.json>\n",
  );
  process.exitCode = 2;
} else {
  try {
    const [baseline, candidate] = await Promise.all([
      readReport(baselinePath),
      readReport(candidatePath),
    ]);
    process.stdout.write(
      `${JSON.stringify(compareReports(baseline, candidate), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function readReport(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
