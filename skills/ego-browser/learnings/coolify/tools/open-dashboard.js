/**
 * Open the Coolify Cloud dashboard and report auth state. URL-based detection:
 * an unauthenticated session is redirected to /login by Coolify itself.
 */
export async function openDashboard(ctx) {
  // origin match: a tab already on /dashboard or /login is the same app.
  await ctx.openOrReuseTab("https://app.coolify.io", { wait: true, match: "origin" });
  await ctx.waitForLoad().catch(() => {});
  const { url, dialog } = await ctx.pageInfo();
  if (!url) {
    throw new Error(`a JavaScript dialog is blocking the page: ${JSON.stringify(dialog ?? null)}`);
  }
  const authenticated = !new URL(url).pathname.startsWith("/login");
  return { authenticated, url };
}
