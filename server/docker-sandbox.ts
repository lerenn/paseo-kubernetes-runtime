import type { KubernetesRuntimeConfig } from "./config.js";
import type { Kube, ObjectInfo } from "./kube.js";
import { DAEMON_LABEL, MANAGED_BY, MANAGED_BY_LABEL, SANDBOX_LABEL, dockerName } from "./sandbox.js";

/** On every object of a Docker sandbox: the agent Sandbox it serves (what the NetworkPolicy and the Service select by). */
export const DOCKER_SANDBOX_LABEL = "paseo.sh/docker-sandbox";
/** The Paseo workspace a Docker sandbox serves. */
export const DOCKER_WORKSPACE_LABEL = "paseo.sh/workspace";
export const DOCKER_PORT = 2375;
export const RSYNC_PORT = 873;

type Builder = Pick<KubernetesRuntimeConfig, "docker" | "namespace">;

function labels(sandbox: string, workspaceId: string, daemonId?: string): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: MANAGED_BY,
    [DOCKER_SANDBOX_LABEL]: sandbox,
    [DOCKER_WORKSPACE_LABEL]: workspaceId,
    ...(daemonId ? { [DAEMON_LABEL]: daemonId } : {}),
  };
}

const meta = (config: Builder, sandbox: string, workspaceId: string, daemonId?: string) => ({
  name: dockerName(sandbox),
  namespace: config.docker.namespace,
  labels: labels(sandbox, workspaceId, daemonId),
});

/** The engine: a privileged `docker:dind` pod, alone on a node of the dedicated pool, with its data in an emptyDir. */
export function buildDockerPod(config: Builder, sandbox: string, workspaceId: string, daemonId?: string): Record<string, unknown> {
  const d = config.docker;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: meta(config, sandbox, workspaceId, daemonId),
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      ...(Object.keys(d.nodeSelector).length ? { nodeSelector: d.nodeSelector } : {}),
      ...(d.tolerations.length
        ? { tolerations: d.tolerations.map((t) => ({ key: t.key, operator: t.operator, ...(t.value !== undefined ? { value: t.value } : {}), ...(t.effect ? { effect: t.effect } : {}) })) }
        : {}),
      // one sandbox per node
      affinity: {
        podAntiAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [
            { labelSelector: { matchExpressions: [{ key: DOCKER_SANDBOX_LABEL, operator: "Exists" }] }, topologyKey: "kubernetes.io/hostname" },
          ],
        },
      },
      containers: [
        {
          name: "docker",
          image: d.image,
          // no TLS: dockerd listens on tcp 2375, reachable only through the NetworkPolicy
          env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
          securityContext: { privileged: true },
          ports: [
            { name: "docker", containerPort: DOCKER_PORT },
            { name: "rsync", containerPort: RSYNC_PORT },
          ],
          readinessProbe: { tcpSocket: { port: DOCKER_PORT }, periodSeconds: 5 },
          ...(Object.keys(d.resources).length ? { resources: d.resources } : {}),
          volumeMounts: [{ name: "docker-data", mountPath: "/var/lib/docker" }],
        },
      ],
      volumes: [{ name: "docker-data", emptyDir: {} }],
    },
  };
}

export function buildDockerService(config: Builder, sandbox: string, workspaceId: string, daemonId?: string): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: meta(config, sandbox, workspaceId, daemonId),
    spec: {
      selector: { [DOCKER_SANDBOX_LABEL]: sandbox },
      ports: [
        { name: "docker", port: DOCKER_PORT, targetPort: DOCKER_PORT },
        { name: "rsync", port: RSYNC_PORT, targetPort: RSYNC_PORT },
      ],
    },
  };
}

/** Ingress to the engine only from the agent pod this sandbox is for (the agents' pods carry `paseo.sh/sandbox`). */
export function buildDockerNetworkPolicy(config: Builder, sandbox: string, workspaceId: string, daemonId?: string): Record<string, unknown> {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta(config, sandbox, workspaceId, daemonId),
    spec: {
      podSelector: { matchLabels: { [DOCKER_SANDBOX_LABEL]: sandbox } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": config.namespace } },
              podSelector: { matchLabels: { [SANDBOX_LABEL]: sandbox } },
            },
          ],
          ports: [
            { protocol: "TCP", port: DOCKER_PORT },
            { protocol: "TCP", port: RSYNC_PORT },
          ],
        },
      ],
    },
  };
}

