import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { selectedCases } from "./cases.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");
export const DEFAULT_SKILL = join(REPO_ROOT, "skills/ego-browser/SKILL.md");

export function parseArgs(argv) {
  const options = {
    caseIds: [],
    codex: process.env.EGO_AGENT_EVAL_CODEX || "codex",
    dry: false,
    label: "baseline",
    model: process.env.EGO_AGENT_EVAL_MODEL || null,
    output: null,
    runs: 1,
    skill: DEFAULT_SKILL,
    timeoutMs: 300_000,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry") options.dry = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--case") {
      options.caseIds.push(...nextValue(argv, ++index, arg).split(","));
    } else if (arg === "--codex") options.codex = nextValue(argv, ++index, arg);
    else if (arg === "--label") options.label = nextValue(argv, ++index, arg);
    else if (arg === "--model") options.model = nextValue(argv, ++index, arg);
    else if (arg === "--output") options.output = nextValue(argv, ++index, arg);
    else if (arg === "--runs") {
      options.runs = positiveInteger(nextValue(argv, ++index, arg), arg);
    } else if (arg === "--skill") options.skill = nextValue(argv, ++index, arg);
    else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInteger(nextValue(argv, ++index, arg), arg);
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  options.caseIds = options.caseIds.filter(Boolean);
  return options;
}

export function usage() {
  return `Usage: node evals/agent-eval/run.mjs [options]

Options:
  --dry                 Preview cases and cost shape without launching Codex
  --case <id[,id]>      Run only selected cases (repeatable)
  --runs <n>            Independent Codex sessions per case (default: 1)
  --label <name>        Result label, e.g. baseline or candidate
  --skill <path>        SKILL.md to inject (default: skills/ego-browser/SKILL.md)
  --model <model>       Pin the same Codex model for comparable A/B runs
  --timeout-ms <ms>     Per-session timeout (default: 300000)
  --output <path>       Also write the JSON report to this path
  --verbose             Echo Codex JSONL and stderr while running
  --help                Show this help
`;
}

export async function runEvaluation(options) {
  const cases = selectedCases(options.caseIds);
  const skillText = await readFile(resolve(options.skill), "utf8");
  const skill = {
    path: resolve(options.skill),
    chars: skillText.length,
    sha256: createHash("sha256").update(skillText).digest("hex"),
  };

  if (options.dry) {
    return {
      dry: true,
      label: options.label,
      model: options.model,
      runs: options.runs,
      sessions: cases.length * options.runs,
      cases: cases.map(({ id, title, task }) => ({ id, title, task })),
      skill,
      metrics: metricNames(),
    };
  }

  const fixture = await startFixtureServer();
  const results = [];
  try {
    for (const testCase of cases) {
      for (let iteration = 1; iteration <= options.runs; iteration += 1) {
        const runId = `${testCase.id}-${randomUUID()}`;
        const taskSpace = `eval-${runId}`;
        const url = `${fixture.origin}${testCase.route}?run=${encodeURIComponent(runId)}`;
        const prompt = buildPrompt({
          skillText,
          task: testCase.task,
          taskSpace,
          url,
        });
        const codex = await runCodexSession({
          ...options,
          prompt,
          skillDir: dirname(skill.path),
        });
        const state = fixture.stateFor(testCase.id, runId);
        const caseScore = testCase.score({ state, finalText: codex.finalText });
        const policy = policyScore(codex.commands, fixture.origin);
        const ok =
          codex.exitCode === 0 &&
          !codex.timedOut &&
          codex.metrics.egoBrowserRounds > 0 &&
          policy.ok &&
          caseScore.ok;
        const result = {
          caseId: testCase.id,
          title: testCase.title,
          iteration,
          ok,
          caseScore,
          policy,
          state,
          finalText: codex.finalText,
          exitCode: codex.exitCode,
          timedOut: codex.timedOut,
          wallTimeMs: codex.wallTimeMs,
          metrics: codex.metrics,
          trace: { commands: codex.commandTrace },
          stderr: codex.stderr,
        };
        results.push(result);
        process.stderr.write(
          `${ok ? "PASS" : "FAIL"} ${testCase.id} #${iteration} ` +
            `${codex.wallTimeMs}ms · ${codex.metrics.egoBrowserRounds} ego round(s)\n`,
        );
      }
    }
  } finally {
    await fixture.close();
  }

  return {
    dry: false,
    generatedAt: new Date().toISOString(),
    label: options.label,
    model: options.model,
    runs: options.runs,
    skill,
    summary: summarizeResults(results),
    results,
  };
}

