function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

/**
 * Facebook renders a post's timestamp anchor — the only place the real permalink
 * and the absolute date exist — lazily, on hover. Without this pass most cards
 * come back with no permalink at all. Synthetic mouseover events are not enough;
 * React only trusts a real CDP input event, so this hovers for real.
 */
async function materializePermalinks(ctx, maxCards) {
  for (let i = 0; i < maxCards; i += 1) {
    // Bring card i's author name on screen and report where it is, or null when
    // there is no such card, it is chrome rather than a post, or it was already
    // materialized on an earlier round (don't pay for it twice).
    const point = await ctx.js(`(${(index) => {
      const card = document.querySelectorAll('div[role="feed"] > div')[index];
      if (!card) return { done: true };
      const name = card.querySelector('[data-ad-rendering-role="profile_name"]');
      if (!name || card.querySelector('a[href*="/posts/"]')) return null;
      name.scrollIntoView({ block: "center" });
      const rect = name.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }})(${i})`);
    if (point?.done) break;
    if (!point) continue;
    try {
      await ctx.hover(point);
    } catch {
      // Card unmounted mid-pass — skip it.
    }
  }
  await ctx.wait(1.2);
}

export async function getGroupPosts(ctx, args = {}) {
  const maxPosts = boundedInteger(args.maxPosts, 20, 100);
  const scrollRounds = boundedInteger(args.scrollRounds, 3, 15);

  // Feed children mount and unmount as they scroll, so collect across rounds and
  // merge rather than extracting once at the end.
  const collected = new Map();

  for (let round = 0; round <= scrollRounds; round += 1) {
    await materializePermalinks(ctx, 12);

    const batch = await ctx.js(`(${() => {
        const cards = [...document.querySelectorAll('div[role="feed"] > div')];
        // Facebook interleaves invisible joiners into some text runs to break
        // naive scraping; strip them so the text compares and reads normally.
        const clean = (value) =>
          (value || "")
            .replace(/[\u034f\u200b-\u200d\ufeff]/g, "")
            .replace(/\u00a0/g, " ")
            .trim();

        const role = (el, name) =>
          el.querySelector(`[data-ad-rendering-role="${name}"]`);

        return cards
          .map((el) => {
            // A feed child without a story_message is chrome (the sort header)
            // or a virtualized placeholder, not a post.
            const messageNode = role(el, "story_message");
            if (!messageNode) return null;

            const permalinkNode =
              el.querySelector('a[href*="/posts/"]') ||
              el.querySelector('a[href*="/permalink/"]');

            // The href carries tracking params and, when a comment is deep
            // linked, a comment_id — strip the query for a stable identity.
            const permalink = permalinkNode
              ? permalinkNode.href.split("?")[0]
              : "";

            const authorNode = role(el, "profile_name");
            const authorLink = authorNode?.querySelector("a[href]");

            return {
              author: clean(authorNode?.innerText).split("\n")[0] || "",
              authorUrl: authorLink ? authorLink.href.split("?")[0] : "",
              text: clean(messageNode.innerText),
              permalink,
              // Link text is relative ("14m"); its aria-label is absolute.
              timestamp: clean(permalinkNode?.innerText),
              timestampAbsolute:
                permalinkNode?.getAttribute("aria-label") || "",
            };
          })
          .filter(Boolean);
      }})()`);

    for (const post of batch) {
      if (!post.text && !post.permalink) continue;
      // Text identity, not permalink, is the dedupe key: a card whose hover pass
      // lost the race has no permalink, and keying on it would double-count.
      const key = `${post.author}::${post.text.slice(0, 120)}`;
      const existing = collected.get(key);
      if (!existing) {
        collected.set(key, post);
      } else if (!existing.permalink && post.permalink) {
        collected.set(key, post);
      }
    }

    if (collected.size >= maxPosts || round === scrollRounds) break;

    await ctx.scrollBy(1800);
    await ctx.wait(1.5);
  }

  return [...collected.values()].slice(0, maxPosts);
}
