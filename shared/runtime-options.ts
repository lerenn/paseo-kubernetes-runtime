import { z } from "zod";

/** What the Pod location in the New workspace form hands the runtime; Paseo gives it back on every call. */
export const RuntimeOptionsSchema = z.object({
  /** The project's checkout on the daemon. The pod shows its copy at this same absolute path. */
  cwd: z.string().startsWith("/").refine((p) => p !== "/" && p !== "/workspace", "Pick a project directory"),
  /** Paseo's worktree slug for the draft: names the pod and the new branch. */
  slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/).optional(),
  /** The workspace's name in Paseo; labels the pod. Kept current by the reconciler when the workspace is renamed. */
  title: z.string().max(200).optional(),
  /** Override of the agent labels that pick the pod's ServiceAccount; normally taken from the workspace's first agent. */
  labels: z.record(z.string(), z.string()).optional(),
  /** A named pod profile of the settings (another image, a bigger volume), for workspaces that need one. */
  profile: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
  /** The branch picker's choice. */
  ref: z
    .object({
      action: z.enum(["branch-off", "checkout"]),
      refName: z.string().optional(),
      changeRequest: z.object({ forge: z.string(), number: z.number().int(), projectPath: z.string().optional() }).optional(),
    })
    .nullish(),
});

export type RuntimeOptions = z.infer<typeof RuntimeOptionsSchema>;

export const RUNTIME_ID = "kubernetes";

export function parseRuntimeOptions(options: unknown): RuntimeOptions {
  const parsed = RuntimeOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error(`This workspace has no usable Kubernetes runtime options: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data;
}
