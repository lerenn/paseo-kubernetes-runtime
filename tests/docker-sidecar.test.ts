import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../server/config.js";
import { applyProfile, dockerEnabled, dockerMode } from "../shared/settings.js";
import { buildSandbox, resumePatch, specHash } from "../server/sandbox.js";
import { waitDockerSidecar } from "../server/docker-sidecar.js";

const cfg = (extra: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ image: "agent:1", storage: { mode: "persistent", size: "10Gi" }, profiles: { sc: { docker: "sidecar" }, sb: { docker: "sandbox" }, legacy: { docker: true }, off: { docker: false }, none: {} }, ...extra });
const pod = (sb: any) => sb.spec.podTemplate;

describe("docker mode", () => {
  it("profile wins over dockerDefault; no-profile workspaces use the default", () => {
    const c = cfg({ dockerDefault: "sidecar" });
    expect(dockerMode(c, "sc")).toBe("sidecar");
    expect(dockerMode(c, "off")).toBe("off");
    expect(dockerMode(c, "none")).toBe("sidecar");
    expect(dockerMode(c, undefined)).toBe("sidecar");
    expect(dockerMode(cfg(), undefined)).toBe("off");
    expect(dockerMode(cfg({ dockerDefault: "sandbox" }), "sc")).toBe("sidecar");
  });

  it("keeps docker: true and 'sandbox' as the paseo-docker sandbox", () => {
    const c = cfg();
    expect(dockerEnabled(c, "legacy")).toBe(true);
    expect(dockerEnabled(c, "sb")).toBe(true);
    expect(dockerEnabled(c, "sc")).toBe(false);
    expect(dockerEnabled(c, undefined)).toBe(false);
  });
});

describe("sidecar sandbox", () => {
  const c = applyProfile(cfg(), "sc");
  const sb = buildSandbox({ name: "pka-x", workspaceId: "w1", cwd: "/home/u/repo", config: c, dockerSidecar: true }) as any;
  const [agent, dockerd] = pod(sb).spec.containers;

  it("adds a privileged dockerd container bound to loopback", () => {
    expect(pod(sb).spec.containers.map((x: any) => x.name)).toEqual(["agent", "dockerd"]);
    expect(dockerd.securityContext.privileged).toBe(true);
    expect(dockerd.image).toBe("docker:dind");
    expect(dockerd.args).toContain("--host=tcp://127.0.0.1:2375");
    expect(dockerd.args.join(" ")).not.toContain("0.0.0.0");
    expect(dockerd.env).toContainEqual({ name: "DOCKER_TLS_CERTDIR", value: "" });
  });

  it("mounts the workspace volume at the agent's paths plus an emptyDir for /var/lib/docker", () => {
    expect(dockerd.volumeMounts).toEqual([
      { name: "docker-data", mountPath: "/var/lib/docker" },
      { name: "workspace", mountPath: "/workspace" },
      { name: "workspace", mountPath: "/home/u/repo", subPath: "checkout" },
    ]);
    expect(pod(sb).spec.volumes).toEqual([{ name: "docker-data", emptyDir: {} }]);
  });

  it("limits resources and leaves the agent's own requests alone", () => {
    expect(dockerd.resources.requests).toEqual({ cpu: "10m", memory: "64Mi" });
    expect(dockerd.resources.limits).toEqual({ memory: "8Gi", "ephemeral-storage": "20Gi" });
    expect(agent.resources).toBeUndefined();
  });

  it("sets DOCKER_HOST and labels, without the paseo-docker sandbox label", () => {
    expect(agent.env).toContainEqual({ name: "DOCKER_HOST", value: "tcp://127.0.0.1:2375" });
    expect(pod(sb).metadata.labels["paseo.sh/docker-sidecar"]).toBe("1");
    expect(pod(sb).metadata.labels["paseo.sh/docker"]).toBe("1");
    expect(pod(sb).metadata.labels["paseo.sh/sandbox"]).toBeUndefined();
  });

  it("honours dockerSidecar.image and resources; an ephemeral workspace keeps its emptyDir", () => {
    const c2 = cfg({ dockerSidecar: { image: "ecr/dind:1", resources: { limits: { memory: "2Gi" } } }, storage: { mode: "ephemeral" } });
    const x = pod(buildSandbox({ name: "n", workspaceId: "w", cwd: "/x", config: c2, dockerSidecar: true })).spec;
    expect(x.containers[1].image).toBe("ecr/dind:1");
    expect(x.containers[1].resources.limits).toEqual({ memory: "2Gi" });
    expect(x.volumes.map((v: any) => v.name)).toEqual(["workspace", "docker-data"]);
  });

  it("is not added to warm pods and does not mix with the sandbox", () => {
    expect(pod(buildSandbox({ name: "n", config: c, warm: true, dockerSidecar: true })).spec.containers).toHaveLength(1);
    const both = buildSandbox({ name: "n", workspaceId: "w", cwd: "/x", config: c, docker: true, dockerSidecar: true }) as any;
    expect(pod(both).spec.containers).toHaveLength(1);
    expect(pod(both).metadata.labels["paseo.sh/docker-sidecar"]).toBeUndefined();
  });

  it("changes the spec hash only when on", () => {
    expect(specHash(c, "/x", undefined, false, true)).not.toBe(specHash(c, "/x"));
  });

  it("changes nothing for a pod without docker, and docker: true still points at the sandbox", () => {
    const plain = buildSandbox({ name: "n", workspaceId: "w", cwd: "/x", config: c }) as any;
    expect(pod(plain).spec.containers).toHaveLength(1);
    expect(pod(plain).spec.volumes).toBeUndefined();
    const legacy = buildSandbox({ name: "n", workspaceId: "w", cwd: "/x", config: c, docker: true }) as any;
    expect(pod(legacy).spec.containers[0].env).toContainEqual({ name: "DOCKER_HOST", value: "tcp://docker-n.paseo-docker.svc.cluster.local:2375" });
    expect(pod(legacy).metadata.labels["paseo.sh/sandbox"]).toBe("n");
  });
});

