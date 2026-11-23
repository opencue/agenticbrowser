/**
 * Open a shop's Medusa admin and report the auth state.
 *
 * Detection is URL-based on purpose: an unauthenticated session is redirected
 * to /app/login by the admin SPA itself, which is more durable than any DOM
 * selector on a login form that may be restyled.
 */
export async function openAdmin(ctx, args = {}) {
  const domain = String(args.domain || "").trim();
  if (!domain || domain.includes("/")) {
    throw new Error("domain must be a bare hostname, e.g. admin.teherguminet.hu");
  }

  // origin match: a tab already on another admin page (or /app/login) is reused.
  await ctx.openOrReuseTab(`https://${domain}/app/orders`, { wait: true, match: "origin" });
  await ctx.waitForLoad().catch(() => {});
  // The SPA decides about the session after load; give the redirect a moment.
  let { url, dialog } = await ctx.pageInfo();
  for (let waited = 0; waited < 15 && url && !new URL(url).pathname.startsWith("/app"); waited += 0.25) {
    await ctx.wait(0.25);
    ({ url, dialog } = await ctx.pageInfo());
  }
  if (!url) {
    throw new Error(`a JavaScript dialog is blocking the page: ${JSON.stringify(dialog ?? null)}`);
  }

  const authenticated = !new URL(url).pathname.startsWith("/app/login");
  return { authenticated, url };
}
