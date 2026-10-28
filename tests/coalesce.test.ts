import { describe, expect, it } from "vitest";
import { LastGood, Semaphore, SingleFlightCache, withTimeout } from "../server/coalesce.js";

const later = <T = void>(ms: number, value?: T) => new Promise<T>((r) => setTimeout(() => r(value as T), ms));

describe("withTimeout", () => {
  it("gives the fallback when the promise is slow or fails", async () => {
    expect(await withTimeout(later(200, "slow"), 10, () => "fallback")).toBe("fallback");
    expect(await withTimeout(Promise.reject(new Error("x")), 50, () => "fallback")).toBe("fallback");
    expect(await withTimeout(Promise.resolve("ok"), 50, () => "fallback")).toBe("ok");
  });
});

describe("LastGood", () => {
  it("serves the last good value when a read is slow, fails or comes back null", async () => {
    const g = new LastGood<string>(20);
    expect(await g.read(async () => "one")).toEqual({ value: "one", stale: false });
    expect(await g.read(() => later(200, "two"))).toEqual({ value: "one", stale: true });
    await later(250);
    expect(await g.read(async () => null)).toEqual({ value: "two", stale: true }); // the slow read finished late: kept
    expect(await g.read(async () => Promise.reject(new Error("x")))).toEqual({ value: "two", stale: true });
  });

  it("has nothing to give before the first good read", async () => {
    const g = new LastGood<string>(10);
    expect(await g.read(() => later(100, "late"))).toEqual({ value: undefined, stale: true });
  });

  it("shares one read between concurrent callers", async () => {
    const g = new LastGood<number>(100);
    let reads = 0;
    const load = async () => (reads++, await later(20, reads));
    const [a, b] = await Promise.all([g.read(load), g.read(load)]);
    expect(reads).toBe(1);
    expect(a.value).toBe(b.value);
  });
});

describe("SingleFlightCache", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  };

  it("runs one load for concurrent callers and serves it from the cache until the ttl", async () => {
    const c = clock();
    const cache = new SingleFlightCache<number>(5_000, 8_000, c.now);
    let loads = 0;
    const load = async () => ++loads;
    const [a, b] = await Promise.all([cache.get(load), cache.get(load)]);
    expect([a.value, b.value, loads]).toEqual([1, 1, 1]);
    c.advance(4_999);
    expect(await cache.get(load)).toEqual({ value: 1, stale: false, ageMs: 4_999 });
    expect(loads).toBe(1);
    c.advance(2);
    expect((await cache.get(load)).value).toBe(2);
  });

  it("serves the old snapshot at once, flagged stale, while a refresh runs", async () => {
    const c = clock();
    const cache = new SingleFlightCache<string>(1_000, 5_000, c.now);
    await cache.get(async () => "old");
    c.advance(3_000);
    let release!: () => void;
    const slow = new Promise<string>((r) => (release = () => r("new")));
    const starter = cache.get(() => slow); // starts the refresh and waits for it
    const other = await cache.get(async () => "never"); // does not wait
    expect(other).toEqual({ value: "old", stale: true, ageMs: 3_000 });
    release();
    expect(await starter).toMatchObject({ value: "new", stale: false });
    expect((await cache.get(async () => "never")).value).toBe("new");
  });

  it("stops waiting for the refresh it started after softMs and serves the old snapshot", async () => {
    const cache = new SingleFlightCache<string>(10_000, 20);
    await cache.get(async () => "old");
    cache.invalidate();
    const got = await cache.get(() => later(300, "new"));
    expect(got).toMatchObject({ value: "old", stale: true });
    await later(350);
    expect(await cache.get(async () => "never")).toMatchObject({ value: "new", stale: false }); // the slow refresh landed meanwhile
  });

  it("serves the old snapshot when a refresh fails, and fails when there is none", async () => {
    const cache = new SingleFlightCache<string>(0, 100);
    await expect(cache.get(async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    await cache.get(async () => "ok");
    expect(await cache.get(async () => Promise.reject(new Error("down")))).toMatchObject({ value: "ok", stale: true });
  });

  it("invalidate makes the next call refresh", async () => {
    const c = clock();
    const cache = new SingleFlightCache<number>(10_000, 100, c.now);
    let n = 0;
    await cache.get(async () => ++n);
    cache.invalidate();
    expect((await cache.get(async () => ++n)).value).toBe(2);
  });
});

describe("Semaphore", () => {
  it("never runs more than the limit at once and runs the rest in order", async () => {
    const s = new Semaphore(2);
    let active = 0;
    let max = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        s.run(async () => {
          active++;
          max = Math.max(max, active);
          await later(5, 0);
          order.push(n);
          active--;
        }),
      ),
    );
    expect(max).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(s.takePeak()).toBe(2);
  });

  it("frees the slot when a task throws", async () => {
    const s = new Semaphore(1);
    await expect(s.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await s.run(async () => "after")).toBe("after");
  });
});
