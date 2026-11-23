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
 *    `site.`, `fetch.server` / `fetch.browser`, or a `page.` it never declares
 *    (in v2, `page` is always a local such as `const page = task.page("p1")`).
 *    `cdp(` is no signal: both runtimes have it.
 * 4. Everything else is v2.
 *
 * Comments and string contents are blanked first, so `// was taskSpaces.run`
 * or `console.log("open the site.")` does not decide anything.
 */
const V2_MARKER =
  /(?<![\w$.])(?:taskSpace|profiles|claimTaskSpace|takeOverTaskSpace|listTaskSpaces)\s*\(/;
const V1_GLOBAL =
  /(?<![\w$.])(?:taskSpaces\b|(?:browser|site)\s*\??\.|fetch\s*\??\.\s*(?:server|browser)\b)/;
const PAGE_USE = /(?<![\w$.])page\s*\??\./;
const PAGE_DECLARED = [
  /\b(?:const|let|var)\s+page\b/,
  /\b(?:const|let|var)\s*\{[^}]*\bpage\b[^}]*\}/,
  /\b(?:const|let|var)\s*\[[^\]]*\bpage\b[^\]]*\]/,
  /\bfunction\b[^(]*\([^)]*\bpage\b[^)]*\)/,
  /\(\s*(?:[\w$]+\s*,\s*)*page\s*(?:,[^)]*)?\)\s*=>/,
  /(?<![\w$.])page\s*=>/,
];

/**
 * Blank out comments and the text of string and template literals, keeping
 * `${...}` expressions and every newline. Regex literals are not recognised;
 * a `/` that does not start a comment is copied as code.
 */
export function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  // Stack of open template literals; each entry counts `{` depth inside the
  // current `${...}` so the matching `}` returns to template text.
  const templates = [];
  const blank = (text) => text.replace(/[^\n]/g, " ");
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    const inTemplateText = templates.length > 0 && templates.at(-1) === -1;
    if (inTemplateText) {
      if (ch === "\\") {
        out += blank(source.slice(i, i + 2));
        i += 2;
      } else if (ch === "`") {
        templates.pop();
        out += ch;
        i += 1;
      } else if (ch === "$" && next === "{") {
        templates[templates.length - 1] = 0;
        out += "${";
        i += 2;
      } else {
        out += blank(ch);
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      const stop = Math.min(j + 1, n);
      out +=
        ch +
        blank(source.slice(i + 1, stop - 1)) +
        (source[stop - 1] === ch ? ch : "");
      i = stop;
    } else if (ch === "`") {
      templates.push(-1);
      out += ch;
      i += 1;
    } else if (templates.length > 0 && ch === "{") {
      templates[templates.length - 1] += 1;
      out += ch;
      i += 1;
    } else if (templates.length > 0 && ch === "}") {
      if (templates.at(-1) === 0) templates[templates.length - 1] = -1;
      else templates[templates.length - 1] -= 1;
      out += ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function usesUndeclaredPage(code) {
  return PAGE_USE.test(code) && !PAGE_DECLARED.some((re) => re.test(code));
}

export function selectRuntime(script, env = process.env) {
  const forced = (env.EGO_BROWSER_RUNTIME ?? "").trim().toLowerCase();
  if (forced === "v1" || forced === "v2") return forced;
  const code = stripCommentsAndStrings(script);
  if (V2_MARKER.test(code)) return "v2";
  if (V1_GLOBAL.test(code) || usesUndeclaredPage(code)) return "v1";
  return "v2";
}
