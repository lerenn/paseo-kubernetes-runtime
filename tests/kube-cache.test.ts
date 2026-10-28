import { describe, expect, it } from "vitest";
import { CachedKube, KubeCallStats, parseEqualitySelector } from "../server/kube-cache.js";
import { parseNamespaceRead, type NamespaceRead } from "../server/kube.js";
import { FakeKube } from "./fakes.js";

/** A Kubectl stand-in: counts the snapshot calls (one kubectl process each) and the others. */
class CountingKube extends FakeKube {
  snapshotCalls = 0;
  delayMs = 0;
  fail = false;
  hang = false;
  read: NamespaceRead = { pods: [], sandboxes: [] };
  async readNamespace(): Promise<NamespaceRead> {
    this.snapshotCalls += 1;
    if (this.hang) return new Promise(() => undefined);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error("boom");
    return structuredClone(this.read);
  }
}

const pod = (name: string, ready = true, labels: Record<string, string> = {}) => ({ name, labels, pod: { uid: name, ready, terminating: false } });
const sandbox = (name: string, labels: Record<string, string> = {}) => ({ name, labels, annotations: {}, operatingMode: "Running" as const });

function setup(workspaces = 12) {
  const inner = new CountingKube();
  inner.read = { pods: Array.from({ length: workspaces }, (_, i) => pod(`pka-${i}`, true, { "paseo.sh/daemon": "d1" })), sandboxes: Array.from({ length: workspaces }, (_, i) => sandbox(`pka-${i}`, { "paseo.sh/daemon": "d1" })) };
  let t = 0;
  const stats = new KubeCallStats();
  const kube = new CachedKube(inner, { ttlMs: 5_000, timeoutMs: 50, now: () => t, stats });
  return { inner, kube, stats, advance: (ms: number) => (t += ms) };
}

