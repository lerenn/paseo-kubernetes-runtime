import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../server/config.js";
import { buildSandbox, sandboxName } from "../server/sandbox.js";
import { toHttpsRemote } from "../server/workspace.js";

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
    const c = ConfigSchema.parse({ serviceAccounts: [{ label: "paseo.ops=1", serviceAccount: "paseo-ops" }] });
    const spec = (labels?: Record<string, string>) =>
      (buildSandbox({ name: "n", workspaceId: "wks_1", cwd: "/home/me/repo", config: c, agentLabels: labels }) as any).spec.podTemplate.spec;
    expect(spec({ "paseo.ops": "1" })).toMatchObject({ serviceAccountName: "paseo-ops", automountServiceAccountToken: true });
    for (const labels of [undefined, {} as Record<string, string>, { "paseo.ops": "0" }]) {
      expect(spec(labels).serviceAccountName).toBeUndefined();
      expect(spec(labels).automountServiceAccountToken).toBe(false);
    }
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
