// Locale-tolerant label sets. Facebook renders the UI in the *account's*
// language, not the browser's, so matching English alone silently fails on a
// Hungarian account. Extend these lists rather than special-casing at call sites.
const COMPOSER_TRIGGER_LABELS = [
  "write something",
  "create a public post",
  "start a discussion",
  "what's on your mind",
  "írj valamit",
  "hozzászólás írása",
  "beszélgetés indítása",
  "mi jár a fejedben",
];

const PUBLISH_LABELS = [
  "post",
  "publish",
  "közzététel",
  "bejegyzés",
  "küldés",
  "posztolás",
];

const COMPOSER_SELECTOR =
  'div[role="dialog"] div[role="textbox"][contenteditable="true"]';

// CDP modifier bit for Control (Alt=1, Control=2, Meta=4, Shift=8).
const CONTROL = 2;

/** Evaluate `fn(arg)` in the page; fn must be self-contained (no closure). */
function inPage(ctx, fn, arg) {
  return ctx.js(`(${fn})(${JSON.stringify(arg)})`);
}

function normalizeLabels(extra) {
  const list = Array.isArray(extra) ? extra : [];
  return list
    .filter((label) => typeof label === "string" && label.trim())
    .map((label) => label.trim().toLowerCase());
}

export async function postToGroup(ctx, args = {}) {
  const text = typeof args.text === "string" ? args.text : "";
  if (!text.trim()) {
    throw new Error("post_to_group requires a non-empty text argument");
  }
  const confirm = args.confirm === true;
  const publishLabels = [
    ...PUBLISH_LABELS,
    ...normalizeLabels(args.submitLabels),
  ];

  const { url } = await ctx.pageInfo();
  if (!url.includes("/groups/")) {
    return {
      status: "failed",
      draft: "",
      url,
      error: "not on a group page — navigate to the group feed first",
    };
  }

  // The composer may already be open from an earlier draft round in the same
  // task space; only click the trigger when it is not.
  const alreadyOpen = await inPage(
    ctx,
    (selector) => Boolean(document.querySelector(selector)),
    COMPOSER_SELECTOR,
  );
  if (!alreadyOpen) {
    const opened = await inPage(ctx, (labels) => {
      const norm = (value) =>
        (value || "").replace(/\s+/g, " ").trim().toLowerCase();

      // Only real buttons, and match on the *start* of the accessible name: a
      // container's innerText contains all of its descendants' text, so matching
      // loosely over every [aria-label] element hits role="main" before the
      // actual trigger. Shortest matching name wins for the same reason.
      let best = null;
      for (const el of document.querySelectorAll('[role="button"]')) {
        const name = norm(el.getAttribute("aria-label")) || norm(el.innerText);
        if (!name || !labels.some((label) => name.startsWith(label))) continue;
        if (!best || name.length < best.name.length) best = { el, name };
      }
      if (!best) return false;
      best.el.click();
      return true;
    }, COMPOSER_TRIGGER_LABELS);

    if (!opened) {
      return {
        status: "failed",
        draft: "",
        url,
        error:
          "composer trigger not found — the UI locale may need a label added to COMPOSER_TRIGGER_LABELS",
      };
    }
  }

  if (!(await ctx.waitForElement(COMPOSER_SELECTOR, { timeout: 15, visible: true }))) {
    return {
      status: "failed",
      draft: "",
      url,
      error: "composer did not become visible within 15 seconds",
    };
  }
  await ctx.click(COMPOSER_SELECTOR).catch(() => {});
  // A pointer click does not always leave focus in the contenteditable; key
  // input then goes to <body> and nothing is typed. Focus it explicitly and
  // check before typing.
  const focused = await inPage(
    ctx,
    (selector) => {
      const box = document.querySelector(selector);
      if (!box) return false;
      box.focus();
      return document.activeElement === box;
    },
    COMPOSER_SELECTOR,
  );
  if (!focused) {
    return {
      status: "failed",
      draft: "",
      url,
      error: "could not focus the composer",
    };
  }

  // A composer left open by an earlier round still holds its text, and typing
  // into it appends rather than replaces — that silently doubles a retried post.
  // Clearing a contenteditable programmatically is unreliable, so select-all +
  // delete through real key events.
  await ctx.pressKey("a", CONTROL);
  await ctx.pressKey("Delete");
  await ctx.wait(0.3);

  // Setting the DOM text does not fire the input events that arm the publish
  // button. Insert one character at a time through CDP input instead, the way
  // typing does.
  for (const character of text) {
    await ctx.typeText(character);
  }
  await ctx.wait(0.8);

  const draft = await inPage(
    ctx,
    (selector) => document.querySelector(selector)?.innerText ?? "",
    COMPOSER_SELECTOR,
  );

  if (!confirm) {
    return {
      status: "drafted",
      draft,
      // Facebook's editor drops a trailing period, so the draft can differ from
      // what was asked for. Surface that instead of letting it pass silently.
      matchesRequested: draft === text,
      url,
      note: "not published — re-run with confirm: true after a human reviews the draft",
    };
  }

  const clicked = await inPage(ctx, (labels) => {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return "no-dialog";

    for (const el of dialog.querySelectorAll('[role="button"]')) {
      const name = (
        el.getAttribute("aria-label") ||
        el.innerText ||
        ""
      )
        .trim()
        .toLowerCase();
      if (!name || !labels.some((label) => name === label)) continue;
      if (el.getAttribute("aria-disabled") === "true") return "disabled";
      el.click();
      return "clicked";
    }
    return "not-found";
  }, publishLabels);

  if (clicked !== "clicked") {
    return {
      status: "failed",
      draft,
      url,
      error: `publish button ${clicked} — draft left in the composer`,
    };
  }

  // The dialog unmounting is the only in-page signal that the post went through.
  let closed = false;
  for (let waited = 0; waited < 20 && !closed; waited += 0.5) {
    await ctx.wait(0.5);
    closed = await inPage(ctx, () => !document.querySelector('div[role="dialog"]'));
  }
  if (!closed) {
    return {
      status: "failed",
      draft,
      url,
      error:
        "composer stayed open after publish — check for a checkpoint or a group posting restriction",
    };
  }

  return { status: "posted", draft, url };
}
