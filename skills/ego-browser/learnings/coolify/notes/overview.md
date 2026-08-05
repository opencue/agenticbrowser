# Coolify Cloud — fleet deploy status

The fleet deploys through **Coolify Cloud** (`app.coolify.io`, v4): every shop
backend, service and cron-runner is a Coolify application on servers the cloud
control plane manages. This pack answers the everyday questions — what is
deployed, is anything deploying right now, are the servers healthy — without a
single dashboard snapshot.

## Auth model — two separate credentials

- **The dashboard session** (browser) authenticates the UI only. Verified: the
  session cookie does **not** authorize `/api/v1/...` — those answer
  `401 Unauthenticated` from the page context. So unlike packs whose site API
  rides the page session (see `medusa-admin`), data tools here cannot go
  through the browser.
- **The API token** authenticates `/api/v1`. The tools read the user's own
  Coolify CLI config (`~/.config/coolify/config.json`, written by
  `coolify config`) at runtime and send its Bearer token to its own instance —
  the pack itself stores no secrets. A 401/expired token → mint a new one at
  `app.coolify.io/security/api-tokens` and update the CLI config.

The config may hold several instances; every data tool takes an optional
`instance` (name) arg and defaults to the config's default instance. Stale
entries happen — a dead VPS entry was found in practice — so an unreachable
instance is a config problem, not a pack problem.

## Verified endpoints (live, v4.1.2, 2026-08-05)

- `GET /api/v1/applications` — 200, full fleet list
- `GET /api/v1/applications/{uuid}` — 200, detail incl. git + build fields
- `GET /api/v1/deployments` — 200, running/queued only (empty when idle)
- `GET /api/v1/servers` — 200, incl. `is_reachable` / `is_usable`

## Recommended flow

1. `site.runTool('coolify', 'list_servers', {})` — fleet health in one call.
2. `site.runTool('coolify', 'list_applications', {})` — what exists and its
   status; `app_status` with a name substring for one app's detail.
3. `site.runTool('coolify', 'running_deployments', {})` — poll this after
   triggering a deploy elsewhere (git push / webhook / CLI).
4. `open_dashboard` only when actual UI work follows (editing env vars,
   reading build logs visually); the dashboard is Livewire-heavy, so prefer
   the tools for reading and the UI for mutating.

v1 is deliberately **read-only**: restarts, env-var edits and deploy triggers
stay in the dashboard UI or the `coolify` CLI, where the user confirms them.
