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
  /** `tar --exclude` patterns, relative to `from` as tar sees them (`./cache`, `*.log`). */
  exclude: z.array(z.string()).default([]),
  /** Keep only some entries of a directory: everything in `dir` (relative to `from`) not named in `keep` is left out. */
  prune: z
    .array(z.object({ dir: z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/), keep: z.array(z.string()).default([]) }))
    .default([]),
});

/** A key of a Secret handed to the pods of one profile only, by reference (the daemon never reads the value). */
export const ExtraSecretSchema = z.object({
  secret: z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/, "A Kubernetes Secret name"),
  key: z.string().regex(/^[A-Za-z0-9._-]{1,253}$/, "A Secret key"),
  /** The environment variable in the pod; the key's name when absent. */
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "An environment variable name").optional(),
  /** A missing Secret or key leaves the variable unset instead of keeping the pod from starting. */
  optional: z.boolean().default(true),
});

export const SubmoduleCheckoutSchema = z.enum(["pinned", "remote"]);
export type SubmoduleCheckout = z.infer<typeof SubmoduleCheckoutSchema>;

export const ProfileSchema = z.object({
  /** Overrides `gitProxy.submoduleCheckout` for workspaces of this profile (for example `remote` for Factory workers that read current code). */
  submoduleCheckout: SubmoduleCheckoutSchema.optional(),
  /** The workspace gets a per-workspace Docker sandbox (see `docker` in the settings): a privileged dind pod on its own node. */
  docker: z.union([z.boolean(), z.enum(["sandbox", "sidecar"])]).optional(),
  /** Secret keys exposed as environment variables on pods of this profile only (e.g. OPENAI_API_KEY for a codex profile). */
  extraSecrets: z.array(ExtraSecretSchema).optional(),
  /** Copied into the volume the first time the workspace starts; a marker on the volume keeps it from being copied again. */
  seed: z.array(SeedDirSchema).default([]),
  image: z.string().min(1).optional(),
  /** Added to the global `nodeSelector` (this one wins on a shared key), e.g. karpenter.sh/capacity-type=on-demand. */
  nodeSelector: z.record(z.string(), z.string()).optional(),
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

/**
 * The privileged dind sidecar container (`dockerd`) a workspace pod gets in `sidecar` Docker mode. A privileged container is
 * root on the node: the isolation risk is accepted explicitly (see the README).
 */
export const DockerSidecarSchema = z.object({
  /** The dind image; the Docker sandbox's `docker.image` when absent. */
  image: z.string().min(1).optional(),
  /** Tiny requests (it does not change the pod's own), a memory limit and an ephemeral-storage limit so a build cannot fill the node's disk. */
  resources: z
    .object({
      requests: z.record(z.string(), z.string()).default({ cpu: "10m", memory: "64Mi" }),
      limits: z.record(z.string(), z.string()).default({ memory: "8Gi", "ephemeral-storage": "20Gi" }),
    })
    .default(() => ({ requests: { cpu: "10m", memory: "64Mi" }, limits: { memory: "8Gi", "ephemeral-storage": "20Gi" } })),
});

/** The per-workspace Docker sandbox: a privileged `docker:dind` pod on a dedicated node, for workspaces whose profile has `docker: true`. */
export const DockerSchema = z.object({
  /** Namespace of the sandbox pods, Services and NetworkPolicies (not the agents' namespace). */
  namespace: z.string().default("paseo-docker"),
  /** The sandbox image: dockerd on tcp 2375 plus an rsync daemon on 873 exporting /work. */
  image: z.string().default("docker:dind"),
  /** The sandbox is deleted after this many minutes without a running container. 0 = never. */
  idleMinutes: z.number().int().min(0).default(15),
  /** The sandbox is deleted this long after it started, whatever it runs. 0 = never. */
  maxHours: z.number().min(0).default(8),
  nodeSelector: z.record(z.string(), z.string()).default({ "paseo.sh/pool": "docker" }),
  tolerations: z
    .array(
      z.object({
        key: z.string().min(1),
        operator: z.enum(["Exists", "Equal"]).default("Exists"),
        value: z.string().optional(),
        effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]).optional(),
      }),
    )
    .default([{ key: "paseo.sh/docker", operator: "Exists", effect: "NoSchedule" }]),
  resources: z
    .object({
      requests: z.record(z.string(), z.string()).optional(),
      limits: z.record(z.string(), z.string()).optional(),
    })
    .default({ requests: { cpu: "3", memory: "26Gi" }, limits: { memory: "28Gi" } }),
});

