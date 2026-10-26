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
export const STATE_LABEL = "paseo.sh/state";
export const WORKSPACE_NAME_ANNOTATION = "paseo.sh/workspace-name";
export const REPO_URL_ANNOTATION = "paseo.sh/repo-url";
export const SPEC_HASH_ANNOTATION = "paseo.sh/spec-hash";
/** The project directory on the daemon, so a restarted plugin can resume a workspace it has not been told about yet. */
export const CWD_ANNOTATION = "paseo.sh/cwd";

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
export function specHash(config: KubernetesRuntimeConfig, cwd: string): string {
  const shape = {
    image: config.image,
    resources: config.resources ?? null,
    nodeSelector: config.nodeSelector,
    tolerationKeys: config.tolerationKeys,
    storage: config.storage,
    credentialsSecret: config.credentialsSecret,
    apiVersion: config.sandboxApiVersion,
    cwd,
  };
  return createHash("sha1").update(JSON.stringify(shape)).digest("hex").slice(0, 12);
}

export interface SandboxSpecInput {
  name: string;
  workspaceId: string;
  /** The project directory on the daemon; the pod shows the workspace's checkout at this same path. */
  cwd: string;
  config: KubernetesRuntimeConfig;
  daemonId?: string;
  meta?: PodMeta;
}

/** A `Sandbox` (agents.x-k8s.io) whose single container idles; provider processes are started in it by `kubectl exec`. */
export function buildSandbox(input: SandboxSpecInput): Record<string, unknown> {
  const { name, workspaceId, cwd, config, daemonId, meta } = input;
  const shown = meta ? metaLabels(meta) : {};
  const podLabels = { [MANAGED_BY_LABEL]: MANAGED_BY, ...shown };
  const owner = {
    ...(daemonId ? { [DAEMON_LABEL]: daemonId } : {}),
    [WORKSPACE_ID_LABEL]: workspaceId,
    ...shown,
  };
  return {
    apiVersion: config.sandboxApiVersion,
    kind: "Sandbox",
    metadata: {
      name,
      namespace: config.namespace,
      labels: { ...podLabels, ...owner },
      annotations: { [SPEC_HASH_ANNOTATION]: specHash(config, cwd), [CWD_ANNOTATION]: cwd, ...(meta ? metaAnnotations(meta) : {}) },
    },
    // No shutdownTime: a workspace's storage goes only when the workspace is archived (or the reaper finds
    // it gone). Only `operatingMode` changes over its life.
    spec: {
      shutdownPolicy: "Delete",
      service: false,
      ...volumeClaims(config, owner),
      podTemplate: {
        metadata: { labels: podLabels, ...(meta ? { annotations: metaAnnotations(meta) } : {}) },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
          ...placement(config),
          // The checkout is a subPath of the volume, and kubelet creates a subPath directory owned by root,
          // after fsGroup has been applied. A root init container makes the volume ours before the agent runs.
          initContainers: [volumeInit(config)],
          containers: [workspaceContainer(config, cwd)],
          // Persistent storage comes from volumeClaimTemplates; the controller adds the volume.
          ...(config.storage.mode === "ephemeral" ? { volumes: [{ name: WORKSPACE_VOLUME, emptyDir: {} }] } : {}),
        },
      },
    },
  };
}

function placement(config: KubernetesRuntimeConfig) {
  const { nodeSelector } = config;
  const tolerations = config.tolerationKeys.map((key) => ({ key, operator: "Exists" }));
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
export function workspaceContainer(config: KubernetesRuntimeConfig, cwd: string) {
  return {
    name: "agent",
    image: config.image,
    command: ["sh", "-c", `mkdir -p "${HOME_DIR}" && exec sleep infinity`],
    workingDir: WORKSPACE_ROOT,
    // Only the Claude token reaches the pod, by reference. GitHub goes through the daemon.
    env: [
      { name: "HOME", value: HOME_DIR },
      {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        valueFrom: { secretKeyRef: { name: config.credentialsSecret, key: "CLAUDE_CODE_OAUTH_TOKEN", optional: true } },
      },
    ],
    ...(config.resources ? { resources: config.resources } : {}),
    volumeMounts: [
      { name: WORKSPACE_VOLUME, mountPath: WORKSPACE_ROOT },
      // Paths inside provider protocols (claude's session files, codex's thread cwd) are the daemon's, so the
      // checkout must appear at the daemon's own absolute path.
      { name: WORKSPACE_VOLUME, mountPath: cwd, subPath: CHECKOUT_SUBPATH },
    ],
  };
}

/** Deletes the pod and keeps the volume. */
export function suspendPatch() {
  return { spec: { operatingMode: "Suspended" } };
}

/** Recreates the pod on the same volume, with the current image and settings. */
export function resumePatch(config: KubernetesRuntimeConfig, cwd: string) {
  return {
    metadata: { annotations: { [SPEC_HASH_ANNOTATION]: specHash(config, cwd) } },
    spec: {
      operatingMode: "Running",
      podTemplate: { spec: { initContainers: [volumeInit(config)], containers: [workspaceContainer(config, cwd)] } },
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