describe("CachedKube", () => {
  it("answers a minute of polling for 12 workspaces with at most 12 snapshot calls", async () => {
    const { inner, kube, advance } = setup(12);
    for (let second = 0; second < 60; second++) {
      for (let i = 0; i < 12; i++) {
        // the periodic checks: interruptions/turn annotations (every 10 s), idle/pool (30 s), bridges (60 s), status
        if (second % 10 === 0) expect((await kube.podInfo(`pka-${i}`))?.ready).toBe(true);
        if (second % 30 === 0) await kube.podInfo(`pka-${i}`);
        if (second % 7 === 0) await kube.podInfo(`pka-${i}`);
      }
      if (second % 30 === 0) await kube.listSandboxes("paseo.sh/daemon=d1");
      advance(1_000);
    }
    expect(inner.snapshotCalls).toBeLessThanOrEqual(12);
    expect(inner.calls.filter((c) => c.startsWith("pod:"))).toEqual([]); // no per-pod kubectl get
  });

  it("returns null for a pod that is not in the snapshot", async () => {
    const { kube } = setup(1);
    expect(await kube.podInfo("nope")).toBeNull();
  });

  it("reads again after the TTL, and a tighter maxAgeMs forces an earlier refresh", async () => {
    const { inner, kube, advance } = setup(2);
    await kube.podInfo("pka-0");
    advance(4_999);
    await kube.podInfo("pka-0");
    expect(inner.snapshotCalls).toBe(1);
    advance(1_500); // 6.5 s old
    await kube.podInfo("pka-0");
    expect(inner.snapshotCalls).toBe(2);
    advance(1_100);
    await kube.podInfo("pka-0", { maxAgeMs: 1_000 });
    expect(inner.snapshotCalls).toBe(3);
    await kube.podInfo("pka-0", { maxAgeMs: 0 });
    expect(inner.snapshotCalls).toBe(4);
  });

  it("shares one call between concurrent readers (single-flight)", async () => {
    const { inner, kube } = setup(5);
    inner.delayMs = 20;
    const results = await Promise.all([...Array(20)].map((_, i) => kube.podInfo(`pka-${i % 5}`, { maxAgeMs: 0 })));
    expect(results.every((r) => r?.ready)).toBe(true);
    expect(inner.snapshotCalls).toBe(1);
  });

  it("drops the snapshot after a write, and does not let a read started before the write answer after it", async () => {
    const { inner, kube } = setup(1);
    await kube.podInfo("pka-0");
    inner.read.pods = [pod("pka-0", false)];
    expect((await kube.podInfo("pka-0"))?.ready).toBe(true); // still cached
    await kube.patchSandbox("pka-0", { spec: { operatingMode: "Suspended" } });
    expect((await kube.podInfo("pka-0"))?.ready).toBe(false);
    expect(inner.snapshotCalls).toBe(2);

    // a snapshot in flight while the write happens is disowned
    inner.delayMs = 20;
    inner.read.pods = [pod("pka-0", true)];
    const before = kube.podInfo("pka-0", { maxAgeMs: 0 });
    await kube.delete("sandbox", "pka-0");
    inner.read.pods = [];
    inner.delayMs = 0;
    expect(await kube.podInfo("pka-0")).toBeNull();
    await before;
    expect(await kube.podInfo("pka-0")).toBeNull(); // the late result did not become the cache
    for (const write of [() => kube.apply({ kind: "Sandbox" }), () => kube.annotatePod("pka-0", { a: "b" }), () => kube.label("pod", "pka-0", { a: "b" })]) {
      await kube.podInfo("pka-0");
      const n = inner.snapshotCalls;
      await write();
      await kube.podInfo("pka-0");
      expect(inner.snapshotCalls).toBe(n + 1);
    }
  });

  it("fails a read when the snapshot fails or hangs, and recovers on the next one", async () => {
    const { inner, kube } = setup(1);
    inner.fail = true;
    await expect(kube.podInfo("pka-0")).rejects.toThrow("boom");
    inner.fail = false;
    expect((await kube.podInfo("pka-0"))?.ready).toBe(true);
    inner.hang = true;
    await expect(kube.podInfo("pka-0", { maxAgeMs: 0 })).rejects.toThrow("took longer");
    inner.hang = false;
    expect((await kube.podInfo("pka-0", { maxAgeMs: 0 }))?.ready).toBe(true);
  });

  it("filters sandboxes and pods by an equality selector and leaves other selectors to the cluster", async () => {
    const { inner, kube } = setup(2);
    inner.read.sandboxes[1]!.labels["paseo.sh/state"] = "warm";
    expect((await kube.listSandboxes("paseo.sh/daemon=d1,paseo.sh/state=warm")).map((s) => s.name)).toEqual(["pka-1"]);
    expect(await kube.listSandboxes("paseo.sh/daemon=other")).toEqual([]);
    expect((await kube.listObjects("pod", "paseo.sh/daemon=d1")).map((o) => o.name)).toEqual(["pka-0", "pka-1"]);
    expect(parseEqualitySelector("a in (b,c)")).toBeNull();
    expect(parseEqualitySelector("!a")).toBeNull();
    inner.sandboxes = [sandbox("viaCluster", { "paseo.sh/daemon in (d1)": "1" })]; // the fake matches a bare key
    expect((await kube.listSandboxes("paseo.sh/daemon in (d1)")).map((s) => s.name)).toEqual(["viaCluster"]);
    expect((await kube.listObjects("service", "x=y")).length).toBe(0); // other kinds go to kubectl
  });

  it("counts spawns, hits and latency, and logs one line a minute", async () => {
    const { kube, stats } = setup(2);
    await kube.podInfo("pka-0");
    await kube.podInfo("pka-1");
    await kube.exec("pka-0", ["true"]);
    expect(stats.take()).toMatch(/kube calls last minute: 2 spawns \(snapshots 1, direct 1\), cache hits 1, latency avg \d+ ms max \d+ ms/);
    expect(stats.take()).toBeUndefined();
  });
});

describe("parseNamespaceRead", () => {
  it("splits a mixed list by kind", () => {
    const read = parseNamespaceRead({
      items: [
        { kind: "Pod", metadata: { name: "p", labels: { a: "b" } }, status: { conditions: [{ type: "Ready", status: "True" }] } },
        { kind: "Sandbox", metadata: { name: "s" }, spec: { operatingMode: "Suspended" } },
      ],
    });
    expect(read.pods.map((p) => [p.name, p.pod?.ready])).toEqual([["p", true]]);
    expect(read.sandboxes.map((s) => [s.name, s.operatingMode])).toEqual([["s", "Suspended"]]);
  });
});
