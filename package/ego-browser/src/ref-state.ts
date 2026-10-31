import { parseRef, RefMap } from "./ref-map.js";

export const browserRefMap = new RefMap();

let ensuring: Promise<unknown> | null = null;
let snapshotImpl: (() => Promise<unknown>) | null = null;

export function registerSnapshotForRefRefresh(fn: () => Promise<unknown>) {
  snapshotImpl = fn;
}

export async function ensureRefMapForRef(selectorOrRef: unknown) {
  if (typeof selectorOrRef !== "string") return;
  if (!parseRef(selectorOrRef)) return;
  if (ensuring) {
    await ensuring;
    return;
  }
  if (browserRefMap.map.size > 0) return;
  if (!snapshotImpl) return;
  ensuring = Promise.resolve().then(snapshotImpl);
  try {
    await ensuring;
  } finally {
    ensuring = null;
  }
}