describe("resumePatch", () => {
  const c = cfg();
  it("adds the sidecar to an existing workspace on resume", () => {
    const p = resumePatch(c, "/x", undefined, undefined, true) as any;
    expect(p.spec.podTemplate.spec.containers.map((x: any) => x.name)).toEqual(["agent", "dockerd"]);
    expect(p.spec.podTemplate.spec.volumes).toEqual([{ name: "docker-data", emptyDir: {} }]);
    expect(p.spec.podTemplate.metadata.labels["paseo.sh/docker-sidecar"]).toBe("1");
    expect(p.spec.podTemplate.spec.containers[0].env).toContainEqual({ name: "DOCKER_HOST", value: "tcp://127.0.0.1:2375" });
  });

  it("removes it again when the mode is switched off", () => {
    const p = resumePatch(c, "/x") as any;
    expect(p.spec.podTemplate.spec.containers.map((x: any) => x.name)).toEqual(["agent"]);
    expect(p.spec.podTemplate.spec.volumes).toBeNull();
    expect(p.spec.podTemplate.metadata.labels["paseo.sh/docker-sidecar"]).toBeNull();
    expect(p.spec.podTemplate.metadata.labels["paseo.sh/docker"]).toBeNull();
  });

  it("keeps the sandbox resume as it was", () => {
    const p = resumePatch(c, "/x", undefined, { sandbox: "pka-1" }) as any;
    expect(p.spec.podTemplate.spec.containers).toHaveLength(1);
    expect(p.spec.podTemplate.metadata.labels["paseo.sh/sandbox"]).toBe("pka-1");
    expect(p.spec.podTemplate.metadata.labels["paseo.sh/docker-sidecar"]).toBeNull();
  });
});

describe("waitDockerSidecar", () => {
  it("returns the seconds docker info took", async () => {
    let t = 0;
    let calls = 0;
    const kube = { exec: async () => ({ code: ++calls < 3 ? 1 : 0, stdout: "", stderr: "" }) };
    expect(await waitDockerSidecar(kube as any, "p", { now: () => t, sleep: async (ms) => void (t += ms) })).toBe(4);
  });

  it("gives up after the timeout without throwing", async () => {
    let t = 0;
    const kube = { exec: async () => { throw new Error("no"); } };
    const s = await waitDockerSidecar(kube as any, "p", { timeoutSeconds: 60, now: () => t, sleep: async (ms) => void (t += ms) });
    expect(s).toBeUndefined();
    expect(t).toBeGreaterThanOrEqual(60_000);
  });
});
