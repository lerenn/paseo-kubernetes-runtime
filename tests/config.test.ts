import { describe, expect, it } from "vitest";
import { ConfigSchema, kubeSettings, migrateSettings } from "../shared/settings.js";

describe("settings schema", () => {
  it("parses an empty document into a complete flat config", () => {
    const c = ConfigSchema.parse({});
    expect(c.namespace).toBe("paseo-agents");
    expect(c.credentialsSecret).toBe("paseo-agent-credentials");
    expect(c.image).toMatch(/paseo-kubernetes-runtime-default/);
    expect(c).not.toHaveProperty("templates");
  });

  it("is version 2 with a migration", () => {
    expect(kubeSettings.version).toBe(2);
    expect(kubeSettings.migrate).toBeDefined();
  });
});

describe("migrating v1 settings (templates) to the flat configuration", () => {
  const migrate = (v: object) => ConfigSchema.parse(migrateSettings(v, 1));

  it("folds the default template's image, resources and placement into the flat settings", () => {
    const c = migrate({
      namespace: "ns",
      defaultImage: "node:22-bookworm",
      nodeSelector: {},
      tolerationKeys: [],
      templates: {
        default: {
          image: "go:1",
          resources: { requests: { cpu: "2" } },
          nodeSelector: { pool: "burst" },
          tolerations: [{ key: "burst", operator: "Exists" }],
          warmPool: { enabled: true, size: 2, idleTimeoutSeconds: 900 },
        },
        go: { image: "other" },
      },
    });
    expect(c.namespace).toBe("ns");
    expect(c.image).toBe("go:1");
    expect(c.resources).toEqual({ requests: { cpu: "2" } });
    expect(c.nodeSelector).toEqual({ pool: "burst" });
    expect(c.tolerationKeys).toEqual(["burst"]);
    expect(c).not.toHaveProperty("templates");
  });

  it("keeps defaultImage and the global placement when the default template has none (Louis's setup)", () => {
    const c = migrate({
      defaultImage: "node:22-bookworm",
      nodeSelector: { "lab.anyshift.io/pool": "burst" },
      tolerationKeys: ["lab.anyshift.io/burst"],
      templates: {},
    });
    expect(c.image).toBe("node:22-bookworm");
    expect(c.nodeSelector).toEqual({ "lab.anyshift.io/pool": "burst" });
    expect(c.tolerationKeys).toEqual(["lab.anyshift.io/burst"]);
  });

  it("leaves current documents alone", () => {
    const doc = { image: "x" };
    expect(migrateSettings(doc, 2)).toBe(doc);
  });
});

describe("profile nodeSelector", () => {
  it("is merged over the global nodeSelector", async () => {
    const { applyProfile } = await import("../shared/settings.js");
    const config = ConfigSchema.parse({ nodeSelector: { pool: "agents", "karpenter.sh/capacity-type": "spot" }, profiles: { builder: { nodeSelector: { "karpenter.sh/capacity-type": "on-demand" } } } });
    expect(applyProfile(config, "builder").nodeSelector).toEqual({ pool: "agents", "karpenter.sh/capacity-type": "on-demand" });
    expect(applyProfile(config, undefined).nodeSelector["karpenter.sh/capacity-type"]).toBe("spot");
  });
});

describe("profile memory request above the global limit (prbr-picky, 2026-10-29)", () => {
  it("raises the limit to the request, and leaves a fitting one alone", async () => {
    const { fitMemoryLimit, quantityBytes } = await import("../shared/settings.js");
    expect(quantityBytes("768Mi")).toBe(768 * 2 ** 20);
    expect(quantityBytes("1G")).toBe(1e9);
    expect(Number.isNaN(quantityBytes("lots"))).toBe(true);
    expect(fitMemoryLimit({ requests: { cpu: "1", memory: "4Gi" }, limits: { memory: "3Gi" } })).toEqual({ requests: { cpu: "1", memory: "4Gi" }, limits: { memory: "4Gi" } });
    const ok = { requests: { memory: "2Gi" }, limits: { memory: "3Gi" } };
    expect(fitMemoryLimit(ok)).toBe(ok);
  });
});
