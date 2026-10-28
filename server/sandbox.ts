import { createHash, randomBytes } from "node:crypto";
import type { KubernetesRuntimeConfig } from "./config.js";

/** Kept from the plugin's earlier name so resources made then are still recognised as ours. */
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY = "paseo-kube-agents";
/** The owning daemon and the Paseo workspace a sandbox serves: what the orphan reaper goes by. */
export const DAEMON_LABEL = "paseo.sh/daemon";
export const WORKSPACE_ID_LABEL = "paseo.sh/workspace-id";
/** For people (`kubectl get pods -L paseo.sh/workspace,paseo.sh/agent,paseo.sh/state`); earlier versions put the id here. */
export const WORKSPACE_LABEL = "paseo.sh/workspace";
export const AGENT_LABEL = "paseo.sh/agent";
export const REPO_LABEL = "paseo.sh/repo";
/** On pods that run as a ServiceAccount, so a NetworkPolicy can select them. */
export const SERVICE_ACCOUNT_LABEL = "paseo.sh/service-account";
/** On an agent pod with a Docker sandbox, so a NetworkPolicy can let it reach the sandbox (value `1`). */
export const DOCKER_LABEL = "paseo.sh/docker";
/** On the pod template of a workspace with the privileged `dockerd` sidecar (value `1`); an admission policy can key on it. */
export const DOCKER_SIDECAR_LABEL = "paseo.sh/docker-sidecar";
export const DOCKER_SIDECAR_CONTAINER = "dockerd";
/** The engine address in sidecar mode: loopback of the pod, so no other pod can reach it. */
export const DOCKER_SIDECAR_HOST = "tcp://127.0.0.1:2375";
const DOCKER_DATA_VOLUME = "docker-data";
/** On an agent pod: the name of its Sandbox, which the Docker sandbox's NetworkPolicy selects by. */
export const SANDBOX_LABEL = "paseo.sh/sandbox";
export const STATE_LABEL = "paseo.sh/state";
export const WORKSPACE_NAME_ANNOTATION = "paseo.sh/workspace-name";
export const REPO_URL_ANNOTATION = "paseo.sh/repo-url";
export const SPEC_HASH_ANNOTATION = "paseo.sh/spec-hash";
/** The project directory on the daemon, so a restarted plugin can resume a workspace it has not been told about yet. */
export const CWD_ANNOTATION = "paseo.sh/cwd";
/**
 * `mapped`: the checkout is at the fixed `MAPPED_CHECKOUT` in every pod and Paseo rewrites the daemon's path to it (the
 * runtime's `mapCwd`), so a pod does not depend on its workspace and can be started ahead of it (the warm pool).
 * Without the annotation a pod is `legacy`: the checkout is mounted at the daemon's own path.
 */
export const LAYOUT_ANNOTATION = "paseo.sh/layout";
export const MAPPED_CHECKOUT = "/workspace/checkout";
/** The `paseo.sh/state` of a pod that is started ahead of its workspace. */
export const WARM_STATE = "warm";

export const WORKSPACE_ROOT = "/workspace";
/** Agent session state (claude's transcripts, caches, installed CLIs) lives under HOME, on the workspace volume. */
export const HOME_DIR = `${WORKSPACE_ROOT}/.home`;
/** Where the volume holds the checkout; it is mounted again at the daemon's absolute path. */
export const CHECKOUT_SUBPATH = "checkout";
export const WORKSPACE_VOLUME = "workspace";
/** The Sandbox controller names the claim `<claim template name>-<sandbox name>`. */
export const workspaceClaimName = (sandbox: string) => `${WORKSPACE_VOLUME}-${sandbox}`;

/** A valid label value (at most 63 characters, alphanumeric at both ends) made from free text; the full text goes in an annotation. */
export function labelValue(text: string | undefined): string | undefined {
  const v = (text ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 63).replace(/[^A-Za-z0-9]+$/, "");
  return v || undefined;
}

export type PodState = "running" | "suspended";

/** What people see on a workspace's Sandbox, pod and volume claim. */
export interface PodMeta {
  /** The workspace's name in Paseo (its title). */
  workspaceName: string;
  repo: string;
  repoUrl?: string;
  /** Short id of the agent that most recently ran in the workspace. */
  agent?: string;
  state: PodState;
}

