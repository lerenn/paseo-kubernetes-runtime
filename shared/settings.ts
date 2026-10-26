import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_NAMESPACE = "paseo-agents";
/** Pinned by digest, built by the image workflow from image/Dockerfile (bump it with each image release). */
export const DEFAULT_IMAGE = "ghcr.io/lerenn/paseo-kubernetes-runtime-default@sha256:f4aedb1145658527f3e43dd1ae6d95a917b39e94799491eae6f9c400ccd8e3b5";

/** Where a workspace pod's `/workspace` (the checkout, HOME and the agents' session state) lives. */
export const StorageSchema = z.object({
  /** `persistent` is a ReadWriteOnce PVC owned by the Sandbox; `ephemeral` is an emptyDir lost with the pod. */
  mode: z.enum(["ephemeral", "persistent"]).default("persistent"),
  /** A Kubernetes quantity, e.g. 10Gi. */
  size: z.string().regex(/^[1-9][0-9]*(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/, "Use a Kubernetes quantity such as 10Gi").default("10Gi"),
  /** Empty (unset) uses the cluster's default StorageClass. */
  storageClassName: z.string().optional(),
});

/** A named variant of the pod configuration, chosen per workspace (runtime option `profile`). Only what is listed here changes. */
/** A directory of the daemon copied once into the pod's volume (data that is not in git, such as a test corpus). */
export const SeedDirSchema = z.object({
  /** Absolute path on the daemon. */
  from: z.string().startsWith("/"),
  /** Directory under /workspace in the pod, `name` or `a/b`; it must not be `checkout` or `.home`. */
  to: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, "A relative path under /workspace")
    .refine((t) => !t.split("/").includes("..") && !["checkout", ".home"].includes(t.split("/")[0]!), "Not the checkout or the home"),
  /** `tar --exclude` patterns. */
  exclude: z.array(z.string()).default([]),
});

