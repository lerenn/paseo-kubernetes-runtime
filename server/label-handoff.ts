import { randomBytes } from "node:crypto";

/** Env variable that carries a reference to an agent's labels from `agent.create` to `agent.session_open`. */
export const LABELS_REF_ENV = "PASEO_KUBE_LABELS_REF";

/**
 * The labels of an agent are known when it is created (`before("agent.create")`) but its id is not, and by
 * `agent.session_open` (which has the id and the workspace, and comes before the pod is started) the agent may not be in
 * the agent list yet. So the create hook leaves a random reference in the agent's environment and keeps the labels under
 * it here; the session hook reads them back. Memory only: a restarted plugin finds nothing, and a resumed agent's pod
 * already exists.
 */
export class LabelHandoff {
  private readonly labels = new Map<string, Record<string, string>>();

  constructor(private readonly max = 500) {}

  issue(labels: Record<string, string>): string {
    const ref = randomBytes(8).toString("hex");
    this.labels.set(ref, labels);
    while (this.labels.size > this.max) this.labels.delete(this.labels.keys().next().value!);
    return ref;
  }

  find(ref: string | undefined): Record<string, string> | undefined {
    return ref ? this.labels.get(ref) : undefined;
  }
}

interface WorkspaceRequestLike {
  runtime?: { id: string; options?: Record<string, unknown> };
  agent?: { labels?: Record<string, string> };
  [k: string]: unknown;
}

/**
 * For a workspace created with its first agent, hands that agent's labels to the Kubernetes runtime as its `labels`
 * option (which the ServiceAccount rule reads), unless the creator already set them. Other runtimes are left alone.
 */
export function withAgentLabels<R extends WorkspaceRequestLike>(request: R, runtimeId: string): R {
  const labels = request.agent?.labels;
  if (!labels || Object.keys(labels).length === 0 || request.runtime?.id !== runtimeId) return request;
  if (request.runtime.options?.labels) return request;
  return { ...request, runtime: { ...request.runtime, options: { ...request.runtime.options, labels } } };
}
