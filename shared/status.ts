import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PodStateSchema = z.enum(["running", "suspended", "creating", "error"]);

/** One pod of the table in the Kubernetes Runtime screen. */
export const PodRowSchema = z.object({
  workspaceId: z.string(),
  /** The workspace's title in Paseo; falls back to the label on the Sandbox. */
  title: z.string(),
  sandbox: z.string(),
  state: PodStateSchema,
  /** Why the pod is in the error state. */
  problem: z.string().optional(),
  /** ISO time the pod entered this state, when known. */
  since: z.string().optional(),
  /** Short image name and digest, e.g. paseo-kubernetes-runtime-default@f4aedb114565. */
  image: z.string().optional(),
  size: z.string().optional(),
  /** Out-of-memory kills of this workspace's pod processes. */
  oom: z.object({ count: z.number(), lastAt: z.string(), limit: z.string().optional(), peakMi: z.number().optional() }).optional(),
  agents: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
  /** The workspace's Docker sandbox, for a workspace whose profile has one. `stopped`: no pod (suspended, idle or past its maximum age). */
  docker: z
    .object({
      state: z.enum(["starting", "running", "stopped", "error"]),
      problem: z.string().optional(),
      since: z.string().optional(),
      /** Out-of-memory kills of the sandbox, counted apart from the agent's (role docker). */
      oom: z.object({ count: z.number(), lastAt: z.string(), limit: z.string().optional() }).optional(),
    })
    .optional(),
  /** Where the workspace is in the auto-archive sequence, when it is in it (shown as a badge). */
  autoArchive: z.enum(["scheduled", "blocked", "kept"]).optional(),
  autoArchiveText: z.string().optional(),
});
export type PodRow = z.infer<typeof PodRowSchema>;

const ReaperSchema = z.object({
  lastRunAt: z.string().optional(),
  removed: z.number(),
  removedTotal: z.number(),
  unlabelled: z.array(z.string()),
  error: z.string().optional(),
});

const AutoArchiveSchema = z.object({
  enabled: z.boolean(),
  dryRun: z.boolean(),
  /** Idle long enough and warned: archived at `archiveAt` (or, in a dry run, logged then). */
  scheduled: z.array(z.object({ workspaceId: z.string(), title: z.string(), archiveAt: z.string() })),
  /** Idle long enough but not archivable: why, and since when the workspace has been idle. */
  blocked: z.array(z.object({ workspaceId: z.string(), title: z.string(), reason: z.string(), idleSince: z.string().optional() })),
  recent: z.array(
    z.object({
      at: z.string(),
      workspaceId: z.string(),
      title: z.string(),
      reason: z.string(),
      outcome: z.enum(["archived", "would-archive", "failed"]),
      dryRun: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
});
export type AutoArchiveStatus = z.infer<typeof AutoArchiveSchema>;

/** What the Kubernetes Runtime screen shows: the pods this plugin runs, the last orphan cleanup and the auto-archive state. */
export const kubeStatus = defineRpc({
  name: "kube.status",
  input: z.object({}),
  output: z.object({
    reaper: ReaperSchema,
    pods: z.array(PodRowSchema),
    autoArchive: AutoArchiveSchema.optional(),
    /** True when this is an earlier snapshot, served because a refresh is running or slow (never set on a fresh one). */
    stale: z.boolean().optional(),
    /** Age of the snapshot in milliseconds. */
    ageMs: z.number().optional(),
  }),
});

/** Keep a workspace from being auto-archived (or let it be again). */
export const kubeKeep = defineRpc({
  name: "kube.keep",
  input: z.object({ workspaceId: z.string(), keep: z.boolean() }),
  output: z.object({ ok: z.boolean(), message: z.string().optional() }),
});

export const PodActionSchema = z.enum(["suspend", "resume", "restart", "delete"]);
export type PodAction = z.infer<typeof PodActionSchema>;

/** Suspend, resume, restart or delete one workspace's pod. Refuses a busy pod unless `force`. */
export const kubePodAction = defineRpc({
  name: "kube.pod.action",
  input: z.object({
    workspaceId: z.string(),
    action: PodActionSchema,
    /** Go ahead although an agent is running or has background work in the pod. */
    force: z.boolean().optional(),
    /** With `delete`: also archive the workspace. */
    archive: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    /** Set when the pod is busy: what is running, so the screen can ask before forcing. */
    busy: z.string().optional(),
    message: z.string().optional(),
  }),
});

/** Run the orphan cleanup now. */
export const kubeReconcile = defineRpc({
  name: "kube.reconcile",
  input: z.object({}),
  output: z.object({ reaper: ReaperSchema }),
});
