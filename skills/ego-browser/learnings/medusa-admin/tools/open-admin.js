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

  await ctx.openOrReuseTab(`https://${domain}/app/orders`, { wait: true });
  await ctx.waitForLoad().catch(() => {});
  // The SPA decides about the session after load; give the redirect a moment.
  let { url } = await ctx.pageInfo();
  for (let waited = 0; waited < 15 && !new URL(url).pathname.startsWith("/app"); waited += 0.25) {
    await ctx.wait(0.25);
    ({ url } = await ctx.pageInfo());
  }

  const authenticated = !new URL(url).pathname.startsWith("/app/login");
  return { authenticated, url };
}
