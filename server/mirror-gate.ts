import { type GitRunner } from "./git.js";

/** A remote listing younger than this answers every pod asking for the same remote. */
export const LS_REMOTE_TTL_MS = 8_000;
/** Mirror refreshes (`git fetch`, an ssh upload-pack) allowed at once across all pods. */
export const MAX_CONCURRENT_FETCHES = 2;
/** A refresh that cannot get a slot in this time fails, so the pod's git command errors instead of hanging. */
export const FETCH_QUEUE_TIMEOUT_MS = 120_000;

/** A remote's branches and tags as `ls-remote` printed them (annotated tags by their tag object). */
export interface RemoteListing {
  refs: Map<string, string>;
  /** The default branch (`refs/heads/...`) when the remote reports it. */
  head?: string;
}

/** Counters of the git work done for pod fetches, logged once a minute. */
export class GitMirrorStats {
  lsRemote = 0;
  lsRemoteCached = 0;
  fetches = 0;
  skipped = 0;
  queued = 0;
  spawns = 0;
  totalMs = 0;
  maxMs = 0;

  recordSpawn(ms: number): void {
    this.spawns += 1;
    this.totalMs += ms;
    this.maxMs = Math.max(this.maxMs, ms);
  }

  /** The line for the last minute, resetting the counters; undefined when nothing ran. */
  take(): string | undefined {
    const { lsRemote, lsRemoteCached, fetches, skipped, queued, spawns, totalMs, maxMs } = this;
    this.lsRemote = this.lsRemoteCached = this.fetches = this.skipped = this.queued = this.spawns = this.totalMs = this.maxMs = 0;
    if (!lsRemote && !lsRemoteCached && !fetches && !skipped) return undefined;
    return `[kubernetes-runtime] git mirror last minute: ls-remote ${lsRemote} (cached ${lsRemoteCached}), fetches ${fetches} (skipped ${skipped}, queued ${queued}), ssh/upload-pack spawns ${spawns}, latency avg ${spawns ? Math.round(totalMs / spawns) : 0} ms max ${maxMs} ms`;
  }
}

export const gitMirrorStats = new GitMirrorStats();

export interface MirrorGateOptions {
  ttlMs?: number;
  maxConcurrent?: number;
  queueTimeoutMs?: number;
  now?: () => number;
  stats?: GitMirrorStats;
}

/** Parses `git ls-remote --symref` output, ignoring peeled tag lines (`^{}`) and anything but branches and tags. */
export function parseListing(stdout: string): RemoteListing {
  const refs = new Map<string, string>();
  let head: string | undefined;
  for (const line of stdout.split("\n")) {
    const symref = /^ref: (refs\/heads\/\S+)\s+HEAD$/.exec(line);
    if (symref) {
      head = symref[1];
      continue;
    }
    const m = /^([0-9a-f]{40})\s+(refs\/(?:heads|tags)\/\S+)$/.exec(line);
    if (m && !m[2]!.endsWith("^{}")) refs.set(m[2]!, m[1]!);
  }
  return { refs, ...(head ? { head } : {}) };
}

/**
 * What decides how much git a pod's fetch costs the daemon: remote listings shared for a few seconds (one
 * `ls-remote` per remote however many pods ask), a mirror that already matches the listing is not fetched again,
 * and at most a few refreshes run at once, in arrival order. A push through the bridge drops the listings.
 */
export class MirrorGate {
  /** Public so a test that changes the remote behind the bridge can turn the sharing off (0). */
  ttlMs: number;
  private readonly maxConcurrent: number;
  private readonly queueTimeoutMs: number;
  private readonly now: () => number;
  readonly stats: GitMirrorStats;
  private readonly listings = new Map<string, { at: number; listing: RemoteListing }>();
  private readonly inflight = new Map<string, { generation: number; promise: Promise<RemoteListing | undefined> }>();
  /** Bumped by every invalidation: a listing read before it is not kept for readers after it. */
  private generation = 0;
  private running = 0;
  private readonly waiting: { grant: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: MirrorGateOptions = {}) {
    this.ttlMs = options.ttlMs ?? LS_REMOTE_TTL_MS;
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_FETCHES;
    this.queueTimeoutMs = options.queueTimeoutMs ?? FETCH_QUEUE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.stats = options.stats ?? gitMirrorStats;
  }

  /** Forgets every listing (and disowns the ones in flight): the next reader asks the remote. Called after a push. */
  invalidate(): void {
    this.generation += 1;
    this.listings.clear();
    this.inflight.clear();
  }

  /** Runs git and records the spawn; the ssh child of a fetch or ls-remote is one. */
  async timed<T>(run: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await run();
    } finally {
      this.stats.recordSpawn(this.now() - started);
    }
  }

  /**
   * The remote's branches and tags, from the last few seconds when another pod asked already. `urls` are tried in turn;
   * undefined when none answers. Failures are not remembered.
   */
  async list(key: string, urls: readonly string[], git: GitRunner, cwd: string): Promise<RemoteListing | undefined> {
    const hit = this.listings.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) {
      this.stats.lsRemoteCached += 1;
      return hit.listing;
    }
    const shared = this.inflight.get(key);
    if (shared) {
      this.stats.lsRemoteCached += 1;
      return shared.promise;
    }
    const generation = this.generation;
    const promise = (async () => {
      for (const url of urls) {
        this.stats.lsRemote += 1;
        const r = await this.timed(() => git(["ls-remote", "--symref", url, "HEAD", "refs/heads/*", "refs/tags/*"], { cwd })).catch(() => undefined);
        if (r && r.code === 0) {
          const listing = parseListing(r.stdout);
          if (generation === this.generation) this.listings.set(key, { at: this.now(), listing });
          return listing;
        }
      }
      return undefined;
    })();
    this.inflight.set(key, { generation, promise });
    try {
      return await promise;
    } finally {
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
    }
  }

  /** Runs `fn` after every earlier call with the same key, so two pods never refresh one mirror at the same time. */
  async serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(fn);
    this.locks.set(key, mine);
    try {
      return await mine;
    } finally {
      if (this.locks.get(key) === mine) this.locks.delete(key);
    }
  }

  /** Runs `fn` in one of the fetch slots, first come first served; throws when no slot frees up in time. */
  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      this.stats.queued += 1;
      await new Promise<void>((resolve, reject) => {
        const entry = {
          grant: resolve,
          timer: setTimeout(() => {
            this.waiting.splice(this.waiting.indexOf(entry), 1);
            reject(new Error(`too many git fetches are running for pods (${this.maxConcurrent} at once); waited ${Math.round(this.queueTimeoutMs / 1000)} s for a free slot, run the command again`));
          }, this.queueTimeoutMs),
        };
        (entry.timer as { unref?: () => void }).unref?.();
        this.waiting.push(entry);
      });
    } else {
      this.running += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant(); // the slot passes straight to the next in line
      } else {
        this.running -= 1;
      }
    }
  }
}

export const mirrorGate = new MirrorGate();
