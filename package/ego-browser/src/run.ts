import {
  pid as processPid,
  stdin as processStdin,
  stdout as processStdout,
  stderr as processStderr,
  version as nodeVersion,
} from "node:process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { formatCliLogValue } from "./format.js";
import * as helpers from "./helpers.js";
import { bufferOutput, flushSink, resetSink } from "./output-sink.js";
import { state } from "./state.js";

type WritableLike = {
  write(chunk: string): unknown;
};

type ReadableLike = {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type RunServices = {
  resetConnection(): Promise<void>;
  printUpdateBanner(stream: WritableLike): void;
  runDoctor(stream: WritableLike): Promise<number>;
};

export type RunMainOptions = {
  argv?: string[];
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: ReadableLike;
  stdinText?: string;
  env?: Record<string, string | undefined>;
  services?: Partial<RunServices>;
};

export const HELP = `ego-browser

Read the ego-browser skill for the default workflow and examples.

Typical usage:
  ego-browser <<'JS'
  await page.waitForLoadState()
  console.log(await page.info())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.

Commands:
  ego-browser --doctor         inspect browser and connection state
  ego-browser --reload         reset the browser connection on next call
`;

export const USAGE = `Usage:
  ego-browser <<'JS'
  console.log(await page.info())
  JS
`;

export async function runMain(options: RunMainOptions = {}) {
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || processStdout;
  const stderr = options.stderr || processStderr;
  const env = options.env || process.env;
  const services = {
    resetConnection: async () => {},
    printUpdateBanner: () => {},
    runDoctor: async () => 0,
    ...options.services,
  };

  if (argv[0] === "-h" || argv[0] === "--help") {
    write(stdout, HELP);
    return 0;
  }
  if (argv[0] === "--doctor") {
    return services.runDoctor(stdout);
  }
  if (argv[0] === "--reload") {
    await services.resetConnection();
    write(stdout, "browser connection reset on next call\n");
    return 0;
  }
  if (argv[0] === "--debug-clicks") {
    env.EGO_BROWSER_DEBUG_CLICKS = "1";
    argv.shift();
  }
  if (argv.length > 0) {
    write(stderr, USAGE);
    return 2;
  }

  const code =
    options.stdinText !== undefined
      ? options.stdinText
      : await readAll(options.stdin || processStdin);
  if (!code.trim()) {
    write(stderr, USAGE);
    return 2;
  }

  services.printUpdateBanner(stderr);
  await execute(code, stdout, stderr, env);
  return 0;
}

/**
 * Report the line the agent actually wrote.
 *
 * new AsyncFunction compiles the script inside a generated wrapper — a
 * `function anonymous(…)` header, its `) {`, and the injected `"use strict";` —
 * so V8 reports every position three lines below where the agent sees it. An
 * agent reading its own stack trace then goes and studies the wrong line, and a
 * report that blames an innocent console.log is one it cannot act on.
 *
 * The offset is measured from the compiled source rather than hardcoded, so a
 * V8 that changes its preamble stays correct instead of silently going wrong by
 * a different amount. Columns need no adjustment: the wrapper adds whole lines
 * and ends in a newline, so the script's first line still starts at column 1.
 *
 * Only eval frames are touched. V8 writes those as `, <anonymous>:LINE:COL)`,
 * which a stack coming back from the browser (`at fn (<anonymous>:3:9)`) does
 * not match — those line numbers belong to the page and are already correct.
 */
function realignScriptFrames(error: unknown, fn: Function, code: string) {
  if (!(error instanceof Error) || typeof error.stack !== "string") return;
  const source = fn.toString();
  const start = source.indexOf(code);
  if (start === -1) return;
  const offset = source.slice(0, start).split("\n").length - 1;
  if (offset <= 0) return;
  error.stack = error.stack
    .split("\n")
    // Frame lines only. A stack starts with the message, and an agent that
    // scrapes a page showing a stack trace and throws it would otherwise have
    // its own message rewritten.
    .map((line) =>
      /^\s+at /.test(line)
        ? line.replace(/, <anonymous>:(\d+):(\d+)\)/g, (frame, at, column) => {
            const real = Number(at) - offset;
            return real > 0 ? `, <anonymous>:${real}:${column})` : frame;
          })
        : line,
    )
    .join("\n");
}

