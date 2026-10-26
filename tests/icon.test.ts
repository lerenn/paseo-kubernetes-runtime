import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KubernetesRuntime } from "../server/runtime.js";
import { ConfigSchema } from "../shared/settings.js";
import { FakeKube } from "./fakes.js";

describe("the Kubernetes Runtime icon", () => {
  const file = (name: string) => readFileSync(join(__dirname, "..", name), "utf8");

  it("is the Lucide ship wheel, as the runtime's icon file and in the sidebar and the Pod option", () => {
    const runtime = new KubernetesRuntime({ getConfig: async () => ConfigSchema.parse({}), kubeFor: () => new FakeKube() });
    expect(runtime.registration().icon).toBe("icons/ship-wheel.svg");
    expect(file("index.client.tsx")).toContain('icon="ShipWheel"');
    expect(file("client/pod-location.tsx")).toContain('icon: "ShipWheel"');
    expect(file("index.client.tsx") + file("client/pod-location.tsx")).not.toMatch(/"Container"|"Box"/);
  });

  it("follows Paseo's SVG rules: one document under 64 KiB, painted with currentColor, no script, style or handlers", () => {
    const svg = file("icons/ship-wheel.svg");
    expect(svg.length).toBeLessThan(64 * 1024);
    expect(svg.match(/<svg/g)).toHaveLength(1);
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).not.toMatch(/<script|<style|<foreignObject|\son\w+=|javascript:/i);
    expect(svg.match(/<(circle|path)/g)).toHaveLength(10); // Lucide's ship-wheel: two circles and eight spokes
  });
});