const LabelRule = z.string().regex(/^[^=\s]+(=[^=\s]*)?$/, "Use key=value");

/**
 * Archives workspaces that have been idle for days, after a warning. Every check that the pod holds nothing unpushed
 * must pass first (see server/autoarchive.ts); a workspace that fails one is listed on the screen and never archived.
 */
export const AutoArchiveSchema = z.object({
  enabled: z.boolean().default(true),
  /** Warn and log what would be archived, but archive nothing. On by default: turn it off once the log looks right. */
  dryRun: z.boolean().default(true),
  /** Archive a workspace after this many days without activity. 0 = never. */
  idleDays: z.number().min(0).default(2),
  /** The warning (a notice in the workspace, "archives in Xh unless activity") comes this long before the archive. */
  warnHours: z.number().min(0).default(12),
  /** Workspaces with an agent carrying one of these labels (`key=value`) are never archived. */
  exemptLabels: z.array(LabelRule).default(["paseo.keep=1"]),
  /** At most this many workspaces are archived per run (every minute). */
  maxPerRun: z.number().int().min(1).default(3),
  /** Throwaway workspaces (an agent with this label) are archived sooner. */
  ephemeral: z
    .object({
      label: LabelRule.default("paseo.ephemeral=1"),
      idleHours: z.number().min(0).default(6),
    })
    .default({ label: "paseo.ephemeral=1", idleHours: 6 }),
  /** A ceiling on a workspace's age, whatever its activity. Off (unset or 0) by default; dirty or unpushed workspaces are still skipped. */
  maxAgeDays: z.number().min(0).optional(),
  /** The namespace's pod quota, if any: a suspended workspace without a stored check is resumed for one only while fewer than quota - 2 pods exist. Unset: no quota check. */
  podQuota: z.number().int().min(1).optional(),
});

/**
 * The daemon-side git proxy for pods. Every clone, fetch and submodule update of a GitHub repository of an allowed org, in the
 * pod, goes through the daemon's mirror bridge (its credentials, its cache, its fetch throttling) instead of reaching GitHub
 * from the pod; the project's own submodules are provisioned the same way, whatever org they are in.
 */