async function execute(
  code: string,
  stdout: WritableLike,
  stderr: WritableLike,
  env: Record<string, string | undefined>,
) {
  resetSink();
  const context = await executionContext();
  Object.assign(globalThis, context);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const names = Object.keys(context);
  const values = Object.values(context);
  const fn = new AsyncFunction(...names, `"use strict";\n${code}`);
  let thrown;
  try {
    await fn(...values);
  } catch (error) {
    realignScriptFrames(error, fn, code);
    thrown = error;
  }
  try {
    await helpers.stopScreencast();
  } catch (error) {
    thrown ??= error;
  }
  if (thrown) {
    thrown = withExecutionHint(thrown);
    if (
      failureArtifactsEnabled(env) &&
      !helpers.isEgoHardStopError(thrown)
    ) {
      await emitFailureArtifact(thrown, code, stderr, env);
    }
  }
  // A thrown Error surfaces a hard-stop message on its own, so flush as a thrown
  // completion (drop the buffer, stay silent) and let it propagate.
  flushSink(stdout, Boolean(thrown));
  if (thrown) throw thrown;
}

let failureArtifactSeq = 0;

async function emitFailureArtifact(
  error: unknown,
  code: string,
  stderr: WritableLike,
  env: Record<string, string | undefined>,
) {
  try {
    const path = await writeFailureArtifact(error, code, env);
    write(stderr, `ego-browser: failure artifact written to ${path}\n`);
  } catch (artifactError) {
    write(
      stderr,
      `ego-browser: failed to write failure artifact: ${formatErrorMessage(artifactError)}\n`,
    );
  }
}

async function writeFailureArtifact(
  error: unknown,
  code: string,
  env: Record<string, string | undefined>,
) {
  const dir = env.EGO_BROWSER_FAILURE_ARTIFACT_DIR || tmpdir();
  const filename = `ego-browser-failure-${processPid}-${state.now()}-${++failureArtifactSeq}.json`;
  const path = join(dir, filename);
  const artifact: Record<string, unknown> = {
    schema: "ego-browser.failure-artifact.v1",
    createdAt: new Date(state.now()).toISOString(),
    runtime: {
      pid: processPid,
      node: nodeVersion,
    },
    script: {
      chars: code.length,
      lines: code.split(/\r\n|\r|\n/).length,
    },
    error: summarizeError(error),
  };

  try {
    artifact.debug = await helpers.debug({
      maxSnapshotChars: 4000,
      eventLimit: 50,
    });
  } catch (debugError) {
    artifact.debugError = summarizeError(debugError);
  }

  await mkdir(dir, { recursive: true });
  await state.writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return path;
}

function failureArtifactsEnabled(env: Record<string, string | undefined>) {
  const value = env.EGO_BROWSER_FAILURE_ARTIFACT;
  return !value || !/^(0|false|off|no)$/i.test(value);
}

function summarizeError(error: unknown) {
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const out: Record<string, unknown> = {
      name: typeof obj.name === "string" ? obj.name : "Error",
      message:
        typeof obj.message === "string" ? obj.message : formatErrorMessage(error),
    };
    if (typeof obj.stack === "string") {
      out.stack = obj.stack;
    }
    if (typeof obj.error_code === "string") {
      out.code = obj.error_code;
    }
    return out;
  }
  return { name: "Error", message: formatErrorMessage(error) };
}

function formatErrorMessage(error: unknown) {
  if (error == null) return String(error);
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function withExecutionHint(error: unknown) {
  if (!error || typeof error !== "object") {
    return error;
  }
  const err = error as { message?: unknown; stack?: unknown };
  if (
    typeof err.message !== "string" ||
    !/\.toString is not a function/.test(err.message) ||
    err.message.includes("ego-browser hint:")
  ) {
    return error;
  }

  const original = err.message;
  const originalStack = typeof err.stack === "string" ? err.stack : undefined;
  const hinted =
    `${original}\n\n` +
    "ego-browser hint: print helper results with console.log(value) or " +
    "JSON.stringify(value, null, 2) instead of calling .toString() on " +
    "unknown page data. page.screenshot() returns a file path; if you need " +
    "image bytes, read that path with fs.readFile first, then call " +
    "buffer.toString('base64').";
  err.message = hinted;
  if (originalStack) {
    err.stack = originalStack.replace(original, hinted);
  }
  return error;
}

export async function executionContext() {
  const agentHelpers = await helpers.loadAgentHelpers();
  // Single source of truth for the agent-facing surface: the same helperContext()
  // that installEgoSdk() exposes in the browser runtime, so the CLI and SDK paths
  // cannot drift apart (and `help` exists in both).
  const context: Record<string, any> = helpers.helperContext(agentHelpers);
  // Route the agent's primary output channel (console.log) through the output sink:
  // execute() flushes (or discards on hard stop) once the script settles, keeping the
  // CLI path identical to the SDK path. console.error/warn are left untouched. Each
  // heredoc runs in its own short-lived process, so overriding the global is per-run.
  console.log = (...args: unknown[]) => {
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
  };
  return context;
}

function readAll(stream: ReadableLike) {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

function write(stream: WritableLike, text: string) {
  stream.write(text);
}
