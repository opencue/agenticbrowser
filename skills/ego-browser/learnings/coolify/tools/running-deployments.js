import { resolveInstance, apiGet } from "./coolify-api.js";

export async function runningDeployments(ctx, args = {}) {
  const instance = await resolveInstance(args.instance);
  const deployments = await apiGet(ctx, instance, "/deployments");
  return { count: deployments.length, deployments };
}