export const GitProxySchema = z.object({
  enabled: z.boolean().default(true),
  /** GitHub orgs (or users) whose repositories a pod may clone and fetch through the daemon. Narrows `otherRepos` for github.com. */
  allowOrgs: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/, "A GitHub org or user name")).default(["anyshift-io", "anyshift-engineering", "lerenn"]),
  /** The agent's start waits at most this long for the submodules to be checked out; they keep going in the background after it. 0 = never wait. */
  provisionWaitSeconds: z.number().int().min(0).max(600).default(30),
  /**
   * Which commit a new workspace's submodules are checked out at. `pinned`: the gitlink the seeded commit records, as
   * `git submodule update` does (it can be weeks behind the submodule's own main in a superproject that bumps them rarely).
   * `remote`: the tip of the submodule's remote default branch (or the `branch` `.gitmodules` names), fetched at provisioning.
   */
  submoduleCheckout: SubmoduleCheckoutSchema.default("pinned"),
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
  /**
   * Project directory (exact path, or a prefix: it matches everything below it; the longest wins) to profile name. Applied to
   * a workspace that has no explicit `profile` runtime option; an explicit one always wins. A Paseo worktree of the project
   * matches through the project its repository belongs to. A name that `profiles` does not define is ignored, with a log line.
   */
  projectProfiles: z.record(z.string().startsWith("/"), z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).default({}),
  /** Not a setting: filled by `applyProfile` from the profile's `extraSecrets`, so the pod spec and its hash see them. */
  extraSecrets: z.array(ExtraSecretSchema).default([]),
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
   * Annotations on a workspace's pod only while an agent has a turn open: put on when a turn opens, taken off 30 s after the
   * last one ends (and reconciled after a plugin restart). The default keeps Karpenter from consolidating a node under a working
   * agent but lets it reclaim an idle one. `podAnnotations` should no longer carry `karpenter.sh/do-not-disrupt`.
   */
  turnAnnotations: z.record(z.string(), z.string()).default({ "karpenter.sh/do-not-disrupt": "true" }),
  /**
   * ServiceAccount by agent label. The first rule whose `label` (`key=value`) is among the labels of the first agent
   * of a workspace names the pod's ServiceAccount, and its token is mounted. No match: the pod has no token.
   * Chosen when the pod is created, so a warm pod (which waits for any workspace) is never used for one.
   */
  serviceAccounts: z
    .array(
      z.object({
        label: z.string().regex(/^[^=\s]+=[^=\s]*$/, "Use key=value, e.g. paseo.scoped-daemon-access=1"),
        serviceAccount: z.string().min(1),
      }),
    )
    .default([]),
  storage: StorageSchema.default({ mode: "persistent", size: "10Gi" }),
  /** Settings of the Docker sandbox that profiles with `docker: true` get. */
  docker: DockerSchema.default(() => DockerSchema.parse({})),
  /** The Docker mode of a workspace whose profile does not say (and of one with no profile): none, a privileged dind sidecar in its pod, or the separate Docker sandbox pod. */
  dockerDefault: z.enum(["off", "sidecar", "sandbox"]).default("off"),
  /** Settings of the dind sidecar container (mode `sidecar`). */
  dockerSidecar: DockerSidecarSchema.default(() => DockerSidecarSchema.parse({})),
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
  /** The git proxy: allow-listed orgs for clones through the daemon, submodule provisioning and the `submodule_status`/`submodule_wait` tools. */
  gitProxy: GitProxySchema.default(() => GitProxySchema.parse({})),
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
  /**
   * Workspaces whose first agent has one of these labels (`key=value`) are never suspended when idle. For agents that wait on
   * background work Paseo cannot show as "running" (monitors, scheduled wakeups): suspending them ends an open turn and shows an error.
   */
  idleExemptLabels: z.array(z.string().regex(/^[^=\s]+(=[^=\s]*)?$/, "Use key=value")).default([]),
  /**
   * What happens to agents whose turn a node reclaim (Spot interruption, node loss) cut short. `interruptedExit` reports
   * the stop to Paseo as the exit reason `interrupted` instead of `runtime-lost`: turn off until the Paseo in use has that
   * reason, or the turn is failed like before. `autoResume` sends the agent one prompt to carry on once the pod is back.
   * `checkpointNudge` tells an agent mid-turn to commit and push when its pod starts to be taken away.
   */
  recovery: z
    .object({
      interruptedExit: z.boolean().default(false),
      autoResume: z.boolean().default(true),
      checkpointNudge: z.boolean().default(true),
    })
    .default({ interruptedExit: false, autoResume: true, checkpointNudge: true }),
  /**
   * One mail (through Agents Mail) when an agent's pod fails: an out-of-memory kill, a pod that cannot start or pull its image, or
   * an eviction the automatic resume gave up on. Deduped per agent and reason for `dedupeMinutes`. Off: only the log, as before.
   */
  errorMail: z
    .object({
      enabled: z.boolean().default(true),
      to: z.string().min(1).default("@assistant"),
      dedupeMinutes: z.number().int().min(1).default(30),
    })
    .default({ enabled: true, to: "@assistant", dedupeMinutes: 30 }),
  /** A workspace whose agents have all been idle this long has its pod deleted (the volume stays); any input brings it back. 0 = never. */
  podIdleMinutes: z.number().int().min(0).default(30),
  autoArchive: AutoArchiveSchema.default(() => AutoArchiveSchema.parse({})),
}).superRefine((c, ctx) => {
  const a = c.autoArchive;
  // A workspace is archived from its idle time; it must be suspended well before, or the check would resume it.
  if (a.enabled && c.podIdleMinutes > 0) {
    if (a.idleDays > 0 && a.idleDays * 24 * 60 <= c.podIdleMinutes) ctx.addIssue({ code: "custom", path: ["autoArchive", "idleDays"], message: "idleDays must be longer than podIdleMinutes" });
    if (a.ephemeral.idleHours > 0 && a.ephemeral.idleHours * 60 <= c.podIdleMinutes) ctx.addIssue({ code: "custom", path: ["autoArchive", "ephemeral", "idleHours"], message: "ephemeral.idleHours must be longer than podIdleMinutes" });
  }
});

