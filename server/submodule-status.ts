export type SubmoduleState = "pending" | "fetching" | "ready" | "failed";

export interface SubmoduleStatus {
  path: string;
  state: SubmoduleState;
  /** 0 to 1: pending 0, fetching 0.1 to 0.7 (the daemon relays the history), checking out 0.7 to 1. */
  progress: number;
  message?: string;
  /** The commit checked out (once ready), so an agent can quote the code it read. */
  sha?: string;
  /** The gitlink the project records for it, when the checkout moved to the remote tip. */
  pinned?: string;
  /** `pinned`: at the project's gitlink; `remote`: at the tip of the submodule's remote branch, fetched at provisioning. */
  at?: "pinned" | "remote";
}

/** What a ready submodule is checked out at. */
export type SubmoduleCommit = Pick<SubmoduleStatus, "sha" | "pinned" | "at">;

export interface SubmoduleReport {
  submodules: (SubmoduleStatus & { etaSeconds?: number })[];
  /** Every submodule is ready (or the workspace has none). */
  allReady: boolean;
  /** The pod has not told which submodules it has yet; the list is the daemon checkout's `.gitmodules`. */
  provisional?: boolean;
}

/**
 * `git submodule status` lines: `-<sha> path` (not checked out), ` <sha> path (desc)`, `+<sha> path (desc)`. The sha of a
 * checked-out one is its HEAD (`+`: not the gitlink).
 */
export function parseSubmoduleStatus(text: string): { path: string; checkedOut: boolean; sha?: string }[] {
  const out: { path: string; checkedOut: boolean; sha?: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^([-+U ])([0-9a-f]{40})\s+(\S+?)(?:\s+\(.*\))?$/.exec(line);
    if (m) out.push(m[1] === "-" ? { path: m[3]!, checkedOut: false } : { path: m[3]!, checkedOut: true, sha: m[2]! });
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
  /** Set by the runtime: starts the provisioning again (what a `wait` on a failed submodule asks for). */
  retry?: () => void;

  constructor(private readonly now: () => number = Date.now) {}

  /** Sets the list: what is checked out is ready, the rest pending. Keeps the progress of paths it already knows. */
  reset(items: readonly { path: string; checkedOut: boolean; sha?: string }[]): void {
    const next = new Map<string, SubmoduleStatus>();
    for (const { path, checkedOut, sha } of items) {
      const old = this.entries.get(path);
      const ready = (): SubmoduleStatus => ({ ...(old?.state === "ready" ? old : {}), path, state: "ready", progress: 1, ...(sha ? { sha } : {}) });
      next.set(path, checkedOut ? ready() : old && old.state !== "ready" ? old : { path, state: "pending", progress: 0 });
    }
    this.entries = next;
    this.known = true;
    this.startedAt = this.now();
    this.notify();
  }

  update(path: string, state: SubmoduleState, progress: number, message?: string, commit: SubmoduleCommit = {}): void {
    this.entries.set(path, { path, state, progress, ...(message ? { message } : {}), ...commit });
    this.notify();
  }

  /** The provisioning job ended: what is not ready failed (or is ready when `ok`). */
  finish(ok: boolean, message = ""): void {
    for (const [path, e] of this.entries) {
      if (e.state === "ready" || (e.state === "failed" && !ok)) continue;
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

  /** Whether any submodule is failed or still waiting (so another provisioning run is worth it). */
  needsWork(): boolean {
    return [...this.entries.values()].some((e) => e.state !== "ready");
  }

  /** Puts the failed submodules back to pending for another run. */
  requeue(): void {
    for (const [path, e] of this.entries) if (e.state === "failed") this.entries.set(path, { path, state: "pending", progress: 0, message: `retrying after: ${e.message ?? "an error"}` });
    this.notify();
  }

  /**
   * Resolves when `path` is ready or failed (immediately for an unknown path), or after `timeoutMs`. Asking for a failed
   * submodule starts the provisioning again and waits for that run instead of answering `failed` at once.
   */
  wait(path: string, timeoutMs: number): Promise<SubmoduleStatus | undefined> {
    if (this.entries.get(path)?.state === "failed" && this.retry) {
      this.requeue();
      this.retry();
    }
    return this.waitSettled(path, timeoutMs);
  }

  private waitSettled(path: string, timeoutMs: number): Promise<SubmoduleStatus | undefined> {
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
export function submoduleWarning(paths: readonly string[], checkout: "pinned" | "remote" = "pinned"): string {
  const list = paths.slice(0, 20).map((p) => `- ${p}`).join("\n") + (paths.length > 20 ? `\n- ... and ${paths.length - 20} more` : "");
  return [
    "This workspace runs in a pod. Its git submodules are provisioned by the daemon in the background and may still be fetching when you start, so an empty submodule directory does not mean the submodule is empty or missing.",
    "Before you read a submodule, call the `submodule_status` tool (MCP server `submodules`); if it is not ready, call `submodule_wait` with its path. Do not fall back to the GitHub API or clone it yourself.",
    checkout === "remote"
      ? "Each submodule is checked out at the tip of its remote default branch as fetched when the workspace was provisioned (`submodule_status` gives its `sha` and the `pinned` gitlink); run `git -C <path> fetch origin && git -C <path> checkout --detach origin/HEAD` to catch up later, and quote the sha you read (`git -C <path> rev-parse HEAD`) in your findings."
      : "Each submodule is checked out at the commit this project records for it (its gitlink, `sha` in `submodule_status`), which can be far behind the submodule's own main. To read its current code, run `git -C <path> fetch origin && git -C <path> checkout --detach origin/HEAD` first, and quote the sha you read (`git -C <path> rev-parse HEAD`) in your findings.",
    "Submodules of this project:",
    list,
  ].join("\n");
}
