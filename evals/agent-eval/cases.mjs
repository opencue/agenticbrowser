const DISPLAY_NAME = "Ada Lovelace";

export const EVAL_CASES = [
  {
    id: "semantic-form",
    title: "Semantic form completion",
    route: "/semantic-form",
    task:
      `Fill the Display name field with ${JSON.stringify(DISPLAY_NAME)}, enable ` +
      '"Product updates", save the form, and verify that the page reports "Saved".',
    score({ state }) {
      return checks({
        saved: state.saved === true,
        displayName: state.displayName === DISPLAY_NAME,
        productUpdates: state.productUpdates === true,
      });
    },
  },
  {
    id: "dynamic-rerender",
    title: "Dynamic DOM re-render recovery",
    route: "/dynamic-rerender",
    task:
      'Click "Load next step", wait for the DOM to re-render, click ' +
      '"Confirm generated item", and verify that the page reports "Complete".',
    score({ state }) {
      return checks({ confirmed: state.confirmed === true });
    },
  },
  {
    id: "viewport-extract",
    title: "Viewport-first extraction",
    route: "/viewport-extract",
    task:
      "Read the verification code visible near the top of the page and include " +
      "the exact code in your final answer. Do not modify the page.",
    score({ state, finalText }) {
      return checks({
        codeReported:
          typeof state.code === "string" && finalText.includes(state.code),
      });
    },
  },
  {
    id: "new-tab",
    title: "New-tab observation",
    route: "/new-tab",
    task:
      'Open the "Open target report" link, switch to the resulting tab if needed, ' +
      "read the target report code, and include the exact code in your final answer.",
    score({ state, finalText }) {
      return checks({
        targetVisited: state.targetVisited === true,
        codeReported:
          typeof state.targetCode === "string" &&
          finalText.includes(state.targetCode),
      });
    },
  },
];

export function selectedCases(ids = []) {
  if (ids.length === 0) return EVAL_CASES;
  const wanted = new Set(ids);
  const found = EVAL_CASES.filter((testCase) => wanted.has(testCase.id));
  const missing = [...wanted].filter(
    (id) => !EVAL_CASES.some((testCase) => testCase.id === id),
  );
  if (missing.length > 0) {
    throw new Error(`Unknown eval case(s): ${missing.join(", ")}`);
  }
  return found;
}

export function expectedState(caseId, runId) {
  const suffix = runId
    .replace(/[^a-z0-9]/gi, "")
    .slice(-8)
    .toUpperCase();
  if (caseId === "viewport-extract") {
    return { code: `EGO-VIEW-${suffix}` };
  }
  if (caseId === "new-tab") {
    return { targetCode: `EGO-TARGET-${suffix}` };
  }
  return {};
}

function checks(values) {
  return {
    ok: Object.values(values).every(Boolean),
    checks: values,
  };
}
