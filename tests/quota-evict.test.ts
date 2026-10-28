import { describe, expect, it } from "vitest";
import { KubernetesRuntime, QUOTA_MIN_IDLE_MS } from "../server/runtime.js";
import { quotaShortfall, parseQuotaBlock } from "../server/pod-wait.js";
import { PodRegistry } from "../server/registry.js";
import { ConfigSchema } from "../shared/settings.js";
import { FakeKube, fakeSeeder } from "./fakes.js";

const MIN = 60_000;
const GI = 1024 ** 3;
const message = (requested: string, used: string, limited: string) =>
  `Error seen: pods "pka-x" is forbidden: exceeded quota: agents, requested: requests.memory=${requested}, used: requests.memory=${used}, limited: requests.memory=${limited}`;
const block = (requested: string, used: string, limited: string) => parseQuotaBlock({ status: "False", reason: "ReconcilerError", message: message(requested, used, limited) })!;

describe("quotaShortfall", () => {
  it("is requested - (limited - used) in bytes, with Mi and Gi units", () => {
    expect(quotaShortfall(block("8Gi", "33536Mi", "40Gi"))).toBe(0.75 * GI); // 40Gi - 32.75Gi = 7.25Gi free, 8Gi needed
    expect(quotaShortfall(block("8Gi", "30Gi", "40Gi"))).toBe(0);
    expect(quotaShortfall(block("8Gi", "36Gi", "40Gi"))).toBe(4 * GI);
  });
  it("is undefined for a resource that is not memory", () => {
    const b = parseQuotaBlock({ status: "False", reason: "ReconcilerError", message: "exceeded quota: agents, requested: requests.cpu=2, used: requests.cpu=9, limited: requests.cpu=10" })!;
    expect(quotaShortfall(b)).toBeUndefined();
  });
});

function setup(settings: object = {}, extra: object = {}) {
  const kube = new FakeKube();
  const registry = new PodRegistry();
  const logs: string[] = [];
  const finished = new Set<string>();
  let clock = 10_000_000;
  const runtime = new KubernetesRuntime({
    getConfig: async () => ConfigSchema.parse({ readyTimeoutSeconds: 1, podIdleMinutes: 30, ...settings }),
    kubeFor: () => kube,
    daemonId: "srv_ME",
    registry,
    seeder: fakeSeeder,
    detectRepo: async () => ({ url: "https://github.com/lerenn/x.git", branch: "main" }),
    git: async () => ({ code: 1, stdout: "", stderr: "" }),
    sleep: async () => undefined,
    now: () => clock,
    ticker: () => () => undefined,
    log: (l: string) => void logs.push(l),
    workspaceBusy: async () => false,
    agentsFinished: async (id: string) => finished.has(id),
    ...extra,
  });
  const reg = runtime.registration();
  const ctx = { notice: () => undefined, signal: new AbortController().signal };
  const start = async (id: string, labels?: Record<string, string>) => {
    if (labels) runtime.noteAgent(id, labels);
    await reg.prepare!({ workspaceId: id, options: { cwd: `/home/me/${id}`, slug: id, ref: null }, purpose: "session", argv: ["claude"], env: { PASEO_AGENT_ID: `a-${id}` } } as never, ctx);
  };
  const ws = (id: string) => (runtime as any).states.get(id);
  const config = () => ConfigSchema.parse({ podIdleMinutes: 30, ...settings });
  const evict = (requester: string, b = block("8Gi", "36Gi", "40Gi")) => (runtime as any).evictForQuota(ws(requester), "pka-new", b, config());
  const phase = (id: string) => ws(id).phase as string;
  return { runtime, reg, logs, finished, start, ws, evict, phase, advance: (ms: number) => void (clock += ms), activity: (id: string, activity: string) => reg.onActivity!({ workspaceId: id, options: { cwd: `/home/me/${id}`, slug: id, ref: null }, agentId: `a-${id}`, activity } as never) };
}