export type DockerState = "starting" | "running" | "stopped" | "error";

export interface DockerStatus {
  state: DockerState;
  problem?: string;
  /** ISO time the sandbox pod was created. */
  since?: string;
}

export interface DockerDeps {
  getConfig(): Promise<KubernetesRuntimeConfig>;
  kubeFor(config: KubernetesRuntimeConfig): Kube;
  daemonId?: string;
  now(): number;
  sleep?: (ms: number) => Promise<void>;
  log(line: string): void;
  /** A sandbox pod was killed for memory (once per kill). */
  onOom?(workspaceId: string, sandbox: string, facts: { limit?: string }): void;
}

const created = (o: ObjectInfo) => (o.createdAt ? Date.parse(o.createdAt) : 0);
const finished = (o: ObjectInfo) => o.pod?.phase === "Failed" || o.pod?.phase === "Succeeded";

export const dockerSelector = (daemonId: string) => `${MANAGED_BY_LABEL}=${MANAGED_BY},${DAEMON_LABEL}=${daemonId},${DOCKER_SANDBOX_LABEL}`;

/**
 * The per-workspace Docker sandboxes of the workspaces whose profile has `docker: true`. The Service and NetworkPolicy
 * live as long as the workspace; the (expensive) pod is started with the workspace's pod and deleted when the workspace
 * is suspended, when it has run no container for `idleMinutes`, or after `maxHours`.
 */
export class DockerSandboxes {
  /** Sandboxes whose pod was deleted for idleness: the next process launch in the workspace starts it again. */
  private readonly idleStopped = new Set<string>();
  /** Since when a sandbox pod has had no running container. */
  private readonly emptySince = new Map<string, number>();
  private readonly oomSeen = new Set<string>();

  constructor(private readonly deps: DockerDeps) {}

  private kube(config: KubernetesRuntimeConfig): Kube {
    return this.deps.kubeFor({ ...config, namespace: config.docker.namespace });
  }

  /** Whether the pod was deleted for idleness and a new process in the workspace should bring it back. */
  wantsRestart(sandbox: string): boolean {
    return this.idleStopped.has(sandbox);
  }

  /** Makes sure the Service, the NetworkPolicy and the pod exist. Does not wait for the engine: the node takes a minute or two. */
  async ensure(workspaceId: string, sandbox: string, config: KubernetesRuntimeConfig): Promise<void> {
    const kube = this.kube(config);
    const name = dockerName(sandbox);
    this.idleStopped.delete(sandbox);
    await kube.apply(buildDockerService(config, sandbox, workspaceId, this.deps.daemonId));
    await kube.apply(buildDockerNetworkPolicy(config, sandbox, workspaceId, this.deps.daemonId));
    const existing = await kube.podInfo(name).catch(() => null);
    if (existing && !existing.terminating && existing.phase !== "Failed" && existing.phase !== "Succeeded") return;
    if (existing) {
      // a pod that ended (killed for memory) or is on its way out: wait for its name to be free
      if (!existing.terminating) await kube.delete("pod", name);
      const sleep = this.deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
      for (let i = 0; i < 30 && (await kube.podInfo(name).catch(() => null)); i++) await sleep(1000);
    }
    this.emptySince.delete(name);
    await kube.apply(buildDockerPod(config, sandbox, workspaceId, this.deps.daemonId));
    this.deps.log(`[kubernetes-runtime] docker sandbox ${name} started (workspace ${workspaceId})`);
  }

  /** Deletes the pod and keeps the Service and the NetworkPolicy. */
  async stop(sandbox: string, config: KubernetesRuntimeConfig, why = "workspace suspended"): Promise<void> {
    const name = dockerName(sandbox);
    this.emptySince.delete(name);
    const kube = this.kube(config);
    if (await kube.podInfo(name).catch(() => null)) {
      await kube.delete("pod", name);
      this.deps.log(`[kubernetes-runtime] docker sandbox ${name} stopped (${why})`);
    }
  }

