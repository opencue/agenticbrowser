import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

type PersistPayload = PersistShape;

function mkTempPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

export type AtomicPersistHooks = {
  /** Deterministic failpoint for crash-safety tests. */
  beforeRename?: (tmpPath: string, targetPath: string) => Promise<void>;
};

export async function writePersistAtomically(
  path: string,
  payload: PersistPayload,
  hooks: AtomicPersistHooks = {},
): Promise<void> {
  const tmpPath = mkTempPath(path);
  const text = JSON.stringify(payload, null, 2);
  const handle = await open(tmpPath, "wx", 0o600);
  let handleOpen = true;
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handleOpen = false;
    await hooks.beforeRename?.(tmpPath, path);
    await rename(tmpPath, path);

    // Persist the new directory entry as well as the file contents.
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (err) {
    if (handleOpen) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
    try {
      await unlink(tmpPath);
    } catch {
      // Best-effort cleanup only
    }
    throw err;
  }
}

export type Ownership = "agent" | "agentDelegatedToUser" | "user";

export type Space = {
  taskId: string;
  id: number;
  name: string;
  createdBy: "agent" | "user";
  ownership: Ownership;
  recentTabTitles?: string[];
  targetIds: string[];
  activeTargetId?: string;
  createdAt: number;
  touchedAt: number;
  lastContentAt?: number;
};

export type SpaceEvent = {
  id: string;
  at: number;
  spaceId: number | null;
  type: string;
  detail?: string;
};

export type SpaceManagerOptions = {
  now?: () => number;
  maxEvents?: number;
};

export type PrunedSpace = {
  id: number;
  name: string;
  reason: "abandoned" | "idle";
  targetIds: string[];
};

export type UseResult =
  | { ok: true; space: Space }
  | { ok: false; error_code: string; error: string };

type PersistShape = {
  nextId: number;
  selectedId: number | null;
  spaces: Space[];
  events?: SpaceEvent[];
};

const USER_SPACE_ID = 1;

function bootstrapUserSpace(now = Date.now()): Space {
  return {
    taskId: "user",
    id: USER_SPACE_ID,
    name: "user",
    createdBy: "user",
    ownership: "user",
    targetIds: [],
    createdAt: now,
    touchedAt: now,
  };
}

function cloneSpace(space: Space): Space {
  return {
    ...space,
    targetIds: [...space.targetIds],
    ...(space.recentTabTitles
      ? { recentTabTitles: [...space.recentTabTitles] }
      : {}),
  };
}

/**
 * Task Spaces = named tab sets + ownership in one shared Chromium profile.
 * Isolation is tabs/control, not cookies.
 */
export class SpaceManager {
  private readonly persistPath: string | undefined;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private nextId = USER_SPACE_ID + 1;
  private selectedId: number | null = null;
  private spaces: Space[];
  private eventLog: SpaceEvent[] = [];
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(persistPath?: string, options: SpaceManagerOptions = {}) {
    this.persistPath = persistPath;
    this.now = options.now ?? Date.now;
    this.maxEvents = Math.max(20, options.maxEvents ?? 200);
    this.spaces = [bootstrapUserSpace(this.now())];
  }

