import { describe, expect, it, vi } from "vitest";
import { POD_CONTROL_KEY, registerPodControl, WORKSPACE_CONTROL_KEY, type PodControl, type WorkspaceControl } from "../server/pod-control.js";

const registry = (target: Record<symbol, unknown>) => target[WORKSPACE_CONTROL_KEY] as Record<string, WorkspaceControl | undefined> | undefined;

describe("the workspace control offered to other plugins", () => {
  it("is registered under the generic registry as kubernetes, and forwards suspend and wake with force only when true", async () => {
    const target: Record<symbol, unknown> = {};
    const podControl = vi.fn(async () => ({ ok: true }));
    registerPodControl({ podControl }, target);
    expect(Symbol.for("paseo.workspace-control")).toBe(WORKSPACE_CONTROL_KEY);
    const control = registry(target)!.kubernetes!;
    await control.suspend("w1", { force: true });
    await control.suspend("w1", { force: "yes" as never });
    await control.suspend("w1");
    await control.wake("w1");
    expect(podControl.mock.calls).toEqual([
      ["w1", "suspend", { force: true }],
      ["w1", "suspend", { force: false }],
      ["w1", "suspend", { force: false }],
      ["w1", "resume", { force: false }],
    ]);
  });

  it("relays the Runtime's answer (a busy refusal) unchanged", async () => {
    const target: Record<symbol, unknown> = {};
    registerPodControl({ podControl: async () => ({ ok: false, busy: "an agent is running" }) }, target);
    expect(await registry(target)!.kubernetes!.suspend("w1", {})).toEqual({ ok: false, busy: "an agent is running" });
  });

  it("keeps other runtimes' entries in the registry", () => {
    const other = { suspend: async () => ({ ok: true }), wake: async () => ({ ok: true }) };
    const target: Record<symbol, unknown> = { [WORKSPACE_CONTROL_KEY]: { other } };
    const stop = registerPodControl({ podControl: async () => ({ ok: true }) }, target);
    expect(registry(target)!.other).toBe(other);
    stop();
    expect(registry(target)!.other).toBe(other);
    expect(registry(target)!.kubernetes).toBeUndefined();
  });

  it("still offers the legacy key for an older Factory", async () => {
    const target: Record<symbol, unknown> = {};
    const podControl = vi.fn(async () => ({ ok: true }));
    registerPodControl({ podControl }, target);
    const control = target[POD_CONTROL_KEY] as PodControl;
    expect(Symbol.for("paseo.kubernetes-runtime")).toBe(POD_CONTROL_KEY);
    await control.podAction("w1", "suspend", { force: true });
    await control.podAction("w1", "resume", {});
    await control.podAction("w1", "suspend", { force: "yes" as never });
    expect(podControl.mock.calls).toEqual([["w1", "suspend", { force: true }], ["w1", "resume", { force: false }], ["w1", "suspend", { force: false }]]);
  });

  it("is removed on stop, both keys, but never a newer registration", () => {
    const target: Record<symbol, unknown> = {};
    const source = { podControl: async () => ({ ok: true }) };
    const stopOld = registerPodControl(source, target);
    const newer = registerPodControl(source, target);
    stopOld();
    expect(target[POD_CONTROL_KEY]).toBeDefined();
    expect(registry(target)!.kubernetes).toBeDefined();
    newer();
    expect(POD_CONTROL_KEY in target).toBe(false);
    expect(registry(target)!.kubernetes).toBeUndefined();
  });
});
