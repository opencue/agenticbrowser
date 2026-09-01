import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const EGO_BROWSER_CLI = fileURLToPath(
  new URL("../bin/ego-browser.mjs", import.meta.url),
);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const FORCE_KILL_DELAY_MS = 1_000;

const resultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean(),
  terminationReason: z.enum([
    "completed",
    "timeout",
    "cancelled",
    "output-limit",
    "spawn-error",
    "terminated",
  ]),
});

function appendDiagnostic(value, diagnostic) {
  if (!value) return `${diagnostic}\n`;
  return `${value}${value.endsWith("\n") ? "" : "\n"}${diagnostic}\n`;
}

function cancelledResult(startedAt) {
  return {
    stdout: "",
    stderr: "ego-browser execution cancelled by the MCP client\n",
    exitCode: null,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    timedOut: false,
    terminationReason: "cancelled",
  };
}

/** Run one existing ego-browser heredoc invocation in an owned child process. */
export function runEgoBrowserScript(
  { script, timeoutMs = DEFAULT_TIMEOUT_MS, signal },
  {
    command = process.execPath,
    args = [EGO_BROWSER_CLI],
    cwd = process.cwd(),
    env = process.env,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = {},
) {
  const startedAt = performance.now();
  if (signal?.aborted) return Promise.resolve(cancelledResult(startedAt));

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        stdout: "",
        stderr: `failed to start ego-browser: ${error?.message || error}\n`,
        exitCode: null,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        timedOut: false,
        terminationReason: "spawn-error",
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let terminationReason = null;
    let spawnError = null;
    let forceKillTimer = null;

    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(
        () => child.kill("SIGKILL"),
        FORCE_KILL_DELAY_MS,
      );
      forceKillTimer.unref?.();
    };

    const capture = (bucket, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      if (remaining > 0) {
        const kept = bytes.subarray(0, remaining);
        bucket.push(kept);
        capturedBytes += kept.length;
      }
      if (bytes.length > remaining) terminate("output-limit");
    };

    child.stdout.on("data", (chunk) => capture(stdoutChunks, chunk));
    child.stderr.on("data", (chunk) => capture(stderrChunks, chunk));
    child.stdin.on("error", () => {});

    const onAbort = () => terminate("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref?.();

    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);

      const reason =
        terminationReason ||
        (spawnError
          ? "spawn-error"
          : code === null
            ? "terminated"
            : "completed");
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (reason === "timeout") {
        stderr = appendDiagnostic(
          stderr,
          `ego-browser execution timed out after ${timeoutMs} ms`,
        );
      } else if (reason === "cancelled") {
        stderr = appendDiagnostic(
          stderr,
          "ego-browser execution cancelled by the MCP client",
        );
      } else if (reason === "output-limit") {
        stderr = appendDiagnostic(
          stderr,
          `ego-browser output limit exceeded (${maxOutputBytes} bytes)`,
        );
      } else if (reason === "spawn-error") {
        stderr = appendDiagnostic(
          stderr,
          `failed to start ego-browser: ${spawnError?.message || "unknown error"}`,
        );
      } else if (reason === "terminated") {
        stderr = appendDiagnostic(
          stderr,
          "ego-browser process terminated before reporting an exit code",
        );
      }

      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr,
        exitCode: reason === "completed" ? code : null,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        timedOut: reason === "timeout",
        terminationReason: reason,
      });
    });

    child.stdin.end(script);
  });
}

function toolText(result) {
  if (result.exitCode === 0 && result.terminationReason === "completed") {
    return result.stdout || "ego-browser completed without output";
  }
  return (
    [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") ||
    `ego-browser failed (${result.terminationReason})`
  );
}

/** Build one MCP server instance for stdio, HTTP, or an in-process test host. */
export function createEgoBrowserMcpServer({
  runner = runEgoBrowserScript,
} = {}) {
  const server = new McpServer({ name: "ego-browser", version: "0.1.0" });
  let queue = Promise.resolve();

  const enqueue = (input) => {
    const pending = queue.then(() => runner(input));
    queue = pending.catch(() => {});
    return pending;
  };

  server.registerTool(
    "ego_browser_run",
    {
      title: "Run Ego Browser",
      description:
        "Run one complete ego-browser JavaScript program with the standard page, browser, taskSpaces, and site helpers.",
      inputSchema: z.object({
        script: z
          .string()
          .max(1_000_000)
          .refine(
            (value) => value.trim().length > 0,
            "script must not be empty",
          )
          .describe(
            "JavaScript source to execute with ego-browser helpers preloaded",
          ),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(600_000)
          .optional()
          .describe("Execution timeout in milliseconds; defaults to 120000"),
      }),
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ script, timeoutMs }, ctx) => {
      let result;
      try {
        result = await enqueue({
          script,
          timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: ctx.mcpReq.signal,
        });
      } catch (error) {
        result = {
          stdout: "",
          stderr: `ego-browser runner failed: ${error?.message || error}\n`,
          exitCode: null,
          durationMs: 0,
          timedOut: false,
          terminationReason: "spawn-error",
        };
      }

      const isError =
        result.exitCode !== 0 || result.terminationReason !== "completed";
      return {
        content: [{ type: "text", text: toolText(result) }],
        structuredContent: result,
        ...(isError ? { isError: true } : {}),
      };
    },
  );

  return server;
}