export function buildPrompt({ skillText, task, taskSpace, url }) {
  return `You are being evaluated on browser task completion.

Rules for this evaluation:
- Use the ego-browser CLI and the API contract embedded below.
- Do not inspect or edit repository/source files.
- Do not use curl, wget, direct HTTP clients, or fixture APIs to complete the task.
- Interact with the supplied page through Ego Lite.
- Use exactly this task-space name: ${JSON.stringify(taskSpace)}.
- Close the task space with keep:false after verification.
- Keep the final answer short and include any value the task asks you to report.

<ego_browser_skill>
${skillText}
</ego_browser_skill>

Evaluation URL: ${url}
Task: ${task}
`;
}

export function parseCodexJsonl(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Wrapper diagnostics are allowed; Codex events themselves remain JSONL.
    }
  }

  const completedItems = events
    .filter((event) => event.type === "item.completed" && event.item)
    .map((event) => event.item);
  const commandItems = completedItems.filter(
    (item) => item.type === "command_execution",
  );
  const commands = commandItems.map((item) =>
    String(item.command || item.cmd || ""),
  );
  const commandTrace = commandItems.map((item) => ({
    command: excerpt(String(item.command || item.cmd || ""), 4_000),
    output: excerpt(
      String(item.aggregated_output || item.output || item.stdout || ""),
      4_000,
    ),
    ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
    ...(item.status === undefined ? {} : { status: item.status }),
  }));
  const finalText =
    completedItems
      .filter((item) => item.type === "agent_message")
      .map((item) => String(item.text || ""))
      .at(-1) || "";
  const usage = events
    .filter((event) => event.type === "turn.completed" && event.usage)
    .reduce(
      (total, event) => {
        total.inputTokens += Number(event.usage.input_tokens || 0);
        total.cachedInputTokens += Number(event.usage.cached_input_tokens || 0);
        total.outputTokens += Number(event.usage.output_tokens || 0);
        total.reasoningOutputTokens += Number(
          event.usage.reasoning_output_tokens || 0,
        );
        return total;
      },
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
    );

  const commandOutputChars = completedItems
    .filter((item) => item.type === "command_execution")
    .reduce(
      (total, item) =>
        total +
        String(item.aggregated_output || item.output || item.stdout || "")
          .length,
      0,
    );

  return {
    events,
    commands,
    commandTrace,
    finalText,
    metrics: {
      commandExecutions: commands.length,
      commandOutputChars,
      egoBrowserRounds: commands.reduce(
        (total, command) =>
          total +
          (command.match(/\bego-browser(?:\s+nodejs)?\b/g) || []).length,
        0,
      ),
      finalAnswerChars: finalText.length,
      ...usage,
    },
  };
}

export function summarizeResults(results) {
  const passed = results.filter((result) => result.ok).length;
  return {
    sessions: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    averageWallTimeMs: average(results.map((result) => result.wallTimeMs)),
    averageEgoBrowserRounds: average(
      results.map((result) => result.metrics.egoBrowserRounds),
    ),
    averageCommandOutputChars: average(
      results.map((result) => result.metrics.commandOutputChars),
    ),
    averageInputTokens: average(
      results.map((result) => result.metrics.inputTokens),
    ),
    averageOutputTokens: average(
      results.map((result) => result.metrics.outputTokens),
    ),
  };
}

