import { describe, expect, it } from "vitest";
import { buildDockerNetworkPolicy, buildDockerPod, buildDockerService } from "../server/docker-sandbox.js";
import { KubernetesRuntime } from "../server/runtime.js";
import { OrphanReaper } from "../server/orphans.js";
import { PodRegistry } from "../server/registry.js";
import { buildSandbox } from "../server/sandbox.js";
import { buildPodRows } from "../server/status.js";
import { ConfigSchema } from "../shared/settings.js";
import { FakeKube, fakeSeeder } from "./fakes.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const CWD = "/home/me/repo";
const START = 1_000_000;

function setup(settings: object = {}, extra: object = {}) {
  const kube = new FakeKube();
  kube.clock = () => START;
  const namespaces: string[] = [];
  let clock = START;
  const runtime = new KubernetesRuntime({
    getConfig: async () => ConfigSchema.parse({ readyTimeoutSeconds: 1, podIdleMinutes: 30, profiles: { docker: { docker: true }, plain: {} }, ...settings }),
    kubeFor: (c) => (namespaces.push(c.namespace), kube),
    daemonId: "srv_ME",
    registry: new PodRegistry(),
    seeder: fakeSeeder,
    detectRepo: async () => ({ url: "https://github.com/lerenn/x.git", branch: "main" }),
    git: async () => ({ code: 1, stdout: "", stderr: "" }),
    sleep: async () => undefined,
    now: () => clock,
    ticker: () => () => undefined,
    log: () => undefined,
    workspaceBusy: async () => false,
    ...extra,
  });
  const reg = runtime.registration();
  const ctx = { notice: () => undefined, signal: new AbortController().signal };
  const base = (profile?: string) => ({ workspaceId: "wks_1", options: { cwd: CWD, slug: "brave-otter-12", ref: null, ...(profile ? { profile } : {}) } });
  const prepare = (profile = "docker") => reg.prepare!({ ...base(profile), purpose: "session", argv: ["claude"], env: { PASEO_AGENT_ID: "a1" } } as never, ctx);
  const objects = (kind: "pod" | "service" | "networkpolicy") => kube.objects[kind]!.map((o) => o.name);
  return {
    kube, runtime, reg, ctx, base, prepare, objects, namespaces,
    advance: (ms: number) => void (clock += ms),
    ps: (stdout: string, code = 0) => void (kube.execResult = { code, stdout, stderr: "" }),
    sandboxName: () => (kube.applied.find((m: any) => m.kind === "Sandbox") as any).metadata.name as string,
  };
}

describe("manifests", () => {
  const config = ConfigSchema.parse({});
  it("builds a privileged engine pod alone on a tainted node, with no token and no TLS", () => {
    const pod = buildDockerPod(config, "pka-x-1", "wks_1", "srv_ME") as any;
    expect(pod.metadata).toMatchObject({ name: "docker-pka-x-1", namespace: "paseo-docker", labels: { "paseo.sh/docker-sandbox": "pka-x-1", "paseo.sh/workspace": "wks_1", "paseo.sh/daemon": "srv_ME" } });
    expect(pod.spec).toMatchObject({
      automountServiceAccountToken: false,
      nodeSelector: { "paseo.sh/pool": "docker" },
      tolerations: [{ key: "paseo.sh/docker", operator: "Exists", effect: "NoSchedule" }],
      volumes: [{ name: "docker-data", emptyDir: {} }],
    });
    expect(pod.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey).toBe("kubernetes.io/hostname");
    expect(pod.spec.containers[0]).toMatchObject({
      image: "docker:dind",
      env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
      securityContext: { privileged: true },
      resources: { requests: { cpu: "3", memory: "26Gi" }, limits: { memory: "28Gi" } },
      volumeMounts: [{ name: "docker-data", mountPath: "/var/lib/docker" }],
    });
  });

  it("exposes 2375 and 873, and lets in only the agent pod of this sandbox", () => {
    const service = buildDockerService(config, "pka-x-1", "wks_1") as any;
    expect(service.metadata.name).toBe("docker-pka-x-1");
    expect(service.spec.ports.map((p: any) => p.port)).toEqual([2375, 873]);
    expect(service.spec.selector).toEqual({ "paseo.sh/docker-sandbox": "pka-x-1" });
    const policy = buildDockerNetworkPolicy(config, "pka-x-1", "wks_1") as any;
    expect(policy.spec.podSelector.matchLabels).toEqual({ "paseo.sh/docker-sandbox": "pka-x-1" });
    expect(policy.spec.ingress[0].from).toEqual([
      { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "paseo-agents" } }, podSelector: { matchLabels: { "paseo.sh/sandbox": "pka-x-1" } } },
    ]);
    expect(policy.spec.ingress[0].ports.map((p: any) => p.port)).toEqual([2375, 873]);
  });

  it("takes the settings: namespace, image, placement and sizes", () => {
    const custom = ConfigSchema.parse({ docker: { namespace: "d", image: "reg/dind:1", nodeSelector: { a: "b" }, tolerations: [], resources: { limits: { memory: "1Gi" } } } });
    const pod = buildDockerPod(custom, "s", "w") as any;
    expect(pod.metadata.namespace).toBe("d");
    expect(pod.spec.nodeSelector).toEqual({ a: "b" });
    expect(pod.spec.tolerations).toBeUndefined();
    expect(pod.spec.containers[0]).toMatchObject({ image: "reg/dind:1", resources: { limits: { memory: "1Gi" } } });
  });
});

