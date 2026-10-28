import { describe, expect, it } from "vitest";
import { BRIDGE_EXEC_LIMIT, KubernetesRuntime } from "../server/runtime.js";
import { PodRegistry } from "../server/registry.js";
import { ConfigSchema } from "../shared/settings.js";
import { FakeKube, fakeSeeder } from "./fakes.js";

const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup(kube: FakeKube) {
  const logs: string[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const runtime = new KubernetesRuntime({
    getConfig: async () => ConfigSchema.parse({ readyTimeoutSeconds: 1 }),
    kubeFor: () => kube,
    daemonId: "srv_ME",
    registry: new PodRegistry(),
    seeder: fakeSeeder,
    sleep: async (ms) => void sleeps.push(ms),
    jitter: () => 0.5,
    now: () => clock,
    ticker: () => () => undefined,
    log: (line: string) => void logs.push(line),
  });
  const addRunning = (n: number) => {
    const states = (runtime as unknown as { states: Map<string, unknown> }).states;
    for (let i = 0; i < n; i++) {
      states.set(`wks_${i}`, { id: `wks_${i}`, options: { cwd: `/w/${i}`, slug: `s${i}`, ref: null }, phase: "running", sandbox: `pod-${i}`, bridge: { close() {} }, ports: new Set(), wantPorts: new Set(), targets: [], commands: new Set(), agents: new Map(), lastActivity: 0, chain: Promise.resolve() });
    }
  };
  return { runtime, logs, sleeps, addRunning, advance: (ms: number) => void (clock += ms) };
}

describe("bridge liveness probes under load", () => {
  it("runs at most BRIDGE_EXEC_LIMIT probe execs at once, with a jitter before each", async () => {
    const kube = new FakeKube();
    let active = 0;
    let max = 0;
    kube.exec = async () => {
      active++;
      max = Math.max(max, active);
      await later(5);
      active--;
      return { code: 0, stdout: "", stderr: "" };
    };
    const t = setup(kube);
    t.addRunning(12);
    t.runtime.checkBridges();
    await later(120);
    expect(max).toBe(BRIDGE_EXEC_LIMIT);
    expect(t.sleeps).toHaveLength(12);
    expect(t.sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("logs the probe count and latency once a minute, and nothing when none ran", async () => {
    const kube = new FakeKube();
    kube.exec = async () => ({ code: 7, stdout: "", stderr: "" }); // the bridge does not answer
    const t = setup(kube);
    t.runtime.logProbeStats();
    expect(t.logs).toEqual([]);
    t.addRunning(3);
    t.runtime.checkBridges();
    await later(50);
    t.runtime.logProbeStats();
    const line = t.logs.find((l) => l.includes("bridge probes last minute"))!;
    expect(line).toMatch(/: 3 \(down 3, errors 0\), latency avg \d+ ms max \d+ ms/);
    expect(line).toMatch(/kube execs at once \d\/4/);
    t.logs.length = 0;
    t.runtime.logProbeStats();
    expect(t.logs).toEqual([]); // counters were reset
  });
});

describe("the workspace details", () => {
  it("answers the same display for a couple of seconds per workspace, and again after a state change", async () => {
    const t = setup(new FakeKube());
    t.addRunning(1);
    const reg = t.runtime.registration();
    const req = { workspaceId: "wks_0" } as never;
    const first = reg.describeWorkspace!(req);
    expect(reg.describeWorkspace!(req)).toBe(first); // same object: not rebuilt
    t.advance(2_001);
    expect(reg.describeWorkspace!(req)).not.toBe(first);
  });
});