describe("zero-wait quota eviction", () => {
  it("suspends finished workspaces first, then the longest idle, until enough is freed", async () => {
    const t = setup();
    for (const id of ["req", "old", "newer", "done"]) await t.start(id);
    t.ws("old").lastActivity -= 20 * MIN;
    t.ws("newer").lastActivity -= 10 * MIN;
    t.ws("done").lastActivity -= 5 * MIN;
    t.ws("req").lastActivity -= 40 * MIN;
    t.finished.add("done");
    await t.evict("req", block("8Gi", "36Gi", "40Gi")); // short by 4Gi; each victim frees the requested 8Gi
    expect(t.phase("done")).toBe("suspended");
    expect(t.phase("old")).toBe("running");
    expect(t.phase("req")).toBe("running");
    expect(t.logs.filter((l) => l.includes("quota: suspended"))).toEqual([expect.stringMatching(/quota: suspended .* \(idle 5min\) to start pka-new/)]);
    // a bigger shortfall takes the oldest idle one next, not the newer one
    const t2 = setup();
    for (const id of ["req", "old", "newer"]) await t2.start(id);
    t2.ws("old").lastActivity -= 20 * MIN;
    t2.ws("newer").lastActivity -= 10 * MIN;
    (t2.runtime as any).deps.kubeFor = () => ({ podInfo: async () => ({ uid: "u", ready: true, terminating: false, memoryRequest: "8Gi" }), exec: async () => ({ code: 0, stdout: "", stderr: "" }), patchSandbox: async () => undefined, listSandboxes: async () => [] });
    await t2.evict("req", block("16Gi", "36Gi", "40Gi")); // short by 12Gi, each victim frees 8Gi
    expect([t2.phase("old"), t2.phase("newer")]).toEqual(["suspended", "suspended"]);
    const t3 = setup();
    for (const id of ["req", "old", "newer"]) await t3.start(id);
    t3.ws("old").lastActivity -= 20 * MIN;
    t3.ws("newer").lastActivity -= 10 * MIN;
    await t3.evict("req");
    expect([t3.phase("old"), t3.phase("newer")]).toEqual(["suspended", "running"]);
  });

  it("never touches a busy, exempt, recently active or requesting workspace", async () => {
    const t = setup({ idleExemptLabels: ["paseo.keepalive=1"] }, { agentsBusy: async (id: string) => id === "paseo-busy" });
    await t.start("req");
    await t.start("turn");
    await t.start("perm");
    await t.start("paseo-busy");
    await t.start("exempt", { "paseo.keepalive": "1" });
    await t.start("fresh");
    for (const id of ["req", "turn", "perm", "paseo-busy", "exempt"]) t.ws(id).lastActivity -= 60 * MIN;
    t.activity("turn", "turn_started");
    t.activity("perm", "permission_requested");
    t.ws("turn").lastActivity -= 60 * MIN;
    t.ws("perm").lastActivity -= 60 * MIN;
    t.ws("fresh").lastActivity = (t.ws("fresh").lastActivity as number) - (QUOTA_MIN_IDLE_MS - 1000);
    await t.evict("req");
    for (const id of ["req", "turn", "perm", "paseo-busy", "exempt", "fresh"]) expect(t.phase(id)).toBe("running");
    expect(t.logs.filter((l) => l.includes("quota: suspended"))).toEqual([]);
  });

  it("does not stop a workspace with background work in its pod", async () => {
    const t = setup();
    await t.start("req");
    await t.start("bg");
    t.ws("bg").lastActivity -= 60 * MIN;
    t.ws("req").lastActivity -= 60 * MIN;
    (t as any).runtime.hasBackgroundWork = async (w: { id: string }) => w.id === "bg";
    await t.evict("req");
    expect(t.phase("bg")).toBe("running");
  });

  it("suspends nothing when the idle workspaces would not free enough (the requester keeps waiting)", async () => {
    const t = setup();
    for (const id of ["req", "a", "turn"]) await t.start(id);
    t.ws("a").lastActivity -= 60 * MIN;
    t.activity("turn", "turn_started");
    await t.evict("req", block("20Gi", "30Gi", "40Gi")); // short by 10Gi; "a" frees only the requested 20Gi? make it need more
    expect(t.phase("a")).toBe("suspended"); // 20Gi >= 10Gi: enough
    const u = setup();
    for (const id of ["req", "a", "turn"]) await u.start(id);
    u.ws("a").lastActivity -= 60 * MIN;
    u.activity("turn", "turn_started");
    (u.runtime as any).deps.kubeFor = () => ({ podInfo: async () => ({ uid: "u", ready: true, terminating: false, memoryRequest: "2Gi" }) });
    await u.evict("req", block("8Gi", "36Gi", "40Gi")).catch(() => undefined);
    // frees 2Gi < 4Gi short: nothing suspended
    expect(u.phase("a")).toBe("running");
  });

  it("does nothing with quota.evictIdle off", async () => {
    const t = setup({ quota: { evictIdle: false } });
    for (const id of ["req", "a"]) await t.start(id);
    t.ws("a").lastActivity -= 60 * MIN;
    await t.evict("req");
    expect(t.phase("a")).toBe("running");
  });

  it("final re-check: a workspace used while the decision was made is left running", async () => {
    const t = setup();
    for (const id of ["req", "a"]) await t.start(id);
    t.ws("a").lastActivity -= 60 * MIN;
    (t.runtime as any).confirmedIdle = async (w: { id: string; lastActivity: number }) => {
      if (w.id === "a") w.lastActivity += 1; // input arrived while checking
      return true;
    };
    await t.evict("req");
    expect(t.phase("a")).toBe("running");
  });
});