export const ProfileSchema = z.object({
  /** Copied into the volume the first time the workspace starts; a marker on the volume keeps it from being copied again. */
  seed: z.array(SeedDirSchema).default([]),
  image: z.string().min(1).optional(),
  /** Overrides the size and storage class of a new workspace volume. An existing volume keeps its claim. */
  storage: z
    .object({
      size: z.string().regex(/^[1-9][0-9]*(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/, "Use a Kubernetes quantity such as 40Gi").optional(),
      storageClassName: z.string().optional(),
    })
    .optional(),
  resources: z
    .object({
      requests: z.record(z.string(), z.string()).optional(),
      limits: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

export const ConfigSchema = z.object({
  /** kubectl context. Unset uses the current context of the daemon's kubeconfig. */
  context: z.string().optional(),
  namespace: z.string().default(DEFAULT_NAMESPACE),
  /** apiVersion of the agent-sandbox `Sandbox` CRD. */
  sandboxApiVersion: z.string().default("agents.x-k8s.io/v1beta1"),
  /** Container image for workspace pods. It needs node and git; claude and codex are installed on first use if missing. */
  image: z.string().default(DEFAULT_IMAGE),
  resources: z
    .object({
      requests: z.record(z.string(), z.string()).optional(),
      limits: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /** Secret (keys become env vars: CLAUDE_CODE_OAUTH_TOKEN) mounted by envFrom. */
  credentialsSecret: z.string().default("paseo-agent-credentials"),
  readyTimeoutSeconds: z.number().int().positive().default(300),
  /**
   * Named variants for workspaces that need another image or a bigger volume (e.g. `prbr-picky`), chosen with the
   * workspace's runtime option `profile`. A name that is not listed here refuses the workspace. Workspaces with a
   * profile never take a warm pod.
   */
  profiles: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), ProfileSchema).default({}),
  /** Pod placement (e.g. {"lab.anyshift.io/pool": "burst"}). */
  nodeSelector: z.record(z.string(), z.string()).default({}),
  /** Taint keys every pod tolerates (operator Exists). */
  tolerationKeys: z.array(z.string()).default([]),
  /** Tolerations with a value and effect (e.g. key lab.anyshift.io/agents, Equal, "true", NoSchedule); added to `tolerationKeys`. */
  tolerations: z
    .array(
      z.object({
        key: z.string().min(1),
        operator: z.enum(["Exists", "Equal"]).default("Exists"),
        value: z.string().optional(),
        effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]).optional(),
      }),
    )
    .default([]),
  /**
   * Annotations on the pods of workspaces (not on warm pods, which wait for one), e.g. {"karpenter.sh/do-not-disrupt": "true"}
   * so the autoscaler leaves a node alone while an agent works on it. A suspended workspace has no pod, so they go with it.
   */
  podAnnotations: z.record(z.string(), z.string()).default({}),
  /**
   * ServiceAccount by agent label. The first rule whose `label` (`key=value`) is among the labels of the first agent
   * of a workspace names the pod's ServiceAccount, and its token is mounted. No match: the pod has no token.
   * Chosen when the pod is created, so a warm pod (which waits for any workspace) is never used for one.
   */
  serviceAccounts: z
    .array(
      z.object({
        label: z.string().regex(/^[^=\s]+=[^=\s]*$/, "Use key=value, e.g. paseo.ops=1"),
        serviceAccount: z.string().min(1),
      }),
    )
    .default([]),
  storage: StorageSchema.default({ mode: "persistent", size: "10Gi" }),
  /**
   * Also delete this plugin's sandboxes that carry no daemon label (made before labelling existed) and match no
   * agent of this daemon, after 15 minutes. Turn off where several daemons share one namespace.
   */
  sweepUnlabelled: z.boolean().default(true),
  /**
   * Repositories other than the workspace's own (and its submodules) that a pod may `git clone`, fetch and push
   * branches to, through the daemon and with its git credentials.
   */
  otherRepos: z
    .object({
      enabled: z.boolean().default(true),
      /** Git hosts the pods may reach this way. */
      hosts: z.array(z.string()).default(["github.com"]),
      /** `owner/*` or `owner/repo` patterns; empty allows every repository the daemon can reach. */
      allow: z.array(z.string()).default([]),
    })
    .default({ enabled: true, hosts: ["github.com"], allow: [] }),
  /**
   * Pods kept running ahead of workspaces, so a new workspace starts in seconds instead of waiting for scheduling and a
   * volume (about 15 s of a 33 s start). Each costs its CPU/memory request and a volume while it waits. New workspaces
   * use the mapped layout (the checkout at a fixed path, Paseo rewriting paths with `mapCwd`) while this is on.
   */
  warmPool: z
    .object({
      enabled: z.boolean().default(false),
      size: z.number().int().min(1).max(5).default(1),
      /** Warm pods are removed this long after the last workspace or agent start, and not replaced until the next one. 0 = never. */
      idleMinutes: z.number().int().min(0).default(0),
    })
    .default({ enabled: false, size: 1, idleMinutes: 0 }),
  /**
   * Pod-only mode. Off by default. When on, a request for a Local or Worktree workspace is moved to a pod (or refused),
   * and an agent is refused in a local workspace, unless its labels match `exemptLabels` (`key=value`).
   */
  podOnly: z
    .object({
      enabled: z.boolean().default(false),
      exemptLabels: z.array(z.string().regex(/^[^=\s]+(=[^=\s]*)?$/, "Use key=value")).default(["paseo.assistant=1"]),
      /** `rewrite` moves a Local or Worktree workspace request to a pod; `refuse` rejects it. */
      localWorkspaces: z.enum(["rewrite", "refuse"]).default("rewrite"),
    })
    .default({ enabled: false, exemptLabels: ["paseo.assistant=1"], localWorkspaces: "rewrite" }),
  /** A workspace whose agents have all been idle this long has its pod deleted (the volume stays); any input brings it back. 0 = never. */
  podIdleMinutes: z.number().int().min(0).default(30),
});

export type KubernetesRuntimeConfig = z.infer<typeof ConfigSchema>;

/** The configuration a workspace runs with: the settings, with its profile's image, storage and resources applied. */
export function applyProfile(config: KubernetesRuntimeConfig, profile: string | undefined): KubernetesRuntimeConfig {
  if (!profile) return config;
  const p = config.profiles[profile];
  if (!p) throw new Error(`This workspace asks for the pod profile "${profile}", which the Kubernetes Runtime settings do not define (profiles: ${Object.keys(config.profiles).join(", ") || "none"})`);
  return {
    ...config,
    ...(p.image ? { image: p.image } : {}),
    ...(p.resources ? { resources: { ...config.resources, ...p.resources } } : {}),
    storage: { ...config.storage, ...(p.storage?.size ? { size: p.storage.size } : {}), ...(p.storage?.storageClassName ? { storageClassName: p.storage.storageClassName } : {}) },
  };
}

/**
 * v1 had named templates and `defaultImage`. v2 is one flat pod configuration: the old `default`
 * template's image, resources and placement (and `defaultImage`) are folded in, so a running setup
 * keeps the same pods. Other templates and per-template warm pools are dropped.
 */
export function migrateSettings(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 2 || typeof values !== "object" || values === null) return values;
  const old = values as Record<string, any>;
  const { templates, defaultImage, ...rest } = old;
  const def = templates?.default ?? {};
  const nodeSelector = Object.keys(rest.nodeSelector ?? {}).length > 0 ? rest.nodeSelector : def.nodeSelector;
  const tolerationKeys =
    (rest.tolerationKeys ?? []).length > 0
      ? rest.tolerationKeys
      : (def.tolerations ?? []).map((t: { key?: string }) => t.key).filter((k: unknown): k is string => typeof k === "string");
  return {
    ...rest,
    image: def.image ?? defaultImage ?? rest.image,
    ...(def.resources ? { resources: def.resources } : {}),
    ...(nodeSelector ? { nodeSelector } : {}),
    ...(tolerationKeys.length > 0 ? { tolerationKeys } : {}),
  };
}

export const kubeSettings = defineSettings({
  id: "kube",
  scope: "host",
  version: 2,
  schema: ConfigSchema,
  migrate: migrateSettings,
});