  /** Deletes everything of a workspace's sandbox. */
  async destroy(sandbox: string, config: KubernetesRuntimeConfig): Promise<void> {
    const name = dockerName(sandbox);
    this.emptySince.delete(name);
    this.idleStopped.delete(sandbox);
    const kube = this.kube(config);
    for (const kind of ["pod", "networkpolicy", "service"]) await kube.delete(kind, name).catch(() => undefined);
  }

  /** Idle and maximum-age deletion, and the count of sandboxes killed for memory. Run every 30 s. */
  async check(): Promise<void> {
    const { daemonId } = this.deps;
    if (!daemonId) return;
    const config = await this.deps.getConfig();
    const kube = this.kube(config);
    const now = this.deps.now();
    const idleLimit = config.docker.idleMinutes * 60_000;
    const maxAge = config.docker.maxHours * 3_600_000;
    for (const obj of await kube.listObjects("pod", dockerSelector(daemonId))) {
      const info = obj.pod!;
      const sandbox = obj.labels[DOCKER_SANDBOX_LABEL]!;
      if (info.oomKilled) {
        const key = `${info.uid}:${info.oomAt ?? ""}`;
        if (!this.oomSeen.has(key)) {
          this.oomSeen.add(key);
          this.deps.onOom?.(obj.labels[DOCKER_WORKSPACE_LABEL] ?? "", sandbox, { limit: info.memoryLimit });
        }
      }
      if (info.terminating || finished(obj)) continue;
      if (maxAge > 0 && now - created(obj) >= maxAge) {
        await this.stop(sandbox, config, `maximum age of ${config.docker.maxHours} h reached`);
        continue;
      }
      if (idleLimit <= 0 || !info.ready) continue;
      const ps = await kube.exec(obj.name, ["docker", "ps", "-q"]).catch(() => null);
      if (!ps || ps.code !== 0) continue; // the engine cannot say: not idle, not busy
      if (ps.stdout.trim()) {
        this.emptySince.delete(obj.name);
        continue;
      }
      const since = this.emptySince.get(obj.name) ?? now;
      this.emptySince.set(obj.name, since);
      if (now - since >= idleLimit) {
        await this.stop(sandbox, config, `no running container for ${config.docker.idleMinutes} min`);
        this.idleStopped.add(sandbox);
      }
    }
  }

  /** The state of each sandbox pod by agent Sandbox name; a sandbox with no pod is not in the map. */
  async statuses(config: KubernetesRuntimeConfig): Promise<Map<string, DockerStatus>> {
    const out = new Map<string, DockerStatus>();
    if (!this.deps.daemonId) return out;
    for (const obj of await this.kube(config).listObjects("pod", dockerSelector(this.deps.daemonId))) {
      const info = obj.pod!;
      const sandbox = obj.labels[DOCKER_SANDBOX_LABEL]!;
      let state: DockerState = "starting";
      let problem: string | undefined;
      if (info.problem || finished(obj)) {
        state = "error";
        problem = info.problem ?? (info.oomKilled ? "The engine was killed for memory." : `The engine pod ${info.phase?.toLowerCase()}.`);
      } else if (info.ready && !info.terminating) state = "running";
      out.set(sandbox, { state, ...(problem ? { problem } : {}), ...(obj.createdAt ? { since: obj.createdAt } : {}) });
    }
    return out;
  }
}

/**
 * Deletes the pods, Services and NetworkPolicies of Docker sandboxes whose agent Sandbox no longer exists (the workspace
 * was archived while the plugin was away, or its Sandbox was deleted by hand). Returns how many objects were deleted.
 */
export async function sweepDockerOrphans(
  kube: Kube,
  daemonId: string,
  liveSandboxes: ReadonlySet<string>,
  now: number,
  graceMs: number,
  log: (line: string) => void,
): Promise<number> {
  let removed = 0;
  for (const kind of ["pod", "service", "networkpolicy"] as const) {
    for (const obj of await kube.listObjects(kind, dockerSelector(daemonId))) {
      const sandbox = obj.labels[DOCKER_SANDBOX_LABEL]!;
      if (liveSandboxes.has(sandbox) || now - created(obj) < graceMs) continue;
      log(`[kubernetes-runtime] orphan cleanup: deleting docker sandbox ${kind} ${obj.name} (its workspace pod is gone)`);
      await kube.delete(kind, obj.name);
      removed++;
    }
  }
  return removed;
}