describe("suspending finished agents", () => {
  it("suspends after the grace, not before, and a resume still works", async () => {
    const t = setup({ finishedGraceSeconds: 30 });
    await t.start("w");
    t.finished.add("w");
    await t.runtime.checkFinished();
    expect(t.phase("w")).toBe("running"); // first seen finished
    t.advance(20_000);
    await t.runtime.checkFinished();
    expect(t.phase("w")).toBe("running");
    t.advance(15_000);
    await t.runtime.checkFinished();
    expect(t.phase("w")).toBe("suspended");
    expect(t.logs.some((l) => l.includes("all its agents are finished"))).toBe(true);
    await t.start("w");
    expect(t.phase("w")).toBe("running");
  });

  it("resets when an agent is alive again, and respects turns and exemptions", async () => {
    const t = setup({ finishedGraceSeconds: 30, idleExemptLabels: ["paseo.keepalive=1"] });
    await t.start("w");
    await t.start("ex", { "paseo.keepalive": "1" });
    t.finished.add("w");
    t.finished.add("ex");
    await t.runtime.checkFinished();
    t.finished.delete("w");
    t.advance(60_000);
    await t.runtime.checkFinished();
    expect(t.phase("w")).toBe("running"); // not finished any more
    t.finished.add("w");
    t.activity("w", "turn_started");
    t.advance(60_000);
    await t.runtime.checkFinished();
    expect(t.phase("w")).toBe("running"); // a turn is open
    expect(t.phase("ex")).toBe("running"); // exempt
  });

  it("is off with finishedGraceSeconds 0", async () => {
    const t = setup({ finishedGraceSeconds: 0 });
    await t.start("w");
    t.finished.add("w");
    t.advance(10 * MIN);
    await t.runtime.checkFinished();
    expect(t.phase("w")).toBe("running");
  });

  it("keeps a pod whose finished agent left background work", async () => {
    const t = setup({ finishedGraceSeconds: 30 });
    await t.start("w");
    t.finished.add("w");
    (t.runtime as any).hasBackgroundWork = async () => true;
    await t.runtime.checkFinished();
    t.advance(60_000);
    await t.runtime.checkFinished();
    expect(t.phase("w")).toBe("running");
  });
});
