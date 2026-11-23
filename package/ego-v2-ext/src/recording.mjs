/**
 * page.screencast.start/stop and page.trace() on v2 Pages, ported from the
 * v1 runtime.
 *
 * screencast
 * ----------
 * Implemented as a getter on the Page prototype that returns a per-page
 * ScreencastController cached in a WeakMap. The controller uses
 *   page.cdp("Page.startScreencast", …) / page.cdp("Page.stopScreencast", {})
 * and polls page.events() for Page.screencastFrame events at 50 ms intervals.
 *
 * v1 kept a module-level activeRecording variable, so start/stop were bound
 * to a single script/process — only one recording per process at a time. The
 * v2 port widens that to one recording per Page instance (the ScreencastController
 * is per-page), which is strictly more flexible while preserving the invariant
 * that you cannot start() while a recording is already active on the same page.
 *
 * Video encoding: delegates to VideoRecorder (inlined from
 * the former v1 runtime: video-recorder.ts, removed in 2.3.0-linux.1). It requires ffmpeg (the binary
 * named "ffmpeg" or the path in EGO_BROWSER_FFMPEG_PATH).
 *
 * trace
 * -----
 * v1's page.trace() drains the CDP call trace (requests + responses + events).
 * v2 only exposes page.events() (browser-pushed CDP events), so the v2 port
 * drains those and formats them in the same ego-browser.trace.v1 schema shape,
 * with kind="event" for every entry.
 */

import { spawn } from "node:child_process";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