export type KubernetesRuntimeConfig = z.infer<typeof ConfigSchema>;
export type GitProxyConfig = z.infer<typeof GitProxySchema>;
export type DockerConfig = z.infer<typeof DockerSchema>;
export type AutoArchiveConfig = z.infer<typeof AutoArchiveSchema>;

/** The profile `projectProfiles` gives a directory: an exact path or the longest listed ancestor directory. */
export function projectProfileFor(projectProfiles: Record<string, string>, dir: string): string | undefined {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const target = norm(dir);
  let best: string | undefined;
  let bestLen = -1;
  for (const [prefix, profile] of Object.entries(projectProfiles)) {
    const key = norm(prefix);
    if ((target === key || target.startsWith(key + "/")) && key.length > bestLen) {
      best = profile;
      bestLen = key.length;
    }
  }
  return best;
}

export type DockerMode = "off" | "sidecar" | "sandbox";

/** A workspace's Docker mode: its profile's `docker` (`true` is `sandbox`) when set, else `dockerDefault`; workspaces without a profile get the default. */
export function dockerMode(config: KubernetesRuntimeConfig, profile: string | undefined): DockerMode {
  const d = profile ? config.profiles[profile]?.docker : undefined;
  if (d === undefined) return config.dockerDefault;
  if (d === true || d === "sandbox") return "sandbox";
  return d === "sidecar" ? "sidecar" : "off";
}

/** Whether a workspace gets the separate Docker sandbox pod (mode `sandbox`). */
export function dockerEnabled(config: KubernetesRuntimeConfig, profile: string | undefined): boolean {
  return dockerMode(config, profile) === "sandbox";
}

/** The configuration a workspace runs with: the settings, with its profile's image, storage and resources applied. */
/** Bytes of a Kubernetes quantity (`768Mi`, `4Gi`, `1G`, `500000`); NaN when it is not one. */
export function quantityBytes(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(q.trim());
  if (!m) return NaN;
  const unit: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, k: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Number(m[1]) * (m[2] ? unit[m[2]]! : 1);
}

/**
 * A profile that raises the memory request keeps the global limit (resources merge per section), and Kubernetes rejects a pod
 * whose request is above its limit: the limit is raised to the request then.
 */
export function fitMemoryLimit<R extends { requests?: Record<string, string>; limits?: Record<string, string> }>(r: R): R {
  const request = r.requests?.memory;
  const limit = r.limits?.memory;
  if (!request || !limit || !(quantityBytes(request) > quantityBytes(limit))) return r;
  return { ...r, limits: { ...r.limits, memory: request } };
}

export function applyProfile(config: KubernetesRuntimeConfig, profile: string | undefined): KubernetesRuntimeConfig {
  if (!profile) return config;
  const p = config.profiles[profile];
  if (!p) throw new Error(`This workspace asks for the pod profile "${profile}", which the Kubernetes Runtime settings do not define (profiles: ${Object.keys(config.profiles).join(", ") || "none"})`);
  return {
    ...config,
    ...(p.image ? { image: p.image } : {}),
    ...(p.extraSecrets ? { extraSecrets: p.extraSecrets } : {}),
    ...(p.nodeSelector ? { nodeSelector: { ...config.nodeSelector, ...p.nodeSelector } } : {}),
    ...(p.resources ? { resources: fitMemoryLimit({ ...config.resources, ...p.resources }) } : {}),
    ...(p.submoduleCheckout ? { gitProxy: { ...config.gitProxy, submoduleCheckout: p.submoduleCheckout } } : {}),
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