  async load(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as PersistShape;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.spaces)
      ) {
        this.resetBootstrap();
        return;
      }
      const spaces: Space[] = [];
      for (const entry of parsed.spaces) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.id !== "number" || typeof entry.name !== "string") {
          continue;
        }
        const ownership = entry.ownership;
        if (
          ownership !== "agent" &&
          ownership !== "agentDelegatedToUser" &&
          ownership !== "user"
        ) {
          continue;
        }
        const createdBy =
          entry.createdBy === "agent" || entry.createdBy === "user"
            ? entry.createdBy
            : ownership === "user"
              ? "user"
              : "agent";
        const now = this.now();
        const targetIds = Array.isArray(entry.targetIds)
          ? entry.targetIds.filter((t): t is string => typeof t === "string")
          : [];
        const activeTargetId =
          typeof entry.activeTargetId === "string" &&
          targetIds.includes(entry.activeTargetId)
            ? entry.activeTargetId
            : targetIds.at(-1);
        spaces.push({
          taskId:
            typeof entry.taskId === "string" ? entry.taskId : String(entry.id),
          id: entry.id,
          name: entry.name,
          createdBy,
          ownership,
          targetIds,
          ...(activeTargetId ? { activeTargetId } : {}),
          createdAt:
            typeof entry.createdAt === "number" ? entry.createdAt : now,
          touchedAt:
            typeof entry.touchedAt === "number" ? entry.touchedAt : now,
          ...(typeof entry.lastContentAt === "number"
            ? { lastContentAt: entry.lastContentAt }
            : {}),
          ...(Array.isArray(entry.recentTabTitles)
            ? {
                recentTabTitles: entry.recentTabTitles.filter(
                  (t): t is string => typeof t === "string",
                ),
              }
            : {}),
        });
      }
      if (!spaces.some((s) => s.id === USER_SPACE_ID)) {
        spaces.unshift(bootstrapUserSpace(this.now()));
      }
      this.spaces = spaces;
      this.eventLog = Array.isArray(parsed.events)
        ? parsed.events
            .filter(
              (event): event is SpaceEvent =>
                Boolean(event) &&
                typeof event.id === "string" &&
                typeof event.at === "number" &&
                (event.spaceId === null || typeof event.spaceId === "number") &&
                typeof event.type === "string",
            )
            .slice(-this.maxEvents)
        : [];
      this.nextId =
        typeof parsed.nextId === "number" && parsed.nextId > USER_SPACE_ID
          ? parsed.nextId
          : Math.max(USER_SPACE_ID + 1, ...spaces.map((s) => s.id + 1));
      if (
        parsed.selectedId === null ||
        parsed.selectedId === undefined ||
        typeof parsed.selectedId !== "number"
      ) {
        this.selectedId = null;
      } else if (this.findSpace(parsed.selectedId)) {
        this.selectedId = parsed.selectedId;
      } else {
        this.selectedId = null;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.resetBootstrap();
        return;
      }
      // Corrupt JSON or unexpected shape → bootstrap
      this.resetBootstrap();
    }
  }

  async save(): Promise<void> {
    if (!this.persistPath) return;
    const payload: PersistPayload = {
      nextId: this.nextId,
      selectedId: this.selectedId,
      spaces: this.spaces.map(cloneSpace),
      events: this.eventLog.map((event) => ({ ...event })),
    };
    await mkdir(dirname(this.persistPath), { recursive: true });

    const op = this.saveQueue.then(() => writePersistAtomically(this.persistPath!, payload));
    this.saveQueue = op.catch(() => {
      // keep the queue alive; callers keep own failure handling
    });
    await op;
  }

  /** Internal list including targetIds. */
  list(): Space[] {
    return this.spaces.map(cloneSpace);
  }

  /** Public records without targetIds (ego listTaskSpaces shape). */
  listPublic(): Array<Omit<Space, "targetIds"> & { recentTabTitles?: string[] }> {
    return this.spaces.map((s) => {
      const { targetIds: _t, ...rest } = s;
      return {
        ...rest,
        ...(s.recentTabTitles
          ? { recentTabTitles: [...s.recentTabTitles] }
          : {}),
      };
    });
  }

  createAgentSpace(name: string): Space {
    const id = this.nextId++;
    const now = this.now();
    const space: Space = {
      taskId: String(id),
      id,
      name,
      createdBy: "agent",
      ownership: "agent",
      targetIds: [],
      createdAt: now,
      touchedAt: now,
    };
    this.spaces.push(space);
    this.record("space.created", space.id, name);
    return cloneSpace(space);
  }

  /** Reuse an existing agent-owned space by name, otherwise create it. */
  useOrCreateAgentSpace(name: string): { space: Space; reused: boolean } {
    const existing = this.spaces.find(
      (space) =>
        space.createdBy === "agent" &&
        space.ownership === "agent" &&
        space.name === name,
    );
    if (existing) {
      this.selectedId = existing.id;
      this.touch(existing);
      this.record("space.reused", existing.id, name);
      return { space: cloneSpace(existing), reused: true };
    }
    const created = this.createAgentSpace(name);
    this.selectedId = created.id;
    return { space: created, reused: false };
  }

  use(id: number): UseResult {
    const space = this.findSpace(id);
    if (!space) {
      return {
        ok: false,
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
        error: `task space not found: ${id}`,
      };
    }
    this.selectedId = id;
    this.touch(space);
    this.record("space.selected", space.id);
    return { ok: true, space: cloneSpace(space) };
  }

  claim(id: number, name?: string): Space {
    const space = this.findSpace(id);
    if (!space) {
      throw Object.assign(new Error(`task space not found: ${id}`), {
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      });
    }
    space.ownership = "agent";
    if (name !== undefined && name !== "") {
      space.name = name;
    }
    this.selectedId = id;
    this.touch(space);
    this.record("space.claimed", space.id);
    return cloneSpace(space);
  }

  handOff(): void {
    const space = this.selectedSpace();
    if (!space) return;
    if (space.ownership === "agent") {
      space.ownership = "agentDelegatedToUser";
      this.touch(space);
      this.record("space.handed_off", space.id);
    }
  }

  takeOver(): void {
    const space = this.selectedSpace();
    if (!space) return;
    if (space.ownership === "agentDelegatedToUser") {
      space.ownership = "agent";
      this.touch(space);
      this.record("space.taken_over", space.id);
    }
  }

  /**
   * Complete selected agent space but keep its tabs: ownership becomes user.
   */
  completeKeep(): void {
    const space = this.selectedSpace();
    if (!space) return;
    if (space.id === USER_SPACE_ID && space.createdBy === "user") {
      // Bootstrap user space stays user-owned; nothing to complete.
      space.ownership = "user";
      return;
    }
    space.ownership = "user";
    this.touch(space);
    this.record("space.completed", space.id);
  }

  /**
   * Close the selected space. Returns targetIds the host should close in Chrome.
   * Protects bootstrap user space id 1 (clears its tabs, does not remove the space).
   */
  closeSelected(): string[] {
    if (this.selectedId === null) return [];
    return this.close(this.selectedId);
  }

  close(id: number): string[] {
    const space = this.findSpace(id);
    if (!space) {
      if (this.selectedId === id) this.selectedId = null;
      return [];
    }
    const targetIds = [...space.targetIds];
    if (space.id === USER_SPACE_ID) {
      space.targetIds = [];
      space.ownership = "user";
      if (this.selectedId === id) this.selectedId = null;
      this.record("space.cleared", space.id);
      return targetIds;
    }
    this.spaces = this.spaces.filter((s) => s.id !== space.id);
    if (this.selectedId === id) this.selectedId = null;
    this.record("space.closed", space.id, space.name);
    return targetIds;
  }

  selected(): Space | null {
    const space = this.selectedSpace();
    return space ? cloneSpace(space) : null;
  }

  /**
   * Page ops / snapshot blocked when no selection or ownership is user /
   * agentDelegatedToUser (agent control required).
   */
  isPageControlBlocked(): boolean {
    const space = this.selectedSpace();
    if (!space) return true;
    return (
      space.ownership === "user" || space.ownership === "agentDelegatedToUser"
    );
  }

  assignTarget(targetId: string, spaceId?: number): void {
    const destId = spaceId ?? this.selectedId;
    if (destId === null || destId === undefined) {
      throw Object.assign(new Error("task space not selected"), {
        error_code: "EGO_TASK_SPACE_NOT_SELECTED",
      });
    }
    const dest = this.findSpace(destId);
    if (!dest) {
      throw Object.assign(new Error(`task space not found: ${destId}`), {
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      });
    }
    for (const s of this.spaces) {
      const idx = s.targetIds.indexOf(targetId);
      if (idx !== -1) {
        s.targetIds.splice(idx, 1);
        if (s.activeTargetId === targetId) {
          s.activeTargetId = s.targetIds.at(-1);
        }
      }
    }
    if (!dest.targetIds.includes(targetId)) {
      dest.targetIds.push(targetId);
    }
    dest.activeTargetId = targetId;
    this.touch(dest);
    this.record("tab.assigned", dest.id, targetId);
  }

  targetsForSelected(): string[] {
    const space = this.selectedSpace();
    return space ? [...space.targetIds] : [];
  }

  activeTargetForSelected(): string | null {
    const space = this.selectedSpace();
    return space ? this.activeTargetForSpace(space) : null;
  }

  activeTargetFor(spaceId: number): string | null {
    const space = this.findSpace(spaceId);
    return space ? this.activeTargetForSpace(space) : null;
  }

  private activeTargetForSpace(space: Space): string | null {
    if (!space) return null;
    return space.activeTargetId && space.targetIds.includes(space.activeTargetId)
      ? space.activeTargetId
      : (space.targetIds.at(-1) ?? null);
  }

  setActiveTarget(targetId: string, spaceId?: number): void {
    const space = this.findSpace(spaceId ?? this.selectedId ?? -1);
    if (!space || !space.targetIds.includes(targetId)) {
      throw Object.assign(new Error(`target not in selected task space: ${targetId}`), {
        error_code: "EGO_TAB_NOT_IN_TASK_SPACE",
      });
    }
    space.activeTargetId = targetId;
    this.touch(space);
    this.record("tab.activated", space.id, targetId);
  }

  /** Refresh tab metadata and remove target ids Chrome no longer reports. */
  reconcileTargets(
    targets: Array<{ targetId: string; title?: string; url?: string }>,
  ): void {
    const live = new Map(targets.map((target) => [target.targetId, target]));
    const now = this.now();
    for (const space of this.spaces) {
      const kept = space.targetIds.filter((targetId) => live.has(targetId));
      if (kept.length !== space.targetIds.length) {
        space.targetIds = kept;
      }
      if (space.activeTargetId && !kept.includes(space.activeTargetId)) {
        space.activeTargetId = kept.at(-1);
      }
      const titles = kept
        .map((targetId) => live.get(targetId)?.title ?? "")
        .filter(Boolean);
      space.recentTabTitles = titles;
      if (
        space.lastContentAt === undefined &&
        kept.some((targetId) => {
          const url = live.get(targetId)?.url ?? "";
          return Boolean(url) && url !== "about:blank";
        })
      ) {
        space.lastContentAt = now;
        this.record("space.first_content", space.id);
      }
    }
  }

  /** Remove agent-owned spaces that never started or were left idle. */
  prune(options: {
    abandonedAfterMs: number;
    idleAfterMs: number;
  }): PrunedSpace[] {
    const now = this.now();
    const removed: PrunedSpace[] = [];
    const kept: Space[] = [];
    for (const space of this.spaces) {
      const protectedSpace =
        space.id === USER_SPACE_ID ||
        space.id === this.selectedId ||
        space.ownership !== "agent";
      let reason: PrunedSpace["reason"] | null = null;
      if (!protectedSpace) {
        if (
          options.abandonedAfterMs > 0 &&
          space.lastContentAt === undefined &&
          now - space.createdAt >= options.abandonedAfterMs
        ) {
          reason = "abandoned";
        } else if (
          options.idleAfterMs > 0 &&
          now - space.touchedAt >= options.idleAfterMs
        ) {
          reason = "idle";
        }
      }
      if (!reason) {
        kept.push(space);
        continue;
      }
      removed.push({
        id: space.id,
        name: space.name,
        reason,
        targetIds: [...space.targetIds],
      });
      this.record(`space.pruned.${reason}`, space.id, space.name);
    }
    this.spaces = kept;
    return removed;
  }

  listEvents(limit = 100): SpaceEvent[] {
    const count = Math.max(0, Math.min(this.maxEvents, limit));
    return this.eventLog.slice(-count).map((event) => ({ ...event }));
  }

  controlSnapshot(): {
    selectedId: number | null;
    spaces: Array<Omit<Space, "targetIds"> & { tabCount: number }>;
    events: SpaceEvent[];
  } {
    return {
      selectedId: this.selectedId,
      spaces: this.spaces.map(({ targetIds, ...space }) => ({
        ...space,
        tabCount: targetIds.length,
      })),
      events: this.listEvents(),
    };
  }

  spaceIdForTarget(targetId: string): number | null {
    for (const s of this.spaces) {
      if (s.targetIds.includes(targetId)) return s.id;
    }
    return null;
  }

  /** Assign unknown targets to the user space (id 1). Known targets unchanged. */
  adoptOrphanTargets(targetIds: string[]): void {
    const user = this.findSpace(USER_SPACE_ID);
    if (!user) {
      this.spaces.unshift(bootstrapUserSpace());
    }
    const userSpace = this.findSpace(USER_SPACE_ID)!;
    for (const tid of targetIds) {
      if (this.spaceIdForTarget(tid) === null) {
        userSpace.targetIds.push(tid);
      }
    }
    if (!userSpace.activeTargetId && userSpace.targetIds.length > 0) {
      userSpace.activeTargetId = userSpace.targetIds.at(-1);
    }
  }

  private touch(space: Space): void {
    space.touchedAt = this.now();
  }

  private record(type: string, spaceId: number | null, detail?: string): void {
    this.eventLog.push({
      id: randomUUID(),
      at: this.now(),
      spaceId,
      type,
      ...(detail ? { detail } : {}),
    });
    if (this.eventLog.length > this.maxEvents) {
      this.eventLog.splice(0, this.eventLog.length - this.maxEvents);
    }
  }

  private findSpace(id: number): Space | undefined {
    return this.spaces.find((s) => s.id === id);
  }

  private selectedSpace(): Space | undefined {
    if (this.selectedId === null) return undefined;
    return this.findSpace(this.selectedId);
  }

  private resetBootstrap(): void {
    this.nextId = USER_SPACE_ID + 1;
    this.selectedId = null;
    this.spaces = [bootstrapUserSpace(this.now())];
    this.eventLog = [];
  }
}
