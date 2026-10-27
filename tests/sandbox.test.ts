import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../server/config.js";
import { applyProfile } from "../shared/settings.js";
import { buildSandbox, resumePatch, sandboxName, serviceAccountFor } from "../server/sandbox.js";
import { toHttpsRemote } from "../server/workspace.js";

describe("pod profiles", () => {
  const base = ConfigSchema.parse({ image: "default:1", storage: { mode: "persistent", size: "10Gi", storageClassName: "gp3" }, profiles: { "prbr-picky": { image: "go:1.25", storage: { size: "20Gi" }, resources: { requests: { memory: "4Gi" } } } } });

  it("applies a profile's image, volume size and resources, keeping the rest", () => {
    const c = applyProfile(base, "prbr-picky");
    expect(c.image).toBe("go:1.25");
    expect(c.storage).toEqual({ mode: "persistent", size: "20Gi", storageClassName: "gp3" });
    const sb = buildSandbox({ name: "n", workspaceId: "wks_1", cwd: "/x/y", config: c }) as any;
    expect(sb.spec.podTemplate.spec.containers[0].image).toBe("go:1.25");
    expect(sb.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("20Gi");
    expect(sb.spec.podTemplate.spec.containers[0].resources.requests.memory).toBe("4Gi");
  });

  it("changes nothing without a profile and refuses one the settings do not define", () => {
    expect(applyProfile(base, undefined)).toBe(base);
    expect(() => applyProfile(base, "nope")).toThrow(/profile "nope".*prbr-picky/);
  });

  it("refuses a seed that targets the checkout or the home", () => {
    for (const to of ["checkout", ".home/x", "../x", "a/../b", "/abs"]) {
      expect(ConfigSchema.safeParse({ profiles: { p: { seed: [{ from: "/data", to }] } } }).success, to).toBe(false);
    }
    expect(ConfigSchema.safeParse({ profiles: { p: { seed: [{ from: "/data", to: "prbr-picky" }] } } }).success).toBe(true);
  });
});

describe("sandbox manifest", () => {
  const config = ConfigSchema.parse({ image: "go:1", nodeSelector: { pool: "burst" } });

  it("builds a Sandbox in the configured namespace with the configured image", () => {
    const sb = buildSandbox({ name: "pka-x", workspaceId: "wks_1", cwd: "/home/me/repo", config }) as any;
    expect(sb.kind).toBe("Sandbox");
    expect(sb.apiVersion).toBe("agents.x-k8s.io/v1beta1");
    expect(sb.metadata.namespace).toBe("paseo-agents");
    expect(sb.spec.podTemplate.spec.containers[0].image).toBe("go:1");
    expect(sb.spec.podTemplate.spec.nodeSelector).toEqual({ pool: "burst" });
    // v1beta1 has flat shutdown fields; there is no spec.lifecycle. A workspace's storage never expires.
    expect(sb.spec.lifecycle).toBeUndefined();
    expect(sb.spec.shutdownPolicy).toBe("Delete");
    expect(sb.spec.shutdownTime).toBeUndefined();
  });

  it("injects only the Claude token, by reference to the Secret, never inline and never the whole Secret", () => {
    const sb = buildSandbox({ name: "n", workspaceId: "wks_1", cwd: "/home/me/repo", config }) as any;
    const c = sb.spec.podTemplate.spec.containers[0];
    expect(c.envFrom).toBeUndefined();
    expect(c.env).toEqual([
      { name: "HOME", value: "/workspace/.home" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN", valueFrom: { secretKeyRef: { name: "paseo-agent-credentials", key: "CLAUDE_CODE_OAUTH_TOKEN", optional: true } } },
    ]);
    expect(JSON.stringify(sb)).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
  });

  it("runs the pod as the ServiceAccount picked by the agent's labels, and as none otherwise", () => {
    const c = ConfigSchema.parse({ serviceAccounts: [{ label: "paseo.scoped-daemon-access=1", serviceAccount: "paseo-scoped-daemon-access" }] });
    const sa = serviceAccountFor(c, { "paseo.scoped-daemon-access": "1" });
    expect(sa).toBe("paseo-scoped-daemon-access");
    for (const labels of [undefined, {} as Record<string, string>, { "paseo.scoped-daemon-access": "0" }]) expect(serviceAccountFor(c, labels)).toBeUndefined();
    const spec = (sb: any) => sb.spec.podTemplate.spec;
    const withSa = buildSandbox({ name: "n", workspaceId: "wks_1", cwd: "/x/y", config: c, serviceAccount: sa }) as any;
    expect(spec(withSa)).toMatchObject({ serviceAccountName: "paseo-scoped-daemon-access", automountServiceAccountToken: true });
    expect(withSa.spec.podTemplate.metadata.labels["paseo.sh/service-account"]).toBe("paseo-scoped-daemon-access");
    const without = buildSandbox({ name: "n", workspaceId: "wks_1", cwd: "/x/y", config: c }) as any;
    expect(spec(without).serviceAccountName).toBeUndefined();
    expect(spec(without).automountServiceAccountToken).toBe(false);
    // a warm pod waits for any workspace, so it never has one
    const warm = buildSandbox({ name: "n", config: c, warm: true, serviceAccount: sa }) as any;
    expect(spec(warm).serviceAccountName).toBeUndefined();
    expect(resumePatch(c, undefined, sa).spec.podTemplate.spec).toMatchObject({ serviceAccountName: "paseo-scoped-daemon-access" });
    expect(resumePatch(c).spec.podTemplate.spec).toMatchObject({ serviceAccountName: null, automountServiceAccountToken: false });
  });

  it("applies the node selector and tolerations", () => {
    const c = ConfigSchema.parse({
      nodeSelector: { "lab.anyshift.io/pool": "burst" },
      tolerationKeys: ["lab.anyshift.io/burst"],
    });
    const spec = (buildSandbox({ name: "n", workspaceId: "wks_1", cwd: "/home/me/repo", config: c }) as any).spec.podTemplate.spec;
    expect(spec.nodeSelector).toEqual({ "lab.anyshift.io/pool": "burst" });
    expect(spec.tolerations).toEqual([{ key: "lab.anyshift.io/burst", operator: "Exists" }]);
  });

  it("passes resources through when set", () => {
    const c = ConfigSchema.parse({ resources: { requests: { cpu: "1" } } });
    expect((buildSandbox({ name: "n", workspaceId: "wks_1", cwd: "/home/me/repo", config: c }) as any).spec.podTemplate.spec.containers[0].resources).toEqual({ requests: { cpu: "1" } });
  });

  it("makes DNS-safe names", () => {
    expect(sandboxName("Wks_ID/With Weird!")).toMatch(/^pka-wks-id-with-weird-[0-9a-f]{6}$/);
  });
});

describe("toHttpsRemote", () => {
  it("rewrites ssh remotes", () => {
    expect(toHttpsRemote("git@github.com:lerenn/x.git")).toBe("https://github.com/lerenn/x.git");
    expect(toHttpsRemote("ssh://git@github.com/lerenn/x.git")).toBe("https://github.com/lerenn/x.git");
    expect(toHttpsRemote("https://github.com/a/b")).toBe("https://github.com/a/b");
  });
});
