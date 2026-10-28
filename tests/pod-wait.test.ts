import { describe, expect, it } from "vitest";
import type { PodInfo, SandboxInfo } from "../server/kube.js";
import { parseQuotaBlock, quotaFailure, quotaNotice, waitPodReady } from "../server/pod-wait.js";

const MESSAGE =
  'Error seen: pods "pka-x" is forbidden: exceeded quota: agents, requested: requests.memory=8Gi, used: requests.memory=35Gi, limited: requests.memory=40Gi';
const blocked = (message = MESSAGE): SandboxInfo => ({
  name: "pka-x",
  labels: {},
  annotations: {},
  operatingMode: "Running",
  ready: { status: "False", reason: "ReconcilerError", message },
});

describe("parseQuotaBlock", () => {
  it("reads the quota, resource and quantities", () => {
    expect(parseQuotaBlock(blocked().ready)).toEqual({ quota: "agents", resource: "requests.memory", requested: "8Gi", used: "35Gi", limited: "40Gi" });
  });

  it("names the resource that does not fit when the quota has several", () => {
    const message =
      "pods is forbidden: exceeded quota: agents, requested: limits.memory=1Gi,requests.cpu=2,requests.memory=8Gi, used: limits.memory=1Gi,requests.cpu=1,requests.memory=35Gi, limited: limits.memory=64Gi,requests.cpu=10,requests.memory=40Gi";
    expect(parseQuotaBlock(blocked(message).ready)).toMatchObject({ resource: "requests.memory", requested: "8Gi" });
  });

  it("ignores other conditions and errors", () => {
    expect(parseQuotaBlock(undefined)).toBeUndefined();
    expect(parseQuotaBlock({ status: "False", reason: "ReconcilerError", message: "Error seen: something else" })).toBeUndefined();
    expect(parseQuotaBlock({ status: "False", reason: "Other", message: MESSAGE })).toBeUndefined();
  });

  it("words the notice and the failure", () => {
    const block = parseQuotaBlock(blocked().ready)!;
    expect(quotaNotice(block)).toBe("Queued: namespace quota 'agents' is full (requests.memory 35Gi of 40Gi used, this pod needs 8Gi). It starts by itself when a pod ends.");
    expect(quotaFailure(block)).toBe("namespace quota 'agents' exceeded (requests.memory used 35Gi of 40Gi, needs 8Gi)");
  });
});

describe("waitPodReady with a full quota", () => {
  const pod = (ready: boolean): PodInfo => ({ ready, terminating: false, uid: "u" }) as PodInfo;
  function harness(podAt: (call: number) => PodInfo | null, sandbox?: SandboxInfo) {
    let t = 0;
    let calls = 0;
    const kube = { podInfo: async () => podAt(calls++) } as any;
    return {
      kube,
      options: { timeoutSeconds: 10, pollMs: 1000, sleep: async (ms: number) => void (t += ms), now: () => t, sandbox: async () => sandbox },
    };
  }

  it("shows the notice once, keeps waiting, then succeeds when the pod appears", async () => {
    const { kube, options } = harness((n) => (n < 3 ? null : pod(true)), blocked());
    const notices: string[] = [];
    const info = await waitPodReady(kube, "pka-x", { ...options, onProblem: (m) => notices.push(m) });
    expect(info.ready).toBe(true);
    expect(notices).toEqual([expect.stringContaining("Queued: namespace quota 'agents' is full")]);
  });

  it("tells onQuota about the block on every poll while it holds", async () => {
    const { kube, options } = harness((n) => (n < 2 ? null : pod(true)), blocked());
    const seen: string[] = [];
    await waitPodReady(kube, "pka-x", { ...options, onQuota: (b) => seen.push(b.requested) });
    expect(seen).toEqual(["8Gi", "8Gi"]);
  });

  it("fails naming the quota instead of 'it does not exist'", async () => {
    const { kube, options } = harness(() => null, blocked());
    await expect(waitPodReady(kube, "pka-x", options)).rejects.toThrow(
      "Pod pka-x was not ready after 10s: namespace quota 'agents' exceeded (requests.memory used 35Gi of 40Gi, needs 8Gi)",
    );
  });

  it("keeps the old message when the Sandbox has no quota error", async () => {
    const { kube, options } = harness(() => null, blocked("Error seen: boom"));
    await expect(waitPodReady(kube, "pka-x", options)).rejects.toThrow("Pod pka-x was not ready after 10s (it does not exist)");
    const none = harness(() => null);
    await expect(waitPodReady(none.kube, "pka-x", none.options)).rejects.toThrow("(it does not exist)");
  });
});
