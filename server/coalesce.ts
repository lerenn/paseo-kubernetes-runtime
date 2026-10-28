/** Resolves with `fallback()` when `promise` has not settled within `ms` (or rejects); the promise keeps running and its result is dropped. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      () => (clearTimeout(timer), resolve(fallback())),
    );
  });
}

/**
 * Runs a reader with a timeout and remembers its last good answer: a slow, failed or empty (null) read gives the last
 * good value instead (`undefined` when there never was one). One read at a time: a call during a slow read shares it.
 */
export class LastGood<T> {
  private last: { value: T; at: number } | undefined;
  private inflight: Promise<T | null> | undefined;

  constructor(private readonly timeoutMs: number, private readonly now: () => number = Date.now) {}

  async read(load: () => Promise<T | null>): Promise<{ value: T | undefined; stale: boolean }> {
    this.inflight ??= load()
      .catch(() => null)
      .finally(() => (this.inflight = undefined));
    const started = this.inflight;
    const got = await withTimeout(started, this.timeoutMs, () => null);
    if (got !== null) {
      // the read may finish after its caller gave up: keep the value for the next one
      this.last = { value: got, at: this.now() };
      return { value: got, stale: false };
    }
    void started.then((late) => {
      if (late !== null) this.last = { value: late, at: this.now() };
    });
    return { value: this.last?.value, stale: true };
  }
}

export interface Snapshot<T> {
  value: T;
  /** True when this is an older snapshot, served because a refresh is running or took too long. */
  stale: boolean;
  /** Milliseconds since the snapshot was taken. */
  ageMs: number;
}

/**
 * Single-flight with a short cache for an expensive read. A fresh snapshot (younger than `ttlMs`) is served as it is.
 * Otherwise one refresh runs (shared by every caller); with an older snapshot at hand, a caller gets it at once when a
 * refresh is already running, and waits at most `softMs` for one it started itself. With no snapshot at all the caller
 * waits for the refresh (the readers inside carry their own timeouts).
 */
export class SingleFlightCache<T> {
  private snap: { value: T; at: number } | undefined;
  private inflight: Promise<T> | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly softMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drops the snapshot (the next call refreshes); a refresh already running still finishes. */
  invalidate(): void {
    if (this.snap) this.snap.at = Number.NEGATIVE_INFINITY;
  }

  async get(load: () => Promise<T>): Promise<Snapshot<T>> {
    const t = this.now();
    if (this.snap && t - this.snap.at < this.ttlMs) return { value: this.snap.value, stale: false, ageMs: t - this.snap.at };
    const running = Boolean(this.inflight);
    this.inflight ??= load()
      .then((value) => ((this.snap = { value, at: this.now() }), value))
      .finally(() => (this.inflight = undefined));
    const refresh = this.inflight;
    const old = this.snap;
    if (!old) return { value: await refresh, stale: false, ageMs: 0 };
    const serveOld = (): Snapshot<T> => ({ value: old.value, stale: true, ageMs: Math.max(0, this.now() - old.at) });
    if (running) return serveOld();
    const fresh = await withTimeout(refresh.then((value) => ({ value })), this.softMs, () => null).catch(() => null);
    return fresh ? { value: fresh.value, stale: false, ageMs: 0 } : serveOld();
  }
}

/** At most `limit` tasks at a time; the rest wait in order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Highest number of tasks that ran at once since the last `takePeak`. */
  private peak = 0;

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot over
      else this.active -= 1;
    }
  }

  takePeak(): number {
    const p = this.peak;
    this.peak = this.active;
    return p;
  }
}
