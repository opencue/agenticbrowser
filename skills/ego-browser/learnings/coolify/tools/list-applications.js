import { resolveInstance, apiGet } from "./coolify-api.js";

export async function listApplications(ctx, args = {}) {
  const instance = await resolveInstance(args.instance);
  const apps = await apiGet(ctx, instance, "/applications");
  const applications = apps.map((a) => ({
    uuid: a.uuid,
    name: a.name,
    fqdn: a.fqdn ?? null,
    status: a.status ?? null,
  }));
  return { count: applications.length, applications };
}
