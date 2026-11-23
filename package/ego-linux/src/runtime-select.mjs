/**
 * Two harness runtimes ship side by side:
 *
 * - v2 (`package/ego-browser-v2`): upstream's page-model runtime —
 *   `const task = await taskSpace(name); task.page("p1").goto(...)`. The
 *   default.
 * - v1 (`package/ego-browser`): this project's original API — `page`,
 *   `browser`, `taskSpaces`, `site` globals with Playwright-style locators.
 *   Kept so existing scripts keep working.
 *
 * Order of decision:
 * 1. `EGO_BROWSER_RUNTIME=v1|v2` wins.
 * 2. A call to a v2 entry point (`taskSpace(`, `profiles(`, `claimTaskSpace(`,
 *    `takeOverTaskSpace(`, `listTaskSpaces(`) is v2; none of them exists in v1.
 * 3. A script that uses a v1-only global is v1: `taskSpaces`, `browser.`,
 *    `site.`, or a `page.` it never declares (in v2, `page` is always a local
 *    such as `const page = task.page("p1")`).
 * 4. Everything else is v2.
 */
const V2_MARKER =
  /(?<![\w$.])(?:taskSpace|profiles|claimTaskSpace|takeOverTaskSpace|listTaskSpaces)\s*\(/;
const V1_GLOBAL = /(?<![\w$.])(?:taskSpaces\b|(?:browser|site)\s*\.)/;
const PAGE_USE = /(?<![\w$.])page\s*\./;
const PAGE_DECLARED = [
  /\b(?:const|let|var)\s+page\b/,
  /\b(?:const|let|var)\s*\{[^}]*\bpage\b[^}]*\}/,
  /\bfunction\b[^(]*\([^)]*\bpage\b[^)]*\)/,
  /\(\s*(?:[\w$]+\s*,\s*)*page\s*(?:,[^)]*)?\)\s*=>/,
  /(?<![\w$.])page\s*=>/,
];

function usesUndeclaredPage(script) {
  return PAGE_USE.test(script) && !PAGE_DECLARED.some((re) => re.test(script));
}

export function selectRuntime(script, env = process.env) {
  const forced = (env.EGO_BROWSER_RUNTIME ?? "").trim().toLowerCase();
  if (forced === "v1" || forced === "v2") return forced;
  if (V2_MARKER.test(script)) return "v2";
  if (V1_GLOBAL.test(script) || usesUndeclaredPage(script)) return "v1";
  return "v2";
}
