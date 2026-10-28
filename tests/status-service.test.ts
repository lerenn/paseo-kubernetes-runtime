import { describe, expect, it } from "vitest";
import { PodRowsService, type StatusSources } from "../server/status-service.js";
import { parsePodInfo } from "../server/kube.js";
import { describeLastTerminated } from "../server/runtime.js";

const later = <T = void>(ms: number, value?: T) => new Promise<T>((r) => setTimeout(() => r(value as T), ms));

const cluster = (names: string[]) => ({
  sandboxes: names.map((name) => ({
    name,
    labels: { "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": `wks_${name}` },
    annotations: { "paseo.sh/cwd": `/w/${name}` },
    operatingMode: "Running" as const,
  })),
  claims: [],
  pods: new Map(names.map((n) => [n, { uid: "u", ready: true, terminating: false }])),
});

function sources(over: Partial<StatusSources> = {}) {
  const calls = { titles: 0, agents: 0, cluster: 0, docker: 0 };
  const src: StatusSources = {
    titles: async () => (calls.titles++, new Map([["wks_a", "Alpha"]])),
    agents: async () => (calls.agents++, [{ id: "ag", title: "claude", status: "running", cwd: "/w/a" }]),
    cluster: async () => (calls.cluster++, cluster(["a"])),
    docker: async () => (calls.docker++, new Map()),
    entries: () => [],
    oom: () => new Map(),
    ...over,
  };
  return { src, calls };
}

describe("the pod rows service", () => {
  it("reads every source once for concurrent callers and keeps the rows for the ttl", async () => {
    const { src, calls } = sources();
    const svc = new PodRowsService(src, { ttlMs: 60_000 });
    const [a, b] = await Promise.all([svc.rows(), svc.rows()]);
    await svc.rows();
    expect(calls).toEqual({ titles: 1, agents: 1, cluster: 1, docker: 1 });
    expect(a.value).toEqual(b.value);
    expect(a.value[0]).toMatchObject({ title: "Alpha", state: "running", agents: [{ id: "ag" }] });
    expect(a.stale).toBe(false);
  });

  it("does not wait on a slow daemon call: it uses the last good value, or none the first time", async () => {
    let slow = false;
    const { src } = sources({
      agents: async () => (slow ? later(500, []) : [{ id: "ag", title: "claude", status: "running", cwd: "/w/a" }]),
      titles: async () => (slow ? later(500, new Map()) : new Map([["wks_a", "Alpha"]])),
    });
    const svc = new PodRowsService(src, { ttlMs: 0, daemonMs: 20 });
    expect((await svc.rows()).value[0]!.agents).toHaveLength(1);
    slow = true;
    const started = Date.now();
    const again = await svc.rows();
    expect(Date.now() - started).toBeLessThan(300);
    expect(again.value[0]).toMatchObject({ title: "Alpha", agents: [{ id: "ag" }] }); // from the last good reads
    // first ever read with slow daemon calls: the rows come without titles and agents
    const fresh = new PodRowsService(src, { ttlMs: 0, daemonMs: 20 });
    expect((await fresh.rows()).value[0]).toMatchObject({ title: "wks_a", agents: [] });
  });

  it("uses the last cluster read when the cluster is slow, and fails if it never answered", async () => {
    let slow = false;
    const { src } = sources({ cluster: async () => (slow ? later(500, cluster(["b"])) : cluster(["a"])) });
    const svc = new PodRowsService(src, { ttlMs: 0, clusterMs: 20 });
    await svc.rows();
    slow = true;
    expect((await svc.rows()).value.map((r) => r.sandbox)).toEqual(["a"]);
    await expect(new PodRowsService(src, { ttlMs: 0, clusterMs: 20 }).rows()).rejects.toThrow(/cluster/);
  });

  it("serves the earlier rows flagged stale while a slow refresh runs", async () => {
    let slow = false;
    const { src } = sources({ cluster: async () => (slow ? later(300, cluster(["a", "b"])) : cluster(["a"])) });
    const svc = new PodRowsService(src, { ttlMs: 0, softMs: 30, clusterMs: 1_000 });
    await svc.rows();
    slow = true;
    const first = await svc.rows(); // starts the refresh, waits softMs, gives the old rows
    expect(first).toMatchObject({ stale: true });
    expect(first.value).toHaveLength(1);
    const second = await svc.rows(); // the refresh is still running: answered at once
    expect(second.stale).toBe(true);
    await later(350);
    expect((await svc.rows()).value.length).toBe(2);
  });
});

describe("what a killed container leaves in the pod status", () => {
  const pod = (containerStatuses: unknown[]) => ({ metadata: { uid: "u" }, status: { phase: "Running", containerStatuses } });

  it("reads the last terminated state (lastState or state) and words it for the log", () => {
    const info = parsePodInfo(pod([{ name: "workspace", lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-28T10:16:00Z" } } }]));
    expect(info.lastTerminated).toEqual({ container: "workspace", reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-28T10:16:00Z" });
    expect(info.oomKilled).toBe(true);
    expect(describeLastTerminated(info)).toBe(" [container workspace last terminated: OOMKilled, exit code 137, at 2026-10-28T10:16:00Z]");
    const err = parsePodInfo(pod([{ name: "workspace", state: { terminated: { reason: "Error", exitCode: 1 } } }]));
    expect(describeLastTerminated(err)).toBe(" [container workspace last terminated: Error, exit code 1]");
    expect(err.oomKilled).toBeUndefined();
  });

  it("says nothing when the pod reports no ended container", () => {
    expect(describeLastTerminated(parsePodInfo(pod([{ name: "workspace", state: { running: {} } }])))).toBe("");
    expect(describeLastTerminated(null)).toBe("");
  });
});