describe("the agent pod", () => {
  it("gets DOCKER_HOST and the labels when its profile has docker: true", () => {
    const sandbox = buildSandbox({ name: "pka-x-1", workspaceId: "wks_1", cwd: CWD, config: ConfigSchema.parse({}), docker: true }) as any;
    const tpl = sandbox.spec.podTemplate;
    expect(tpl.metadata.labels).toMatchObject({ "paseo.sh/docker": "1", "paseo.sh/sandbox": "pka-x-1" });
    expect(tpl.spec.containers[0].env).toContainEqual({ name: "DOCKER_HOST", value: "tcp://docker-pka-x-1.paseo-docker.svc.cluster.local:2375" });
  });

  it("gets neither without it, and keeps the spec hash it always had", () => {
    const config = ConfigSchema.parse({});
    const plain = buildSandbox({ name: "pka-x-1", workspaceId: "wks_1", cwd: CWD, config }) as any;
    expect(plain.spec.podTemplate.metadata.labels["paseo.sh/docker"]).toBeUndefined();
    expect(plain.spec.podTemplate.spec.containers[0].env.map((e: any) => e.name)).not.toContain("DOCKER_HOST");
    const docker = buildSandbox({ name: "pka-x-1", workspaceId: "wks_1", cwd: CWD, config, docker: true }) as any;
    expect(docker.metadata.annotations["paseo.sh/spec-hash"]).not.toBe(plain.metadata.annotations["paseo.sh/spec-hash"]);
  });

  it("is created by the runtime with them for a docker profile only", async () => {
    const t = setup();
    await t.prepare("docker");
    const sandbox = t.kube.applied.find((m: any) => m.kind === "Sandbox") as any;
    expect(sandbox.spec.podTemplate.spec.containers[0].env).toContainEqual(expect.objectContaining({ name: "DOCKER_HOST" }));
    const other = setup();
    await other.prepare("plain");
    expect(JSON.stringify(other.kube.applied)).not.toContain("DOCKER_HOST");
    expect(other.objects("pod")).toEqual([]);
  });
});

describe("start", () => {
  it("creates the Service, the NetworkPolicy and the pod in the docker namespace when the workspace pod is up", async () => {
    const t = setup();
    await t.prepare();
    const name = `docker-${t.sandboxName()}`;
    expect(t.objects("service")).toEqual([name]);
    expect(t.objects("networkpolicy")).toEqual([name]);
    expect(t.objects("pod")).toEqual([name]);
    expect(t.kube.objects.pod![0]!.labels).toMatchObject({ "paseo.sh/docker-sandbox": t.sandboxName(), "paseo.sh/workspace": "wks_1" });
    expect(t.namespaces).toContain("paseo-docker");
  });

  it("is idempotent while the pod lives, and a failure only warns", async () => {
    const t = setup();
    await t.prepare();
    await t.prepare();
    expect(t.kube.calls.filter((c) => c === "apply")).toHaveLength(4); // sandbox, service, policy, pod: once
    const notices: string[] = [];
    const broken = setup();
    const apply = broken.kube.apply.bind(broken.kube);
    broken.kube.apply = async (m: any) => (m.kind === "Pod" ? Promise.reject(new Error("quota")) : apply(m));
    await broken.reg.prepare!({ ...broken.base("docker"), purpose: "session", argv: ["claude"], env: {} } as never, { notice: (m: string, l?: string) => void notices.push(`${l}:${m}`) });
    expect(notices.join("\n")).toContain("warning:Could not start the docker sandbox: quota");
  });
});

