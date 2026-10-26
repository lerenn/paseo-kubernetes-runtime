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
  /** Pod placement (e.g. {"lab.anyshift.io/pool": "burst"}). */
  nodeSelector: z.record(z.string(), z.string()).default({}),
  /** Taint keys every pod tolerates (operator Exists). */
  tolerationKeys: z.array(z.string()).default([]),
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
  /** A workspace whose agents have all been idle this long has its pod deleted (the volume stays); any input brings it back. 0 = never. */
  podIdleMinutes: z.number().int().min(0).default(30),
});

export type KubernetesRuntimeConfig = z.infer<typeof ConfigSchema>;

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