const dropUndefined = (o: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, string>;

export function metaLabels(meta: PodMeta): Record<string, string> {
  return dropUndefined({
    [WORKSPACE_LABEL]: labelValue(meta.workspaceName),
    [AGENT_LABEL]: labelValue(meta.agent),
    [REPO_LABEL]: labelValue(meta.repo),
    [STATE_LABEL]: meta.state,
  });
}

export function metaAnnotations(meta: PodMeta): Record<string, string> {
  return dropUndefined({ [WORKSPACE_NAME_ANNOTATION]: meta.workspaceName, [REPO_URL_ANNOTATION]: meta.repoUrl?.replace(/\/\/[^/@]*@/, "//") });
}

/**
 * Merge patch that brings a Sandbox's labels and annotations up to date. The pod template carries them too: the
 * controller copies its labels onto the running pod (without restarting it) and would undo a label set on the pod
 * alone. The volume claim is labelled separately.
 */
export function metaPatch(meta: PodMeta): Record<string, unknown> {
  const labels = metaLabels(meta);
  const annotations = metaAnnotations(meta);
  return { metadata: { labels, annotations }, spec: { podTemplate: { metadata: { labels, annotations } } } };
}

const slugify = (text: string, max: number) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");

/** `pka-<repo>-<slug>-<rand>`, like a worktree named from the repository and a slug; DNS-safe, at most 63 chars. */
export function sandboxName(workspaceId: string, repo?: string, slug?: string): string {
  const named = [repo && slugify(repo, 18), slug && slugify(slug, 20)].filter(Boolean).join("-");
  return `pka-${named || slugify(workspaceId, 24) || "workspace"}-${randomBytes(3).toString("hex")}`;
}

/** Changes whenever a setting that shapes the pod does, so a resumed pod picks up the current ones. */
/** The ServiceAccount a workspace's pod runs as: the first configured rule matched by the agent's labels. */
export function serviceAccountFor(config: KubernetesRuntimeConfig, labels: Record<string, string> = {}): string | undefined {
  return config.serviceAccounts.find((r) => {
    const [key, value] = r.label.split("=");
    return labels[key!] === value;
  })?.serviceAccount;
}

export function specHash(config: KubernetesRuntimeConfig, cwd: string, serviceAccount?: string | null, docker?: boolean, sidecar?: boolean): string {
  const shape = {
    image: config.image,
    resources: config.resources ?? null,
    nodeSelector: config.nodeSelector,
    tolerationKeys: config.tolerationKeys,
    tolerations: config.tolerations,
    podAnnotations: config.podAnnotations,
    storage: config.storage,
    credentialsSecret: config.credentialsSecret,
    extraSecrets: config.extraSecrets,
    apiVersion: config.sandboxApiVersion,
    cwd,
    // only when on, so the hash of a pod without a Docker sandbox is what it always was
    ...(docker ? { docker: config.docker } : {}),
    ...(sidecar ? { dockerSidecar: { ...config.dockerSidecar, image: config.dockerSidecar.image ?? config.docker.image } } : {}),
  };
  return createHash("sha1").update(JSON.stringify(shape)).digest("hex").slice(0, 12);
}

export interface SandboxSpecInput {
  name: string;
  /** Absent for a warm pod, which belongs to no workspace yet. */
  workspaceId?: string;
  /** The project directory on the daemon. A legacy pod shows the checkout at this same path; a mapped one does not need it. */
  cwd?: string;
  config: KubernetesRuntimeConfig;
  daemonId?: string;
  meta?: PodMeta;
  /** Where the checkout is in the pod (default legacy). */
  layout?: "legacy" | "mapped";
  /** A pod started ahead of any workspace; claimed later with `claimPatch`. */
  warm?: boolean;
  /** The pod runs as this ServiceAccount (see `serviceAccounts`); none for a warm pod. */
  serviceAccount?: string;
  /** The workspace's profile has a Docker sandbox: the pod gets `DOCKER_HOST` and the labels its NetworkPolicy goes by. */
  docker?: boolean;
  /** The pod gets the privileged `dockerd` sidecar (Docker mode `sidecar`); never together with `docker`. */
  dockerSidecar?: boolean;
}

/** The privileged dind container of the `sidecar` mode: dockerd on the pod's loopback only, the workspace volume mounted where the agent sees it. */
export function dockerSidecarContainer(config: KubernetesRuntimeConfig, cwd?: string) {
  return {
    name: DOCKER_SIDECAR_CONTAINER,
    image: config.dockerSidecar.image ?? config.docker.image,
    command: ["dockerd-entrypoint.sh"],
    args: ["dockerd", `--host=${DOCKER_SIDECAR_HOST}`, "--host=unix:///var/run/docker.sock"],
    env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
    // the pod runs as 1000 and non-root; dockerd needs root and the host's devices
    securityContext: { privileged: true, runAsUser: 0, runAsNonRoot: false },
    resources: config.dockerSidecar.resources,
    volumeMounts: [
      { name: DOCKER_DATA_VOLUME, mountPath: "/var/lib/docker" },
      // the same volume at the same paths as the agent, so `docker run -v <checkout>:...` and compose bind mounts see the agent's files
      { name: WORKSPACE_VOLUME, mountPath: WORKSPACE_ROOT },
      ...(cwd ? [{ name: WORKSPACE_VOLUME, mountPath: cwd, subPath: CHECKOUT_SUBPATH }] : []),
    ],
  };
}

/** Containers and volumes of the pod template, with or without the sidecar (a merge patch replaces both lists, so a switched-off sidecar disappears). */
function podContainers(config: KubernetesRuntimeConfig, cwd: string | undefined, engine: string | undefined, sidecar: boolean | undefined) {
  return {
    containers: [workspaceContainer(config, cwd, engine), ...(sidecar ? [dockerSidecarContainer(config, cwd)] : [])],
    // Persistent storage comes from volumeClaimTemplates; the controller adds that volume.
    volumes: [
      ...(config.storage.mode === "ephemeral" ? [{ name: WORKSPACE_VOLUME, emptyDir: {} }] : []),
      ...(sidecar ? [{ name: DOCKER_DATA_VOLUME, emptyDir: {} }] : []),
    ],
  };
}

/** `docker-<sandbox>`: the name of a workspace's Docker sandbox pod, Service and NetworkPolicy. */
export const dockerName = (sandbox: string) => `docker-${sandbox}`;

/** The engine address an agent pod gets as `DOCKER_HOST`. */
export const dockerHost = (config: KubernetesRuntimeConfig, sandbox: string) => `tcp://${dockerName(sandbox)}.${config.docker.namespace}.svc.cluster.local:2375`;

/** Labels of an agent pod with a Docker sandbox. */
const dockerPodLabels = (sandbox: string, docker: boolean | undefined) =>
  docker ? { [DOCKER_LABEL]: "1", [SANDBOX_LABEL]: sandbox } : {};

/** `pka-<random>`: a neutral name for a pod that is started before its workspace is known (names cannot change). */
export function warmSandboxName(): string {
  return `pka-${randomBytes(3).toString("hex")}`;
}

/** Turns a warm pod into a workspace's pod: ownership and display labels on the Sandbox, its pod template (the controller copies them onto the running pod) and the directory annotation. */
export function claimPatch(workspaceId: string, cwd: string, meta: PodMeta, config?: KubernetesRuntimeConfig): Record<string, unknown> {
  const labels = { [WORKSPACE_ID_LABEL]: workspaceId, ...metaLabels(meta) };
  const annotations = { [CWD_ANNOTATION]: cwd, ...metaAnnotations(meta) };
  // a pod that works for a workspace gets the annotations that keep the autoscaler off its node
  return { metadata: { labels, annotations }, spec: { podTemplate: { metadata: { labels, annotations: { ...annotations, ...(config?.podAnnotations ?? {}) } } } } };
}

/** A `Sandbox` (agents.x-k8s.io) whose single container idles; provider processes are started in it by `kubectl exec`. */
export function buildSandbox(input: SandboxSpecInput): Record<string, unknown> {
  const { name, workspaceId, config, daemonId, meta, warm } = input;
  const docker = !warm && input.docker === true;
  const sidecar = !warm && !docker && input.dockerSidecar === true;
  const serviceAccount = warm ? undefined : input.serviceAccount;
  const layout = input.layout ?? (warm ? "mapped" : "legacy");
  const cwd = layout === "mapped" ? undefined : (input.cwd ?? "");
  const shown = meta ? metaLabels(meta) : {};
  const podLabels = {
    [MANAGED_BY_LABEL]: MANAGED_BY,
    ...(serviceAccount ? { [SERVICE_ACCOUNT_LABEL]: serviceAccount } : {}),
    ...dockerPodLabels(name, docker),
    ...(sidecar ? { [DOCKER_LABEL]: "1", [DOCKER_SIDECAR_LABEL]: "1" } : {}),
    ...(warm ? { [STATE_LABEL]: WARM_STATE } : shown),
  };
  const owner = {
    ...(daemonId ? { [DAEMON_LABEL]: daemonId } : {}),
    ...(workspaceId ? { [WORKSPACE_ID_LABEL]: workspaceId } : {}),
    ...(warm ? { [STATE_LABEL]: WARM_STATE } : shown),
  };
  return {
    apiVersion: config.sandboxApiVersion,
    kind: "Sandbox",
    metadata: {
      name,
      namespace: config.namespace,
      labels: { ...podLabels, ...owner },
      annotations: {
        [SPEC_HASH_ANNOTATION]: specHash(config, cwd ?? MAPPED_CHECKOUT, serviceAccount, docker, sidecar),
        ...(cwd ? { [CWD_ANNOTATION]: cwd } : { [LAYOUT_ANNOTATION]: "mapped" }),
        ...(input.cwd && layout === "mapped" ? { [CWD_ANNOTATION]: input.cwd } : {}),
        ...(meta ? metaAnnotations(meta) : {}),
      },
    },
    // No shutdownTime: a workspace's storage goes only when the workspace is archived (or the reaper finds
    // it gone). Only `operatingMode` changes over its life.
    spec: {
      shutdownPolicy: "Delete",
      service: false,
      ...volumeClaims(config, owner),
      podTemplate: {
        metadata: {
          labels: podLabels,
          ...(!warm && (meta || Object.keys(config.podAnnotations).length) ? { annotations: { ...(meta ? metaAnnotations(meta) : {}), ...config.podAnnotations } } : {}),
        },
        spec: {
          restartPolicy: "Never",
          ...(serviceAccount ? { serviceAccountName: serviceAccount, automountServiceAccountToken: true } : { automountServiceAccountToken: false }),
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
          ...placement(config),
          // The checkout is a subPath of the volume, and kubelet creates a subPath directory owned by root,
          // after fsGroup has been applied. A root init container makes the volume ours before the agent runs.
          initContainers: [volumeInit(config)],
          ...withVolumes(podContainers(config, cwd, docker ? dockerHost(config, name) : sidecar ? DOCKER_SIDECAR_HOST : undefined, sidecar)),
        },
      },
    },
  };
}

const withVolumes = (p: ReturnType<typeof podContainers>) => ({ containers: p.containers, ...(p.volumes.length ? { volumes: p.volumes } : {}) });

export function placement(config: KubernetesRuntimeConfig) {
  const { nodeSelector } = config;
  const tolerations = [
    ...config.tolerationKeys.map((key) => ({ key, operator: "Exists" })),
    ...config.tolerations.map((t) => ({ key: t.key, operator: t.operator, ...(t.value !== undefined ? { value: t.value } : {}), ...(t.effect ? { effect: t.effect } : {}) })),
  ];
  return {
    ...(Object.keys(nodeSelector).length > 0 ? { nodeSelector } : {}),
    ...(tolerations.length > 0 ? { tolerations } : {}),
  };
}

function volumeInit(config: KubernetesRuntimeConfig) {
  return {
    name: "volume-init",
    image: config.image,
    command: ["sh", "-c", `mkdir -p "${WORKSPACE_ROOT}/${CHECKOUT_SUBPATH}" "${HOME_DIR}" && chown -R 1000:1000 "${WORKSPACE_ROOT}"`],
    securityContext: { runAsUser: 0, runAsNonRoot: false, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER", "DAC_OVERRIDE"] } },
    volumeMounts: [{ name: WORKSPACE_VOLUME, mountPath: WORKSPACE_ROOT }],
  };
}

/** The pod's single container: idles; provider processes are started in it by `kubectl exec`. */
export function workspaceContainer(config: KubernetesRuntimeConfig, cwd?: string, dockerEngine?: string) {
  return {
    name: "agent",
    image: config.image,
    command: ["sh", "-c", `mkdir -p "${HOME_DIR}" && exec sleep infinity`],
    workingDir: WORKSPACE_ROOT,
    // Only the Claude token reaches the pod, by reference. GitHub goes through the daemon.
    env: [
      { name: "HOME", value: HOME_DIR },
      ...(dockerEngine ? [{ name: "DOCKER_HOST", value: dockerEngine }] : []),
      {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        valueFrom: { secretKeyRef: { name: config.credentialsSecret, key: "CLAUDE_CODE_OAUTH_TOKEN", optional: true } },
      },
      // Per-profile Secrets (e.g. OPENAI_API_KEY for a codex profile), by reference, on this profile's pods only.
      ...config.extraSecrets.map((s) => ({
        name: s.env ?? s.key,
        valueFrom: { secretKeyRef: { name: s.secret, key: s.key, optional: s.optional } },
      })),
    ],
    ...(config.resources ? { resources: config.resources } : {}),
    volumeMounts: [
      { name: WORKSPACE_VOLUME, mountPath: WORKSPACE_ROOT },
      // A legacy pod shows the checkout at the daemon's own absolute path (paths inside provider protocols, like
      // claude's session files, are the daemon's). A mapped pod has it at MAPPED_CHECKOUT, inside the volume.
      ...(cwd ? [{ name: WORKSPACE_VOLUME, mountPath: cwd, subPath: CHECKOUT_SUBPATH }] : []),
    ],
  };
}

/** Deletes the pod and keeps the volume. */
export function suspendPatch() {
  return { spec: { operatingMode: "Suspended" } };
}

/** Recreates the pod on the same volume, with the current image and settings. */
export function resumePatch(config: KubernetesRuntimeConfig, cwd?: string, serviceAccount?: string, docker?: { sandbox: string }, sidecar?: boolean) {
  const sc = Boolean(sidecar) && !docker;
  const dockerLabel = docker || sc ? "1" : null;
  const pod = podContainers(config, cwd, docker ? dockerHost(config, docker.sandbox) : sc ? DOCKER_SIDECAR_HOST : undefined, sc);
  return {
    metadata: {
      annotations: { [SPEC_HASH_ANNOTATION]: specHash(config, cwd ?? MAPPED_CHECKOUT, serviceAccount, Boolean(docker), sc) },
      labels: { [DOCKER_LABEL]: dockerLabel, [SANDBOX_LABEL]: docker ? docker.sandbox : null, [DOCKER_SIDECAR_LABEL]: sc ? "1" : null },
    },
    spec: {
      operatingMode: "Running",
      // placement and annotations too: a resumed pod follows the settings of today (a node pool that changed, the autoscaler's hint)
      podTemplate: {
        metadata: {
          // null removes the label from a template that had it
          labels: {
            [SERVICE_ACCOUNT_LABEL]: serviceAccount ?? null,
            // the profile may have gained or lost the sandbox since the pod was made
            [DOCKER_LABEL]: dockerLabel,
            [SANDBOX_LABEL]: docker ? docker.sandbox : null,
            [DOCKER_SIDECAR_LABEL]: sc ? "1" : null,
          },
          ...(Object.keys(config.podAnnotations).length ? { annotations: config.podAnnotations } : {}),
        },
        spec: {
          ...(serviceAccount ? { serviceAccountName: serviceAccount, automountServiceAccountToken: true } : { serviceAccountName: null, automountServiceAccountToken: false }),
          ...placement(config), initContainers: [volumeInit(config)],
          containers: pod.containers,
          // null drops the sidecar's emptyDir (the list is never empty in ephemeral mode)
          volumes: pod.volumes.length ? pod.volumes : null,
        },
      },
    },
  };
}

/** A plain ReadWriteOnce claim: no provider-specific fields, so it works on any cluster. */
function volumeClaims(config: KubernetesRuntimeConfig, labels: Record<string, string> = {}) {
  if (config.storage.mode !== "persistent") return {};
  const { size, storageClassName } = config.storage;
  return {
    volumeClaimTemplates: [
      {
        metadata: { name: WORKSPACE_VOLUME, ...(Object.keys(labels).length ? { labels } : {}) },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: size } },
          ...(storageClassName ? { storageClassName } : {}),
        },
      },
    ],
  };
}
