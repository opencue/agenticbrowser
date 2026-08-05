import { resolveInstance, apiGet } from "./coolify-api.js";

export async function listServers(ctx, args = {}) {
  const instance = await resolveInstance(args.instance);
  const servers = await apiGet(ctx, instance, "/servers");
  return {
    count: servers.length,
    servers: servers.map((s) => ({
      uuid: s.uuid,
      name: s.name,
      ip: s.ip,
      is_reachable: s.is_reachable ?? null,
      is_usable: s.is_usable ?? null,
    })),
  };
}
