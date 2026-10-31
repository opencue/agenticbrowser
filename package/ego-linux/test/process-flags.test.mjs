import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the module's paths at a sandbox before importing it, like the other
// suites. ensureBrowser() below has to find the stand-in, not an endpoint a
// caller attached through EGO_LINUX_CDP_URL.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-process-flags-"));
const PROFILE = join(SANDBOX, "agent's profile with spaces");
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_PROFILE = PROFILE;
delete process.env.EGO_LINUX_CDP_URL;

// Profiles the stand-ins name besides PROFILE.
const IGNORED = join(SANDBOX, "ignored profile");
const FOREIGN = join(SANDBOX, "foreign profile");
// The stand-ins carry the managed --class marker. Another suite running in
// parallel calls the machine-wide reapOrphanedBrowsers(), which kills a marked
// process whose profile directory is missing: the stand-in dies before it is
// ready, or ensureBrowser() launches a real browser here. Existing profile
// directories keep every stand-in out of the reaper's scope.
for (const dir of [PROFILE, IGNORED, FOREIGN]) {
  await mkdir(dir, { recursive: true });
}

const { BROWSER_STATE_FILE, STATE_DIR } = await import("../src/paths.mjs");
const { browserStatus, ensureBrowser, unsafeBrowserLaunchFlags } =
  await import("../src/chrome.mjs");
const { listProcesses, processArgv, terminateProcess } =
  await import("../src/platform.mjs");
const STANDIN = join(SANDBOX, "browser-standin.mjs");
await writeFile(
  STANDIN,
  "if (process.env.EGO_TEST_PROCESS_TITLE) process.title = process.env.EGO_TEST_PROCESS_TITLE;\n" +
    'process.stdout.write("ready\\n");\nsetInterval(() => {}, 1000);\n',
);
await mkdir(STATE_DIR, { recursive: true });

let requests = 0;
const server = createServer((_request, response) => {
  requests += 1;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/managed`,
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  // Should a stand-in vanish anyway, ensureBrowser() has launched a real
  // browser on PROFILE: stop it rather than leave it running.
  for (const { pid, argv } of await listProcesses({
    contains: `--user-data-dir=${PROFILE}`,
  })) {
    const text = argv.join(" ");
    if (text.includes("--class=ego-lite-linux") && !/(^|\s)--type=/.test(text))
      await terminateProcess(pid);
  }
  await rm(SANDBOX, { recursive: true, force: true });
});

async function standin(t, args, title = "") {
  const child = spawn(
    process.execPath,
    [STANDIN, ...args, ...(title ? ["x".repeat(title.length)] : [])],
    {
      env: { ...process.env, EGO_TEST_PROCESS_TITLE: title },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  // A stand-in killed before it is ready fails the test instead of hanging it.
  let onExit;
  const died = new Promise((_resolve, reject) => {
    onExit = (code, signal) =>
      reject(
        new Error(`stand-in exited before it was ready (${code ?? signal})`),
      );
    child.once("exit", onExit);
  });
  try {
    await Promise.race([once(child.stdout, "data"), died]);
  } finally {
    child.off("exit", onExit);
  }
  // A rejection below proves nothing unless the stand-in's argv was readable.
  assert.match(
    (await processArgv(child.pid))?.join(" ") ?? "",
    /--class=ego-lite-linux/,
    "the stand-in's command line can be read",
  );
  await writeFile(
    BROWSER_STATE_FILE,
    JSON.stringify({ pid: child.pid, port: PORT }),
  );
  return child;
}

test("managed browser status uses the final profile and debugging-port switches", async (t) => {
  const child = await standin(t, [
    `--user-data-dir=${IGNORED}`,
    "--remote-debugging-port=1",
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--class=ego-lite-linux",
  ]);

  const status = await browserStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, child.pid);
  assert.equal(status.port, PORT);
  assert.equal((await ensureBrowser()).launched, false);
});

test(
  "rewritten Chrome process titles keep final switches and profile paths with spaces or quotes",
  { skip: process.platform === "win32" },
  async (t) => {
    await standin(
      t,
      [],
      `chrome --user-data-dir=${IGNORED} --remote-debugging-port=1 ` +
        `--user-data-dir=${PROFILE} --remote-debugging-port=${PORT} ` +
        "--class=ego-lite-linux about:blank",
    );

    const status = await browserStatus();
    assert.equal(status.running, true);
    assert.equal(status.port, PORT);
  },
);

test("a later foreign profile switch defeats an earlier matching profile", async (t) => {
  await standin(t, [
    `--user-data-dir=${PROFILE}`,
    `--user-data-dir=${FOREIGN}`,
    `--remote-debugging-port=${PORT}`,
    "--class=ego-lite-linux",
  ]);
  const before = requests;
  assert.equal((await browserStatus()).running, false);
  assert.equal(requests, before, "a foreign profile endpoint is never probed");
});

test("flag text embedded in another argument cannot impersonate the managed profile", async (t) => {
  await standin(t, [
    `--note=other value --user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--class=ego-lite-linux",
  ]);
  const before = requests;
  assert.equal((await browserStatus()).running, false);
  assert.equal(requests, before, "embedded profile text proves no ownership");
});

test("flag text embedded in another argument cannot impersonate the managed class", async (t) => {
  await standin(t, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--note=other value --class=ego-lite-linux",
  ]);
  const before = requests;
  assert.equal((await browserStatus()).running, false);
  assert.equal(requests, before, "embedded class text proves no ownership");
});

test("switches after a bare -- do not count", async (t) => {
  const args = [
    `--user-data-dir=${FOREIGN}`,
    `--remote-debugging-port=${PORT}`,
    "--class=ego-lite-linux",
    "--",
    `--user-data-dir=${PROFILE}`,
  ];
  const cases = [[args, ""]];
  // Rewriting the title does not change the command line on Windows.
  if (process.platform !== "win32")
    cases.push([[], `chrome ${args.join(" ")}`]);
  for (const [argv, title] of cases) {
    await standin(t, argv, title);
    const before = requests;
    assert.equal((await browserStatus()).running, false);
    assert.equal(requests, before, "a profile after -- proves no ownership");
  }
});

test("duplicate switches do not relax the conservative unsafe-launch policy", () => {
  for (const addresses of [
    ["0.0.0.0", "127.0.0.1"],
    ["127.0.0.1", "0.0.0.0"],
  ]) {
    const args = addresses.map(
      (value) => `--remote-debugging-address=${value}`,
    );
    assert.deepEqual(unsafeBrowserLaunchFlags(args), [
      "--remote-debugging-address",
    ]);
    assert.deepEqual(unsafeBrowserLaunchFlags([`chrome ${args.join(" ")}`]), [
      "--remote-debugging-address",
    ]);
  }
  assert.deepEqual(
    unsafeBrowserLaunchFlags(["--proxy-server=unsafe", "--proxy-server="]),
    ["--proxy-server"],
  );
});