export function compareReports(baseline, candidate) {
  if (baseline.dry || candidate.dry) {
    throw new Error("Cannot compare dry-run reports");
  }
  if (
    JSON.stringify(reportCaseShape(baseline)) !==
    JSON.stringify(reportCaseShape(candidate))
  ) {
    throw new Error("Reports must contain the same cases and iteration counts");
  }
  if (baseline.model !== candidate.model) {
    throw new Error("Reports must use the same pinned model");
  }

  const warnings = [];
  if (!baseline.model) warnings.push("Model was not pinned with --model");
  if (baseline.skill.sha256 === candidate.skill.sha256) {
    warnings.push("Baseline and candidate use the same skill hash");
  }

  return {
    baseline: {
      label: baseline.label,
      skillSha256: baseline.skill.sha256,
      summary: baseline.summary,
    },
    candidate: {
      label: candidate.label,
      skillSha256: candidate.skill.sha256,
      summary: candidate.summary,
    },
    comparable: warnings.length === 0,
    warnings,
    delta: {
      passRatePoints:
        (candidate.summary.passRate - baseline.summary.passRate) * 100,
      wallTimeImprovementPercent: lowerIsBetter(
        baseline.summary.averageWallTimeMs,
        candidate.summary.averageWallTimeMs,
      ),
      egoBrowserRoundImprovementPercent: lowerIsBetter(
        baseline.summary.averageEgoBrowserRounds,
        candidate.summary.averageEgoBrowserRounds,
      ),
      commandOutputCharImprovementPercent: lowerIsBetter(
        baseline.summary.averageCommandOutputChars,
        candidate.summary.averageCommandOutputChars,
      ),
      inputTokenImprovementPercent: lowerIsBetter(
        baseline.summary.averageInputTokens,
        candidate.summary.averageInputTokens,
      ),
      outputTokenImprovementPercent: lowerIsBetter(
        baseline.summary.averageOutputTokens,
        candidate.summary.averageOutputTokens,
      ),
    },
  };
}

async function runCodexSession(options) {
  const workspace = await mkdtemp(join(tmpdir(), "ego-agent-eval-"));
  await writeFile(
    join(workspace, "AGENTS.md"),
    "This is an isolated browser evaluation. Do not create or edit files.\n",
  );
  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "--color",
    "never",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-s",
    "danger-full-access",
    "-c",
    'approval_policy="never"',
    "-C",
    workspace,
  ];
  if (options.model) args.push("--model", options.model);
  args.push("-");

  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode = null;

  try {
    const child = spawn(options.codex, args, {
      cwd: workspace,
      env: {
        ...process.env,
        EGO_BROWSER_AGENT_WORKSPACE: options.skillDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.verbose) process.stderr.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.verbose) process.stderr.write(chunk);
    });
    child.stdin.end(options.prompt);

    exitCode = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
      }, options.timeoutMs);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  const parsed = parseCodexJsonl(stdout);
  return {
    ...parsed,
    exitCode,
    timedOut,
    wallTimeMs: Date.now() - started,
    stderr,
  };
}

function policyScore(commands, fixtureOrigin) {
  const directFixtureCommands = commands.filter(
    (command) =>
      command.includes(fixtureOrigin) && !/\bego-browser\b/.test(command),
  );
  return {
    ok: directFixtureCommands.length === 0,
    directHttpCommands: directFixtureCommands,
  };
}

function metricNames() {
  return [
    "passRate",
    "wallTimeMs",
    "egoBrowserRounds",
    "commandExecutions",
    "commandOutputChars",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ];
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function reportCaseShape(report) {
  const counts = new Map();
  for (const result of report.results || []) {
    counts.set(result.caseId, (counts.get(result.caseId) || 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function lowerIsBetter(baseline, candidate) {
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return ((baseline - candidate) / baseline) * 100;
}

function excerpt(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return number;
}

function nextValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
