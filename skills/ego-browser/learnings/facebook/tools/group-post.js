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

  const url = await ctx.page.url();
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
  const alreadyOpen = await ctx.page.locator(COMPOSER_SELECTOR).count();
  if (!alreadyOpen) {
    const opened = await ctx.page.evaluate((labels) => {
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

  const composer = ctx.page.locator(COMPOSER_SELECTOR);
  await composer.waitFor({ state: "visible", timeout: 15000 });
  await composer.click();

  // A composer left open by an earlier round still holds its text, and typing
  // into it appends rather than replaces — that silently doubles a retried post.
  // clear() does not reliably empty a contenteditable, so select-all + delete.
  await ctx.page.keyboard.press("Control+a");
  await ctx.page.keyboard.press("Delete");
  await ctx.page.waitForTimeout(300);

  // fill() injects text without firing the React input events that enable the
  // publish button. Typing is slower but is what actually arms the composer.
  await composer.pressSequentially(text);
  await ctx.page.waitForTimeout(800);

  const draft = await composer.innerText();

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

  const clicked = await ctx.page.evaluate((labels) => {
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
  try {
    await ctx.page.waitForFunction(
      () => !document.querySelector('div[role="dialog"]'),
      { timeout: 20000 },
    );
  } catch {
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
