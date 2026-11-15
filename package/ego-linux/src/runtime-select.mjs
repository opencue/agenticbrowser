/**
 * Two harness runtimes ship side by side:
 *
 * - v1 (`package/ego-browser`): this project's API — `page`, `browser`,
 *   `taskSpaces`, `site`, `fetch` globals with Playwright-style locators. The
 *   default, so every existing script keeps working.
 * - v2 (`package/ego-browser-v2`): upstream's page-model runtime —
 *   `const task = await taskSpace(name); task.page("p1").goto(...)`.
 *
 * A script opts into v2 by calling `taskSpace(` or `profiles(`; neither name
 * exists in v1 (`taskSpaces` does, and `\b` keeps it from matching).
 * `EGO_BROWSER_RUNTIME=v1|v2` overrides the detection.
 */
const V2_MARKER = /(?<![\w$.])(?:taskSpace|profiles)\s*\(/;

export function selectRuntime(script, env = process.env) {
  const forced = (env.EGO_BROWSER_RUNTIME ?? "").trim().toLowerCase();
  if (forced === "v1" || forced === "v2") return forced;
  return V2_MARKER.test(script) ? "v2" : "v1";
}
