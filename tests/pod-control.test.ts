import { describe, expect, it, vi } from "vitest";
import { POD_CONTROL_KEY, registerPodControl, type PodControl } from "../server/pod-control.js";

describe("the pod control offered to other plugins", () => {
  it("is found under the shared symbol and forwards suspend and resume with force only when true", async () => {
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

  it("is removed on stop, but never a newer registration", () => {
    const target: Record<symbol, unknown> = {};
    const source = { podControl: async () => ({ ok: true }) };
    const stopOld = registerPodControl(source, target);
    const newer = registerPodControl(source, target);
    stopOld();
    expect(target[POD_CONTROL_KEY]).toBeDefined();
    newer();
    expect(POD_CONTROL_KEY in target).toBe(false);
  });
});