describe("idle, maximum age, suspend, archive", () => {
  it("deletes the pod (keeping Service and NetworkPolicy) after idleMinutes without a running container", async () => {
    const t = setup({ docker: { idleMinutes: 15 } });
    await t.prepare();
    t.ps("");
    await t.runtime.checkDocker(); // first look: empty since now
    t.advance(14 * MIN);
    await t.runtime.checkDocker();
    expect(t.objects("pod")).toHaveLength(1);
    t.advance(2 * MIN);
    await t.runtime.checkDocker();
    expect(t.objects("pod")).toEqual([]);
    expect(t.objects("service")).toHaveLength(1);
    expect(t.objects("networkpolicy")).toHaveLength(1);
    expect(t.kube.execs.some((e) => e.pod.startsWith("docker-") && e.argv.join(" ") === "docker ps -q")).toBe(true);
  });

  it("keeps a sandbox that runs a container, and one whose engine cannot answer", async () => {
    const t = setup({ docker: { idleMinutes: 15 } });
    await t.prepare();
    t.ps("abc123\n");
    await t.runtime.checkDocker();
    t.advance(60 * MIN);
    await t.runtime.checkDocker();
    t.ps("", 1);
    t.advance(60 * MIN);
    await t.runtime.checkDocker();
    expect(t.objects("pod")).toHaveLength(1);
  });

  it("starts the sandbox again when a new process launches after it idled out", async () => {
    const t = setup({ docker: { idleMinutes: 15 } });
    await t.prepare();
    t.ps("");
    await t.runtime.checkDocker();
    t.advance(16 * MIN);
    await t.runtime.checkDocker();
    expect(t.objects("pod")).toEqual([]);
    await t.prepare();
    expect(t.objects("pod")).toHaveLength(1);
  });

  it("deletes the pod at maxHours even while it runs containers", async () => {
    const t = setup({ docker: { maxHours: 8, idleMinutes: 0 } });
    await t.prepare();
    t.ps("abc123\n");
    t.advance(7 * HOUR);
    await t.runtime.checkDocker();
    expect(t.objects("pod")).toHaveLength(1);
    t.advance(2 * HOUR);
    await t.runtime.checkDocker();
    expect(t.objects("pod")).toEqual([]);
    expect(t.objects("service")).toHaveLength(1);
  });

  it("deletes the pod when the workspace is suspended and starts it when the workspace resumes, with the env intact", async () => {
    const t = setup();
    await t.prepare();
    t.advance(31 * MIN);
    await t.runtime.checkIdle();
    expect(t.kube.sandboxes[0]!.operatingMode).toBe("Suspended");
    expect(t.objects("pod")).toEqual([]);
    expect(t.objects("service")).toHaveLength(1);
    expect(t.objects("networkpolicy")).toHaveLength(1);
    await t.prepare();
    const resume = t.kube.patches2.find((p) => (p.patch as any).spec?.operatingMode === "Running")!.patch as any;
    expect(resume.spec.podTemplate.spec.containers[0].env).toContainEqual(expect.objectContaining({ name: "DOCKER_HOST" }));
    expect(resume.spec.podTemplate.metadata.labels).toMatchObject({ "paseo.sh/docker": "1", "paseo.sh/sandbox": t.sandboxName() });
    expect(t.objects("pod")).toHaveLength(1);
  });

  it("deletes everything when the workspace is archived", async () => {
    const t = setup();
    await t.prepare();
    await t.reg.destroy!(t.base("docker") as never, t.ctx);
    expect(t.objects("pod")).toEqual([]);
    expect(t.objects("service")).toEqual([]);
    expect(t.objects("networkpolicy")).toEqual([]);
    expect(t.kube.sandboxes).toEqual([]);
  });

  it("leaves a workspace without a docker profile alone", async () => {
    const t = setup();
    await t.prepare("plain");
    t.advance(31 * MIN);
    await t.runtime.checkIdle();
    await t.reg.destroy!(t.base("plain") as never, t.ctx);
    expect(t.kube.calls.filter((c) => /^delete:(pod|service|networkpolicy)/.test(c))).toEqual([]);
  });
});

