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
  agents: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
});
export type PodRow = z.infer<typeof PodRowSchema>;

const ReaperSchema = z.object({
  lastRunAt: z.string().optional(),
  removed: z.number(),
  removedTotal: z.number(),
  unlabelled: z.array(z.string()),
  error: z.string().optional(),
});

/** What the Kubernetes Runtime screen shows: the pods this plugin runs and the last orphan cleanup. */
export const kubeStatus = defineRpc({
  name: "kube.status",
  input: z.object({}),
  output: z.object({ reaper: ReaperSchema, pods: z.array(PodRowSchema) }),
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
