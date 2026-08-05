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

  await ctx.browser.openOrReuseTab(`https://${domain}/app/orders`, { wait: true });
  await ctx.page.waitForLoadState("load").catch(() => {});
  // The SPA decides about the session after load; give the redirect a moment.
  await ctx.page
    .waitForURL((url) => url.pathname.startsWith("/app"), { timeout: 15000 })
    .catch(() => {});

  const url = await ctx.page.url();
  const authenticated = !new URL(url).pathname.startsWith("/app/login");
  return { authenticated, url };
}
