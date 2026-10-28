export type SubmoduleState = "pending" | "fetching" | "ready" | "failed";

export interface SubmoduleStatus {
  path: string;
  state: SubmoduleState;
  /** 0 to 1: pending 0, fetching 0.1 to 0.7 (the daemon relays the history), checking out 0.7 to 1. */
  progress: number;
  message?: string;
}

export interface SubmoduleReport {
  submodules: (SubmoduleStatus & { etaSeconds?: number })[];
  /** Every submodule is ready (or the workspace has none). */
  allReady: boolean;
  /** The pod has not told which submodules it has yet; the list is the daemon checkout's `.gitmodules`. */
  provisional?: boolean;
}

/** `git submodule status` lines: `-<sha> path` (not checked out), ` <sha> path (desc)`, `+<sha> path (desc)`. */
export function parseSubmoduleStatus(text: string): { path: string; checkedOut: boolean }[] {
  const out: { path: string; checkedOut: boolean }[] = [];
  for (const line of text.split("\n")) {
    const m = /^([-+U ])[0-9a-f]{40}\s+(\S+?)(?:\s+\(.*\))?$/.exec(line);
    if (m) out.push({ path: m[2]!, checkedOut: m[1] !== "-" });
  }
  return out;
}

/**
 * Where each workspace's submodules are, as the pod's checkout goes: written by the provisioning job, read by the
 * `submodule_status` and `submodule_wait` tools and by the warning given to the agent.
 */
export class SubmoduleTracker {
  private entries = new Map<string, SubmoduleStatus>();
  private startedAt = 0;
  private known = false;
  private waiters = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Sets the list: what is checked out is ready, the rest pending. Keeps the progress of paths it already knows. */
  reset(items: readonly { path: string; checkedOut: boolean }[]): void {
    const next = new Map<string, SubmoduleStatus>();
    for (const { path, checkedOut } of items) {
      const old = this.entries.get(path);
      next.set(path, checkedOut ? { path, state: "ready", progress: 1 } : old && old.state !== "ready" ? old : { path, state: "pending", progress: 0 });
    }
    this.entries = next;
    this.known = true;
    this.startedAt = this.now();
    this.notify();
  }

  update(path: string, state: SubmoduleState, progress: number, message?: string): void {
    this.entries.set(path, { path, state, progress, ...(message ? { message } : {}) });
    this.notify();
  }

  /** The provisioning job ended: what is not ready failed (or is ready when `ok`). */
  finish(ok: boolean, message = ""): void {
    for (const [path, e] of this.entries) {
      if (e.state === "ready") continue;
      this.entries.set(path, ok ? { path, state: "ready", progress: 1 } : { path, state: "failed", progress: e.progress, message: message || "fetching failed" });
    }
    this.notify();
  }

  get isKnown(): boolean {
    return this.known;
  }

  pending(): string[] {
    return [...this.entries.values()].filter((e) => e.state === "pending" || e.state === "fetching").map((e) => e.path);
  }

  report(provisionalPaths: readonly string[] = []): SubmoduleReport {
    if (!this.known) {
      return { submodules: provisionalPaths.map((path) => ({ path, state: "pending" as const, progress: 0 })), allReady: provisionalPaths.length === 0, ...(provisionalPaths.length ? { provisional: true } : {}) };
    }
    const all = [...this.entries.values()];
    const done = all.filter((e) => e.state === "ready").length;
    const elapsed = (this.now() - this.startedAt) / 1000;
    const progressSum = all.reduce((n, e) => n + e.progress, 0);
    // time left from the average speed so far: unknown until something has progressed
    const eta = progressSum > 0 && done < all.length ? Math.max(1, Math.round((elapsed / progressSum) * (all.length - progressSum))) : undefined;
    return {
      submodules: all.map((e) => ({ ...e, ...(e.state === "ready" || e.state === "failed" || eta === undefined ? {} : { etaSeconds: eta }) })),
      allReady: all.every((e) => e.state === "ready"),
    };
  }

  /** Resolves when `path` is ready or failed (immediately for an unknown path), or after `timeoutMs`. */
  wait(path: string, timeoutMs: number): Promise<SubmoduleStatus | undefined> {
    const current = () => this.entries.get(path);
    const settled = () => {
      const e = current();
      return !e || e.state === "ready" || e.state === "failed";
    };
    if (settled()) return Promise.resolve(current());
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const check = () => {
        if (!settled()) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(current());
      };
      timer = setTimeout(() => {
        this.waiters.delete(check);
        resolve(current());
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.waiters.add(check);
    });
  }

  private notify(): void {
    for (const w of [...this.waiters]) w();
  }
}

/** `.gitmodules` paths of a blob text (the daemon's checkout), for the warning and the provisional list. */
export function gitmodulesPaths(config: string): string[] {
  return config
    .split("\n")
    .map((l) => /^submodule\.\S+\.path\s+(.+)$/.exec(l.trim())?.[1])
    .filter((p): p is string => !!p);
}

/** The note added to an agent's system prompt in a pod workspace whose project has submodules. */
export function submoduleWarning(paths: readonly string[]): string {
  const list = paths.slice(0, 20).map((p) => `- ${p}`).join("\n") + (paths.length > 20 ? `\n- ... and ${paths.length - 20} more` : "");
  return [
    "This workspace runs in a pod. Its git submodules are provisioned by the daemon in the background and may still be fetching when you start, so an empty submodule directory does not mean the submodule is empty or missing.",
    "Before you read a submodule, call the `submodule_status` tool (MCP server `submodules`); if it is not ready, call `submodule_wait` with its path. Do not fall back to the GitHub API or clone it yourself.",
    "Submodules of this project:",
    list,
  ].join("\n");
}
