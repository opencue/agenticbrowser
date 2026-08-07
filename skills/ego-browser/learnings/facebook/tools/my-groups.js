function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function listMyGroups(ctx, args = {}) {
  const maxGroups = boundedInteger(args.maxGroups, 50, 200);

  const url = await ctx.page.url();
  if (!/facebook\.com\/groups\/joins/.test(url)) {
    await ctx.page.goto("https://www.facebook.com/groups/joins", {
      waitUntil: "load",
    });
  }

  // The joins list is virtualized like every other Facebook feed.
  for (let round = 0; round < 4; round += 1) {
    await ctx.page.mouse.wheel(0, 1800);
    await ctx.page.waitForTimeout(1200);
  }

  return ctx.page.evaluate((limit) => {
    // Nav chrome lives under /groups/ too — these are not joined groups.
    const reserved = new Set([
      "feed",
      "joins",
      "discover",
      "create",
      "search",
      "your_groups",
    ]);
    const seen = new Map();

    for (const anchor of document.querySelectorAll('a[href*="/groups/"]')) {
      const href = anchor.getAttribute("href") || "";
      const match = href.match(/\/groups\/([^/?#]+)/);
      if (!match) continue;
      const groupId = match[1];
      if (reserved.has(groupId)) continue;
      if (seen.has(groupId)) continue;

      const name = (anchor.innerText || "").trim().split("\n")[0];
      if (!name) continue;

      seen.set(groupId, {
        name,
        groupId,
        url: `https://www.facebook.com/groups/${groupId}`,
      });
      if (seen.size >= limit) break;
    }

    return [...seen.values()];
  }, maxGroups);
}
