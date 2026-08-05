import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve a Coolify instance from the user's own CLI config
 * (~/.config/coolify/config.json) — the pack stores no secrets; the token
 * stays on disk and is only ever sent to its own instance.
 */
export async function resolveInstance(name) {
  let config;
  try {
    config = JSON.parse(
      await readFile(join(homedir(), ".config", "coolify", "config.json"), "utf8"),
    );
  } catch (error) {
    throw new Error(
      "cannot read ~/.config/coolify/config.json — install/configure the coolify CLI first: " +
        error.message,
    );
  }
  const instances = Array.isArray(config?.instances) ? config.instances : [];
  const instance = name
    ? instances.find((i) => i.name === name)
    : instances.find((i) => i.default) || instances[0];
  if (!instance?.fqdn || !instance?.token) {
    throw new Error(
      name
        ? `no instance named ${JSON.stringify(name)} in the coolify CLI config`
        : "no usable default instance in the coolify CLI config",
    );
  }
  return instance;
}

/**
 * GET a Coolify API path as parsed JSON. Uses the harness's Node-side fetch
 * (ctx.fetch.server) — the runtime replaces globalThis.fetch with its own
 * facade object inside tool modules, so bare fetch() is not available here.
 */
export async function apiGet(ctx, instance, path) {
  const base = instance.fqdn.replace(/\/+$/, "");
  let body;
  try {
    body = await ctx.fetch.server(`${base}/api/v1${path}`, {
      headers: {
        Authorization: `Bearer ${instance.token}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    const status = /HTTP (\d+)/.exec(String(error?.message || ""))?.[1];
    if (status === "401") {
      throw new Error(
        `Coolify API ${path} answered 401 — the token is invalid or expired; mint a new one at ${base}/security/api-tokens and update the coolify CLI config`,
      );
    }
    throw error;
  }
  return JSON.parse(body);
}
