import type { KubernetesRuntimeConfig } from "./config.js";
import { RUNTIME_ID } from "../shared/runtime-options.js";

type PodOnly = KubernetesRuntimeConfig["podOnly"];
type Labels = Record<string, string> | undefined;

/**
 * The parts of the fork's `workspace.create` request this looks at (the published SDK does not carry them):
 * `runtime` (directory sources only), the source, and the initial agent whose labels say who it is for.
 */
export interface WorkspaceCreateLike {
  runtime?: { id: string; options?: Record<string, unknown> };
  source: { kind: "directory"; path: string; projectId?: string } | { kind: "worktree"; cwd?: string; projectId?: string; action?: "branch-off" | "checkout"; refName?: string; baseBranch?: string; branchName?: string; worktreeSlug?: string; [k: string]: unknown };
  title?: string;
  callerAgentId?: string;
  agent?: { labels?: Record<string, string> };
  [k: string]: unknown;
}

export const exempt = (rules: readonly string[], labels: Labels): boolean =>
  rules.some((rule) => {
    const i = rule.indexOf("=");
    const [key, value] = i < 0 ? [rule, undefined] : [rule.slice(0, i), rule.slice(i + 1)];
    return labels !== undefined && key! in labels && (value === undefined || value === "" || labels[key!] === value);
  });

/** What the exempt rule (`paseo.assistant=1`) is, in the words of a refusal. */
const why = (podOnly: PodOnly) => `pod-only mode is on (exempt: ${podOnly.exemptLabels.join(", ") || "nothing"})`;

/**
 * `before("workspace.create")`: with pod-only on, a Local (directory) or Worktree request becomes a pod workspace on
 * the Kubernetes runtime, or is refused. Returns the request to use, or the same one when nothing applies.
 * A workspace an agent creates without a runtime inherits its caller's after this hook, so it is left alone.
 */
export function podOnlyWorkspace<R extends WorkspaceCreateLike>(request: R, podOnly: PodOnly): R {
  if (!podOnly.enabled) return request;
  if (exempt(podOnly.exemptLabels, request.agent?.labels)) return request;
  if (request.runtime?.id) {
    if (request.runtime.id === RUNTIME_ID) return request;
    throw new Error(`Only pod workspaces are allowed: ${why(podOnly)}`);
  }
  if (request.callerAgentId) return request;
  if (podOnly.localWorkspaces === "refuse") throw new Error(`Local and worktree workspaces are refused: ${why(podOnly)}. Create a Pod workspace.`);
  const { source } = request;
  if (source.kind === "directory") {
    return { ...request, runtime: { id: RUNTIME_ID, options: { cwd: source.path, ...(request.title ? { title: request.title } : {}) } } };
  }
  if (!source.cwd) throw new Error(`This worktree request names no project directory, so it cannot be moved to a pod: ${why(podOnly)}`);
  const slug = source.worktreeSlug ?? source.branchName;
  return {
    ...request,
    source: { kind: "directory", path: source.cwd, ...(source.projectId ? { projectId: source.projectId } : {}) },
    runtime: {
      id: RUNTIME_ID,
      options: {
        cwd: source.cwd,
        ...(slug && /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(slug) ? { slug } : {}),
        ...(request.title ? { title: request.title } : {}),
        ...(source.action ? { ref: { action: source.action, ...(source.refName ? { refName: source.refName } : {}) } } : {}),
      },
    },
  };
}

/** The parts of the fork's `agent.create` request used here; `workspaceId` and `runtimeId` are read-only context (null runtime: local). */
export interface AgentCreateLike {
  labels?: Record<string, string>;
  parentAgentId?: string | null;
  runtimeId?: string | null;
}

/**
 * `before("agent.create")`: with pod-only on, an agent in a local workspace is refused, and so is a subagent of a local
 * parent (it lives in its parent's workspace). A daemon that does not say (`runtimeId` absent) is not restricted.
 */
export function podOnlyAgent(request: AgentCreateLike, podOnly: PodOnly): void {
  if (!podOnly.enabled || request.runtimeId === undefined) return;
  if (exempt(podOnly.exemptLabels, request.labels)) return;
  if (request.runtimeId === RUNTIME_ID) return;
  const who = request.parentAgentId ? "A subagent of an agent in a local workspace" : "An agent in a local workspace";
  throw new Error(`${who} is refused: ${why(podOnly)}. Create it in a Pod workspace.`);
}
