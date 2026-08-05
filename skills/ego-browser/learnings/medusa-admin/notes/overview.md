# Medusa Admin — self-hosted shops

Every shop in this fleet runs a Medusa v2 backend behind Traefik with the admin
dashboard at `https://admin.<shop>.hu/app`. The admin is one and the same React
SPA across all shops, so this pack applies fleet-wide; only the domain differs.

**Verification status**: built and verified against `admin.teherguminet.hu`
(live, `/health` answers 200). The other domains share the deployment template
(`medusa-shops/base-template`), but were not individually exercised — if one
misbehaves, verify its `/health` endpoint first; the VPS may be down or the
domain may have moved.

## Auth model — what the tools rely on

- Unauthenticated visits to any `/app/...` route are **redirected to
  `/app/login`** by the SPA. `open_admin` uses exactly this: URL-based
  detection, no login-form selectors to rot.
- Login is manual, once: the agent hands the task space to the user
  (`taskSpaces.handOff`), the user signs in, and the session cookie persists in
  the agent browser profile across heredoc rounds and browser restarts. Do not
  automate credential entry.
- After login, the page context carries the session, so `fetch` from inside the
  page (`credentials: 'include'`) is authenticated. All data tools use this.

## API over DOM — why the tools fetch instead of scraping

The admin SPA renders virtualized tables whose class names rotate between
Medusa releases. The admin REST API (`/admin/orders`, `/admin/products`,
`/admin/users/me`) is versioned, stable, and returns exactly the fields asked
for via the `fields` parameter. A tool call therefore returns compact JSON
instead of a snapshot of a table — cheaper and it cannot break on a restyle.

Measured on the live `/app/orders` page (20 orders): `page.snapshot()` is
30,803 chars (~7.7k tokens); `list_orders` returns the same information in
4,644 chars (~1.2k tokens) — an **85% saving** on every observation round.

One sharp edge the tools guard against: a browser tool runs on whatever page
is active, and at the start of a fresh heredoc round that can be a blank
context where relative `fetch` URLs cannot resolve. Each tool checks
`location.protocol` and returns a clear "run open_admin first" error instead
of a TypeError — so always call `open_admin` before the data tools.

Endpoints used:

- `GET /admin/users/me` — session probe (`whoami`); non-OK means signed out.
- `GET /admin/orders?limit=&offset=&order=-created_at&fields=...` — recent
  orders, newest first (`list_orders`).
- `GET /admin/products?q=&limit=&fields=...` — product search by title/handle
  (`search_products`).

## Recommended flow

1. `site.runTool('medusa-admin', 'open_admin', { domain: 'admin.<shop>.hu' })`
2. If `authenticated: false` → hand off to the user to log in, then re-run 1.
3. `site.runBrowserTool('medusa-admin', 'list_orders', { limit: 10 })` or
   `search_products` — no snapshot round needed for the data itself.

Use `page.snapshot()` only when actually operating the UI (editing an order,
fulfilling, refunding), not for reading lists these tools already return.
