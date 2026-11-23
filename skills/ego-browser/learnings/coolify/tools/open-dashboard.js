/**
 * Open the Coolify Cloud dashboard and report auth state. URL-based detection:
 * an unauthenticated session is redirected to /login by Coolify itself.
 */
export async function openDashboard(ctx) {
  await ctx.openOrReuseTab("https://app.coolify.io", { wait: true });
  await ctx.waitForLoad().catch(() => {});
  const { url } = await ctx.pageInfo();
  const authenticated = !new URL(url).pathname.startsWith("/login");
  return { authenticated, url };
}
