import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { selectedCases } from "./cases.mjs";
import { startFixtureServer } from "./fixture-server.mjs";
import {
  compareReports,
  parseArgs,
  parseCodexJsonl,
  summarizeResults,
} from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("parseArgs supports repeatable and comma-separated cases", () => {
  const options = parseArgs([
    "--dry",
    "--case",
    "semantic-form,dynamic-rerender",
    "--case",
    "new-tab",
    "--runs",
    "3",
  ]);
  assert.equal(options.dry, true);
  assert.equal(options.runs, 3);
  assert.deepEqual(options.caseIds, [
    "semantic-form",
    "dynamic-rerender",
    "new-tab",
  ]);
});

test("selectedCases rejects unknown ids", () => {
  assert.throws(() => selectedCases(["missing"]), /Unknown eval case/);
});

test("parseCodexJsonl extracts commands, rounds, final answer, and usage", () => {
  const stdout = [
    "wrapper noise",
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "ego-browser nodejs <<'EOF'\nconsole.log('ok')\nEOF",
        aggregated_output: "ok\n",
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "msg-1", type: "agent_message", text: "Saved" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 10,
        reasoning_output_tokens: 4,
      },
    }),
  ].join("\n");
  const parsed = parseCodexJsonl(stdout);
  assert.equal(parsed.finalText, "Saved");
  assert.equal(parsed.commands.length, 1);
  assert.deepEqual(parsed.commandTrace, [
    {
      command: "ego-browser nodejs <<'EOF'\nconsole.log('ok')\nEOF",
      output: "ok\n",
    },
  ]);
  assert.equal(parsed.metrics.egoBrowserRounds, 1);
  assert.equal(parsed.metrics.commandOutputChars, 3);
  assert.equal(parsed.metrics.inputTokens, 100);
  assert.equal(parsed.metrics.cachedInputTokens, 20);
  assert.equal(parsed.metrics.outputTokens, 10);
  assert.equal(parsed.metrics.reasoningOutputTokens, 4);
});

test("summarizeResults reports comparable aggregate metrics", () => {
  const summary = summarizeResults([
    {
      ok: true,
      wallTimeMs: 100,
      metrics: {
        egoBrowserRounds: 1,
        commandOutputChars: 10,
        inputTokens: 1000,
        outputTokens: 20,
      },
    },
    {
      ok: false,
      wallTimeMs: 300,
      metrics: {
        egoBrowserRounds: 3,
        commandOutputChars: 30,
        inputTokens: 3000,
        outputTokens: 60,
      },
    },
  ]);
  assert.deepEqual(summary, {
    sessions: 2,
    passed: 1,
    failed: 1,
    passRate: 0.5,
    averageWallTimeMs: 200,
    averageEgoBrowserRounds: 2,
    averageCommandOutputChars: 20,
    averageInputTokens: 2000,
    averageOutputTokens: 40,
  });
});

test("compareReports returns pass-rate and lower-is-better deltas", () => {
  const baseline = reportFixture({
    label: "baseline",
    hash: "base",
    passRate: 0.5,
    wallTime: 200,
    rounds: 2,
    chars: 100,
    inputTokens: 1000,
    outputTokens: 100,
  });
  const candidate = reportFixture({
    label: "candidate",
    hash: "candidate",
    passRate: 1,
    wallTime: 150,
    rounds: 1,
    chars: 60,
    inputTokens: 800,
    outputTokens: 90,
  });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.comparable, true);
  assert.deepEqual(comparison.delta, {
    passRatePoints: 50,
    wallTimeImprovementPercent: 25,
    egoBrowserRoundImprovementPercent: 50,
    commandOutputCharImprovementPercent: 40,
    inputTokenImprovementPercent: 20,
    outputTokenImprovementPercent: 10,
  });
});

test("compareReports rejects mismatched models", () => {
  const baseline = reportFixture({ label: "baseline", hash: "base" });
  const candidate = reportFixture({ label: "candidate", hash: "candidate" });
  candidate.model = "different-model";
  assert.throws(() => compareReports(baseline, candidate), /same pinned model/);
});

test("fixture server exposes deterministic semantic and tab state", async () => {
  const fixture = await startFixtureServer();
  try {
    const semantic = await fetch(`${fixture.origin}/semantic-form?run=form-1`);
    assert.equal(semantic.status, 200);
    assert.match(await semantic.text(), /Display name/);
    await fetch(`${fixture.origin}/api/save?run=form-1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Ada Lovelace",
        productUpdates: true,
      }),
    });
    assert.deepEqual(fixture.stateFor("semantic-form", "form-1"), {
      caseId: "semantic-form",
      runId: "form-1",
      saved: true,
      displayName: "Ada Lovelace",
      productUpdates: true,
    });

    const target = await fetch(`${fixture.origin}/new-tab-target?run=tab-1`);
    assert.equal(target.status, 200);
    const tabState = fixture.stateFor("new-tab", "tab-1");
    assert.equal(tabState.targetVisited, true);
    assert.match(await target.text(), new RegExp(tabState.targetCode));
  } finally {
    await fixture.close();
  }
});

test("fixture shutdown closes a browser-style lingering connection", async () => {
  const fixture = await startFixtureServer();
  const url = new URL(fixture.origin);
  const socket = connect(Number(url.port), url.hostname);
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write("GET /semantic-form?run=linger HTTP/1.1\r\nHost: localhost\r\n");

  await Promise.race([
    fixture.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("fixture close timed out")), 1_000),
    ),
  ]);
  socket.destroy();
});

test("dry run previews the suite without launching Codex", () => {
  const result = spawnSync(
    process.execPath,
    [join(HERE, "run.mjs"), "--dry", "--case", "semantic-form"],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dry, true);
  assert.equal(report.sessions, 1);
  assert.equal(report.cases[0].id, "semantic-form");
  assert.equal(report.skill.chars > 10_000, true);
});

function reportFixture({
  label,
  hash,
  passRate = 1,
  wallTime = 100,
  rounds = 1,
  chars = 10,
  inputTokens = 100,
  outputTokens = 10,
}) {
  return {
    dry: false,
    label,
    model: "test-model",
    skill: { sha256: hash },
    summary: {
      passRate,
      averageWallTimeMs: wallTime,
      averageEgoBrowserRounds: rounds,
      averageCommandOutputChars: chars,
      averageInputTokens: inputTokens,
      averageOutputTokens: outputTokens,
    },
    results: [{ caseId: "semantic-form" }],
  };
}