describe("orphan reaper", () => {
  it("sweeps the sandboxes whose workspace pod is gone, and only those", async () => {
    const t = setup();
    await t.prepare();
    const live = t.sandboxName();
    // a second sandbox's objects with no Sandbox behind them
    for (const make of [buildDockerPod, buildDockerService, buildDockerNetworkPolicy]) await t.kube.apply(make(ConfigSchema.parse({}), "pka-gone-1", "wks_gone", "srv_ME"));
    for (const kind of ["pod", "service", "networkpolicy"] as const) t.kube.objects[kind]!.forEach((o) => (o.createdAt = new Date(START - HOUR).toISOString()));
    const namespaces: string[] = [];
    const reaper = new OrphanReaper({
      getConfig: async () => ConfigSchema.parse({}),
      kubeFor: (c) => (namespaces.push(c.namespace), t.kube),
      daemonId: "srv_ME",
      workspaceIds: async () => new Set(["wks_1"]),
      now: () => START,
      log: () => undefined,
    });
    const status = await reaper.run();
    expect(status.removed).toBe(3);
    expect(t.objects("pod")).toEqual([`docker-${live}`]);
    expect(t.objects("service")).toEqual([`docker-${live}`]);
    expect(t.objects("networkpolicy")).toEqual([`docker-${live}`]);
    expect(namespaces).toContain("paseo-docker");
  });

  it("deletes the docker objects of a workspace archived while the plugin was away (reconcile)", async () => {
    const t = setup();
    await t.prepare();
    t.kube.sandboxes[0]!.createdAt = new Date(0).toISOString();
    await t.runtime.reconcile({ workspaces: [{ workspaceId: "wks_other", cwd: "/x" }] });
    expect(t.objects("pod")).toEqual([]);
    expect(t.objects("service")).toEqual([]);
  });
});

describe("OOM and the Runtime screen", () => {
  it("counts a sandbox OOM under role docker, apart from the agent's", async () => {
    const t = setup();
    await t.prepare();
    t.kube.objects.pod![0]!.pod = { uid: "d1", ready: false, terminating: false, phase: "Failed", oomKilled: true, oomAt: "2026-10-27T10:00:00Z", memoryLimit: "28Gi" };
    await t.runtime.checkDocker();
    await t.runtime.checkDocker(); // the same kill is counted once
    const stats = t.runtime.oomStats();
    expect(stats.get("docker:wks_1")).toMatchObject({ count: 1, limit: "28Gi" });
    expect(stats.get("wks_1")).toBeUndefined();
  });

  it("shows the sandbox state on the pod row", async () => {
    const t = setup();
    await t.prepare();
    const config = ConfigSchema.parse({});
    const docker = await t.runtime.dockerStatuses(config);
    const rows = (d: typeof docker) => buildPodRows({ sandboxes: t.kube.sandboxes, claims: [], pods: new Map([[t.sandboxName(), { uid: "u", ready: true, terminating: false }]]), entries: [], titles: null, agents: [], docker: d, oom: new Map([["docker:wks_1", { count: 2, lastAt: 5, agents: {}, limit: "28Gi" }]]) });
    expect(rows(docker)[0]!.docker).toMatchObject({ state: "running", oom: { count: 2, limit: "28Gi" } });
    expect(rows(new Map())[0]!.docker).toMatchObject({ state: "stopped" });
    expect(buildPodRows({ sandboxes: [{ ...t.kube.sandboxes[0]!, labels: {} as never }].map((s) => ({ ...s, labels: { "paseo.sh/workspace-id": "wks_1" } })), claims: [], pods: new Map(), entries: [], titles: null, agents: [] })[0]!.docker).toBeUndefined();
  });
});
