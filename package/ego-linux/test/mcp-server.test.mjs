import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler } from "@modelcontextprotocol/server";

import {
  createEgoBrowserMcpServer,
  runEgoBrowserScript,
} from "../src/mcp-server.mjs";

const RUNNER = fileURLToPath(
  new URL("fixture/mcp-runner.mjs", import.meta.url),
);
const MCP_BIN = fileURLToPath(
  new URL("../bin/ego-browser-mcp.mjs", import.meta.url),
);

function runnerOptions(overrides = {}) {
  return {
    command: process.execPath,
    args: [RUNNER],
    maxOutputBytes: 1024,
    ...overrides,
  };
}

test("runEgoBrowserScript captures successful stdout", async () => {
  const result = await runEgoBrowserScript(
    { script: "console.log('ok')", timeoutMs: 1000 },
    runnerOptions(),
  );

  assert.deepEqual(
    { ...result, durationMs: 0 },
    {
      stdout: "ran:console.log('ok')",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
      terminationReason: "completed",
    },
  );
  assert.ok(Number.isInteger(result.durationMs));
});

test("runEgoBrowserScript reports non-zero exits as completed failures", async () => {
  const result = await runEgoBrowserScript(
    { script: "exit:7", timeoutMs: 1000 },
    runnerOptions(),
  );

  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /runner failed: exit:7/);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationReason, "completed");
});

test("runEgoBrowserScript distinguishes an externally terminated child", async () => {
  const result = await runEgoBrowserScript(
    { script: "signal", timeoutMs: 1000 },
    runnerOptions(),
  );

  assert.equal(result.exitCode, null);
  assert.equal(result.terminationReason, "terminated");
  assert.match(result.stderr, /terminated before reporting an exit code/i);
});

test("runEgoBrowserScript terminates timeouts and output floods", async (t) => {
  await t.test("timeout", async () => {
    const result = await runEgoBrowserScript(
      { script: "hang", timeoutMs: 30 },
      runnerOptions(),
    );

    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationReason, "timeout");
    assert.match(result.stderr, /timed out/i);
  });

  await t.test("output limit", async () => {
    const result = await runEgoBrowserScript(
      { script: "bytes:4096", timeoutMs: 1000 },
      runnerOptions({ maxOutputBytes: 128 }),
    );

    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.terminationReason, "output-limit");
    assert.match(result.stderr, /output limit/i);
    assert.ok(Buffer.byteLength(result.stdout) <= 128);
  });
});

test("runEgoBrowserScript terminates when the MCP request is cancelled", async () => {
  const controller = new AbortController();
  const pending = runEgoBrowserScript(
    { script: "hang", timeoutMs: 1000, signal: controller.signal },
    runnerOptions(),
  );
  controller.abort();

  const result = await pending;
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationReason, "cancelled");
  assert.match(result.stderr, /cancelled/i);
});

test("modern MCP calls use the server factory and structured result", async (t) => {
  const calls = [];
  const handler = createMcpHandler(
    () =>
      createEgoBrowserMcpServer({
        runner: async (input) => {
          calls.push(input);
          return {
            stdout: "mcp-ok\n",
            stderr: "",
            exitCode: 0,
            durationMs: 12,
            timedOut: false,
            terminationReason: "completed",
          };
        },
      }),
    { legacy: "reject" },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://ego.test/mcp"),
    {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    },
  );
  const client = new Client(
    { name: "ego-browser-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );

  t.after(async () => {
    await client.close();
    await handler.close();
  });
  await client.connect(transport);

  assert.equal(client.getProtocolEra(), "modern");
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["ego_browser_run"],
  );

  const result = await client.callTool({
    name: "ego_browser_run",
    arguments: { script: "console.log('mcp-ok')", timeoutMs: 5000 },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    stdout: "mcp-ok\n",
    stderr: "",
    exitCode: 0,
    durationMs: 12,
    timedOut: false,
    terminationReason: "completed",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, "console.log('mcp-ok')");
  assert.equal(calls[0].timeoutMs, 5000);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("the shipped stdio entry negotiates the modern protocol and lists tools", async (t) => {
  const client = new Client(
    { name: "ego-browser-stdio-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    stderr: "pipe",
  });

  t.after(async () => {
    await client.close();
  });
  await client.connect(transport);

  assert.equal(client.getProtocolEra(), "modern");
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["ego_browser_run"],
  );
});
