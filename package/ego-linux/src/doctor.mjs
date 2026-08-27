import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { browserStatus } from "./chrome.mjs";
import { PROFILE_DIR, STATE_DIR, TASK_SPACE_FILE } from "./paths.mjs";
import { IS_WINDOWS, resolveBrowserBinary } from "./platform.mjs";

const execFileAsync = promisify(execFile);

function enabled(value) {
  return !["", "0", "false", "no"].includes(String(value ?? "").toLowerCase());
}

async function browserVersion(binary) {
  const { stdout, stderr } = await execFileAsync(binary, ["--version"], {
    timeout: 5000,
    windowsHide: true,
  });
  return String(stdout || stderr).trim().split(/\r?\n/, 1)[0] || "unknown";
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function taskSpaceSummary() {
  try {
    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    return {
      count: Array.isArray(state.spaces) ? state.spaces.length : 0,
      selectedId: state.selectedId ?? null,
    };
  } catch {
    return { count: 0, selectedId: null };
  }
}

function displayInfo(env, runtime) {
  if (runtime.headless || enabled(env.EGO_LINUX_HEADLESS)) {
    return { type: "headless", value: null, x11Fallback: null };
  }
  if (env.WAYLAND_DISPLAY) {
    return {
      type: "wayland",
      value: env.WAYLAND_DISPLAY,
      x11Fallback: env.DISPLAY || null,
    };
  }
  if (env.DISPLAY) {
    return { type: "x11", value: env.DISPLAY, x11Fallback: null };
  }
  return { type: "unknown", value: null, x11Fallback: null };
}

export async function collectDoctor({
  harnessPath,
  env = process.env,
  getBrowserStatus = browserStatus,
  findBrowser = resolveBrowserBinary,
  getBrowserVersion = browserVersion,
} = {}) {
  const issues = [];
  let binary = null;
  let version = null;
  try {
    binary = await findBrowser();
    version = await getBrowserVersion(binary);
  } catch (error) {
    issues.push(error?.message || "Chrome/Chromium was not found");
  }

  let status = {};
  try {
    status = await getBrowserStatus();
  } catch (error) {
    issues.push(`browser status failed: ${error?.message || error}`);
  }

  const harnessBuilt = Boolean(harnessPath) && (await exists(harnessPath));
  if (!harnessBuilt) issues.push(`harness build missing: ${harnessPath}`);

  const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
  if (nodeMajor < 22) issues.push(`Node.js 22+ required; found ${process.version}`);

  const runtime = {
    running: status.running === true,
    pid: status.pid ?? null,
    port: status.port ?? null,
    headless: status.headless === true,
    externalCdpConfigured: Boolean(env.EGO_LINUX_CDP_URL),
  };

  return {
    ok: issues.length === 0,
    timestamp: new Date().toISOString(),
    platform: { name: IS_WINDOWS ? "win32" : "linux", arch: process.arch },
    node: { version: process.version, supported: nodeMajor >= 22 },
    browser: { binary, version },
    runtime,
    display: displayInfo(env, runtime),
    harness: { path: harnessPath || null, built: harnessBuilt },
    paths: { profileDir: PROFILE_DIR, stateDir: STATE_DIR },
    taskSpaces: await taskSpaceSummary(),
    issues,
  };
}

function humanReport(report) {
  const runtime = report.runtime.running
    ? `running (pid ${report.runtime.pid}, port ${report.runtime.port})`
    : "stopped (the next browser command will start it)";
  const display = report.display.value
    ? `${report.display.type} (${report.display.value})`
    : report.display.type;
  const lines = [
    "ego-browser doctor",
    `Node.js:       ${report.node.version}`,
    `Browser:       ${report.browser.version || "not found"}`,
    `Browser path:  ${report.browser.binary || "not found"}`,
    `Harness:       ${report.harness.built ? "ready" : "missing"} (${report.harness.path})`,
    `Runtime:       ${runtime}`,
    `Display:       ${display}`,
    `Task Spaces:   ${report.taskSpaces.count} (selected: ${report.taskSpaces.selectedId ?? "none"})`,
  ];
  if (report.ok) lines.push("Result:        OK");
  else {
    lines.push("Result:        issues found");
    for (const issue of report.issues) lines.push(`  - ${issue}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runDoctor({ json = false, stdout = process.stdout, ...options } = {}) {
  const report = await collectDoctor(options);
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : humanReport(report));
  return report.ok ? 0 : 1;
}
