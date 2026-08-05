import { resolveInstance, apiGet } from "./coolify-api.js";

export async function appStatus(ctx, args = {}) {
  const query = String(args.app || "").trim();
  if (!query) throw new Error("app (uuid or name substring) is required");
  const instance = await resolveInstance(args.instance);

  const apps = await apiGet(ctx, instance, "/applications");
  let target = apps.find((a) => a.uuid === query);
  if (!target) {
    const matches = apps.filter((a) =>
      (a.name || "").toLowerCase().includes(query.toLowerCase()),
    );
    if (matches.length !== 1) {
      return {
        error: matches.length === 0 ? "no application matches" : "name is ambiguous",
        matches: matches.map((a) => ({ uuid: a.uuid, name: a.name })),
      };
    }
    target = matches[0];
  }

  const app = await apiGet(ctx, instance, `/applications/${target.uuid}`);
  return {
    uuid: app.uuid,
    name: app.name,
    status: app.status ?? null,
    fqdn: app.fqdn ?? null,
    git_repository: app.git_repository ?? null,
    git_branch: app.git_branch ?? null,
    build_pack: app.build_pack ?? null,
    updated_at: app.updated_at ?? null,
  };
}