// Recorders still running when this process exits. Each script round is its
// own process; an ffmpeg left behind by a script that never called stop() is
// killed here instead of outliving it.
const liveRecorders = new Set();
process.once("exit", () => {
  for (const recorder of liveRecorders) {
    try {
      recorder._process?.kill("SIGKILL");
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCREENCAST_POLL_MS = 50;
const TRACE_SCHEMA = "ego-browser.trace.v1";
const DEFAULT_TRACE_LIMIT = 80;
const SECRET_QUERY =
  /([?&](?:token|access_token|code|key|secret|password|auth|session)[^=&]*=)[^&#]*/gi;

function redactSecrets(url) {
  return typeof url === "string"
    ? url.replace(SECRET_QUERY, "$1<redacted>")
    : url;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function evenSize(size) {
  return { width: size.width & ~1, height: size.height & ~1 };
}

async function computeDefaultSize(page) {
  const info = await page.info();
  const w = Number(info?.w) || 800;
  const h = Number(info?.h) || 600;
  const scale = Math.min(1, 800 / Math.max(w, h));
  return { width: Math.floor(w * scale), height: Math.floor(h * scale) };
}

// ---------------------------------------------------------------------------
// VideoRecorder — inlined from the former v1 runtime (video-recorder.ts, removed in 2.3.0-linux.1)
// Same ffmpeg dependency, same error message, same frame-writing logic.
// ---------------------------------------------------------------------------

const FPS = 25;
const MAX_STDERR_LENGTH = 64 * 1024;

class VideoRecorder {
  constructor(options) {
    this._options = options;
    this._process = null;
    this._exitPromise = undefined;
    this._writePromise = Promise.resolve();
    this._firstFrameTimestamp = undefined;
    this._lastFrame = undefined;
    this._lastFrameReceivedAt = 0;
    this._stderr = "";
    this._stdinError = undefined;
    this._stopPromise = undefined;
    this._tempOutputPath = undefined;
  }

  async start() {
    const { outputPath, size } = this._options;
    await mkdir(dirname(outputPath), { recursive: true });
    this._tempOutputPath = `${outputPath}.${process.pid}-${Math.random()
      .toString(16)
      .slice(2)}.webm`;
    const args = [
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-avioflags",
      "direct",
      "-fpsprobesize",
      "0",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
      "-y",
      "-an",
      "-r",
      "25",
      "-c:v",
      "vp8",
      "-qmin",
      "0",
      "-qmax",
      "50",
      "-crf",
      "8",
      "-deadline",
      "realtime",
      "-speed",
      "8",
      "-b:v",
      "1M",
      "-threads",
      "1",
      "-vf",
      `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
      this._tempOutputPath,
    ];
    const spawnProcess = this._options.spawnProcess ?? spawn;
    this._process = spawnProcess(
      this._options.ffmpegPath ??
        process.env.EGO_BROWSER_FFMPEG_PATH ??
        "ffmpeg",
      args,
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    this._exitPromise = new Promise((resolve) => {
      this._process.once("close", (code, signal) => resolve({ code, signal }));
      this._process.once("error", (error) => resolve({ error }));
    });
    this._process.stderr?.on("data", (chunk) => {
      this._stderr = `${this._stderr}${String(chunk)}`.slice(
        -MAX_STDERR_LENGTH,
      );
    });
    this._process.stdin?.on("error", (error) => {
      this._stdinError ??= error;
    });
    try {
      await new Promise((resolve, reject) => {
        this._process.once("spawn", resolve);
        this._process.once("error", reject);
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(
          "FFmpeg executable was not found. Install ffmpeg or set EGO_BROWSER_FFMPEG_PATH.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  writeFrame(buffer, timestamp) {
    const frameNumber =
      this._firstFrameTimestamp !== undefined
        ? Math.floor(((timestamp - this._firstFrameTimestamp) * FPS) / 1000)
        : 0;
    if (this._lastFrame) {
      this._queueFrames(
        this._lastFrame.buffer,
        Math.max(0, frameNumber - this._lastFrame.frameNumber),
      );
    } else {
      this._firstFrameTimestamp = timestamp;
    }
    this._lastFrame = { buffer, timestamp, frameNumber };
    this._lastFrameReceivedAt = this._now();
    return this._writePromise;
  }

  stop() {
    this._stopPromise ??= this._stop();
    return this._stopPromise;
  }

  async _stop() {
    if (this._lastFrame && this._firstFrameTimestamp !== undefined) {
      const elapsed = Math.max(this._now() - this._lastFrameReceivedAt, 1000);
      const finalFrameNumber = Math.floor(
        ((this._lastFrame.timestamp + elapsed - this._firstFrameTimestamp) *
          FPS) /
          1000,
      );
      this._queueFrames(
        this._lastFrame.buffer,
        Math.max(0, finalFrameNumber - this._lastFrame.frameNumber),
      );
    }
    let writeError;
    try {
      await this._writePromise;
    } catch (error) {
      writeError = error;
    }
    try {
      this._process.stdin.end();
    } catch (error) {
      this._stdinError ??= error;
    }
    const result = await this._exitPromise;
    const failure = result?.error ?? writeError ?? this._stdinError;
    if (failure || result?.code !== 0) {
      await this._removeTempOutput();
      const detail = this._stderr.trim();
      const status = result?.error
        ? result.error.message
        : `exited with code ${result?.code}`;
      throw new Error(`ffmpeg ${status}${detail ? `: ${detail}` : ""}`, {
        cause: failure,
      });
    }
    try {
      await rename(this._tempOutputPath, this._options.outputPath);
    } catch (error) {
      await this._removeTempOutput();
      throw error;
    }
  }

  _queueFrames(buffer, count) {
    this._writePromise = this._writePromise.then(async () => {
      for (let i = 0; i < count; i++) {
        await new Promise((resolve, reject) => {
          this._process.stdin.write(buffer, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
    });
  }

  _now() {
    return (this._options.now ?? Date.now)();
  }

  async _removeTempOutput() {
    if (!this._tempOutputPath) return;
    await unlink(this._tempOutputPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

// ---------------------------------------------------------------------------
// ScreencastController — per-page screencast handle
// ---------------------------------------------------------------------------

class ScreencastController {
  #page;
  #active = null;

  constructor(page) {
    this.#page = page;
  }

  async start(options) {
    if (
      !options ||
      typeof options.path !== "string" ||
      !options.path.endsWith(".webm")
    ) {
      throw new Error("page.screencast.start path must end with .webm");
    }
    const quality = options.quality ?? 90;
    if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
      throw new Error(
        "page.screencast.start quality must be between 0 and 100",
      );
    }
    if (
      options.size &&
      (!Number.isInteger(options.size.width) ||
        !Number.isInteger(options.size.height) ||
        options.size.width < 2 ||
        options.size.height < 2)
    ) {
      throw new Error(
        "page.screencast.start width and height must be at least 2 pixels",
      );
    }
    if (this.#active) throw new Error("Screencast is already started");

    const page = this.#page;
    const size = evenSize(
      options.size != null ? options.size : await computeDefaultSize(page),
    );
    // Like page.screenshot: the script does not run in the caller's working
    // directory, so a relative path would land somewhere unexpected.
    if (typeof options.path !== "string" || !isAbsolute(options.path)) {
      throw new Error("page.screencast.start path must be an absolute path");
    }
    const outputPath = resolve(options.path);
    const recorder = new VideoRecorder({ outputPath, size });
    await recorder.start();
    liveRecorders.add(recorder);

    // Start CDP screencast before entering the poll loop so the first frame
    // arrives as soon as possible. If it fails, do not leave ffmpeg running.
    try {
      await page.cdp("Page.startScreencast", {
        format: "jpeg",
        quality,
        maxWidth: size.width,
        maxHeight: size.height,
      });
    } catch (error) {
      liveRecorders.delete(recorder);
      await Promise.resolve(recorder.stop()).catch(() => {});
      throw error;
    }

    const active = {
      recorder,
      quality,
      stopped: false,
      receivedFrames: false,
      error: null,
      frameChain: Promise.resolve(),
    };
    this.#active = active;
    // Fire the poll loop without awaiting; it runs until active.stopped = true.
    active.pollPromise = this.#pollLoop(active);

    const dispose = async () => {
      if (this.#active === active) await this.stop();
    };
    return { dispose, [Symbol.asyncDispose]: dispose };
  }

  async #pollLoop(active) {
    const page = this.#page;
    while (!active.stopped) {
      try {
        const events = await page.events();
        for (const event of events) {
          if (event?.method !== "Page.screencastFrame") continue;
          active.receivedFrames = true;
          const params = event.params ?? {};
          const ts =
            typeof params.metadata?.timestamp === "number"
              ? params.metadata.timestamp * 1000
              : Date.now();
          const frameData = Buffer.from(params.data, "base64");
          const ackSessionId = params.sessionId;
          // Chain frame writes to preserve order and avoid concurrent ffmpeg writes.
          active.frameChain = active.frameChain
            .then(async () => {
              await active.recorder.writeFrame(frameData, ts);
              await page
                .cdp("Page.screencastFrameAck", { sessionId: ackSessionId })
                .catch(() => {});
            })
            .catch((err) => {
              active.error ??= err;
            });
        }
      } catch (err) {
        active.error ??= err;
      }
      if (!active.stopped) await sleep(SCREENCAST_POLL_MS);
    }
  }

  async stop() {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    active.stopped = true;

    // Wait for the poll loop to finish its current iteration.
    await active.pollPromise.catch(() => {});
    // Drain any queued frame writes.
    await active.frameChain.catch(() => {});

    // If no frames arrived (tab not visible / CDP screencast not supported),
    // capture a single screenshot so the recorder produces a valid WebM.
    if (!active.receivedFrames) {
      try {
        const response = await this.#page.cdp("Page.captureScreenshot", {
          format: "jpeg",
          quality: active.quality,
        });
        // page.cdp() returns the full CDP message {id, result, ...}.
        const data = response?.result?.data ?? response?.data;
        if (data) {
          await active.recorder.writeFrame(
            Buffer.from(data, "base64"),
            Date.now(),
          );
        }
      } catch (err) {
        active.error ??= err;
      }
    }

    try {
      await this.#page.cdp("Page.stopScreencast", {}).catch(() => {});
    } catch {}

    try {
      liveRecorders.delete(active.recorder);
      await active.recorder.stop();
    } catch (err) {
      active.error ??= err;
    }

    if (active.error) throw active.error;
  }
}

// ---------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------

function formatEventAsTraceItem(event, seq, redact) {
  const params = event?.params ?? {};
  const method = String(event?.method ?? "unknown");
  const item = {
    seq,
    at: new Date().toISOString(),
    kind: "event",
    method,
  };
  if (event?.sessionId) item.sessionId = String(event.sessionId);
  if (params.requestId !== undefined) item.requestId = params.requestId;
  if (params.type !== undefined) item.type = params.type;

  const url = params.url ?? params.request?.url ?? params.response?.url ?? null;
  if (url) item.url = redact ? redactSecrets(url) : url;
  if (params.response?.status !== undefined)
    item.status = params.response.status;
  if (params.errorText) item.errorText = params.errorText;

  item.summary = eventSummary(method, params, redact);
  return item;
}

function eventSummary(method, params, redact) {
  const rawUrl =
    params.url ?? params.request?.url ?? params.response?.url ?? "";
  const displayUrl = redact ? redactSecrets(rawUrl) : rawUrl;

  if (method === "Network.requestWillBeSent") {
    return `request ${params.request?.method ?? ""} ${displayUrl}`.trim();
  }
  if (method === "Network.responseReceived") {
    return `response ${params.response?.status ?? ""} ${displayUrl}`.trim();
  }
  if (method === "Network.loadingFailed") {
    return `request failed ${params.errorText ?? ""}`.trim();
  }
  if (method === "Page.frameNavigated") {
    const navUrl = params.frame?.url ?? "";
    return `navigated ${redact ? redactSecrets(navUrl) : navUrl}`;
  }
  if (method === "Page.domContentEventFired") return "domcontentloaded";
  if (method === "Page.loadEventFired") return "load";
  if (method === "Runtime.consoleAPICalled") {
    const args = (params.args ?? [])
      .map((a) => a?.value ?? a?.description ?? "")
      .join(" ");
    return `console ${params.type ?? "log"}${args ? `: ${String(args).slice(0, 200)}` : ""}`;
  }
  if (method === "Page.javascriptDialogOpening") {
    return `dialog ${params.type ?? ""}: ${String(params.message ?? "").slice(0, 200)}`.trim();
  }
  if (method === "Page.screencastFrame") return "screencastFrame";
  return method;
}

async function pageTrace(page, options = {}) {
  if (
    options !== null &&
    typeof options === "object" &&
    !Array.isArray(options)
  ) {
    // ok
  } else if (options !== undefined) {
    throw new TypeError("page.trace options must be an object");
  }
  const opts = options ?? {};
  const limit =
    Number.isFinite(opts.limit) && opts.limit >= 0
      ? Math.floor(opts.limit)
      : DEFAULT_TRACE_LIMIT;
  const redact = opts.redact !== false;

  const events = await page.events();
  const now = Date.now();
  const shown = limit === 0 ? [] : events.slice(-limit);

  return {
    schema: TRACE_SCHEMA,
    createdAt: new Date(now).toISOString(),
    count: events.length,
    shown: shown.length,
    items: shown.map((event, i) => formatEventAsTraceItem(event, i, redact)),
  };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

const screencastCache = new WeakMap();

export function installRecording(proto, define) {
  define(proto, "trace", function (options) {
    return pageTrace(this, options ?? {});
  });

  // screencast is a getter (not a plain method) so Object.defineProperty is
  // used directly instead of the define() helper.
  if (!("screencast" in proto)) {
    Object.defineProperty(proto, "screencast", {
      get() {
        let controller = screencastCache.get(this);
        if (!controller) {
          controller = new ScreencastController(this);
          screencastCache.set(this, controller);
        }
        return controller;
      },
      configurable: true,
      enumerable: false,
    });
  }
}
