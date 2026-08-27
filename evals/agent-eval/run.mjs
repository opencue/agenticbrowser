#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseArgs, runEvaluation, usage } from "./harness.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exitCode = 0;
  } else {
    const report = await runEvaluation(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    process.stdout.write(output);
    if (options.output) {
      const outputPath = resolve(options.output);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, output);
      process.stderr.write(`Report written to ${outputPath}\n`);
    }
    if (!report.dry && report.summary.failed > 0) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n\n${usage()}`,
  );
  process.exitCode = 2;
}
