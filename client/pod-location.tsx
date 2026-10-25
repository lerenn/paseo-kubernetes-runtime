import type { PluginClientContext } from "@getpaseo/plugin/client";
import { credentialsStatus } from "../shared/credentials.js";
import { runtimeOptions } from "../shared/pod-ref.js";
import { RUNTIME_ID } from "../shared/runtime-options.js";

/**
 * The fork's `addWorkspaceLocation` (and the `runtime` field of workspace creation) are not in the published
 * SDK types, so they are typed here and feature-detected: on a plain upstream Paseo the option does not exist.
 */
interface WorkspaceLocationProject {
  id: string;
  name: string;
  directory: string;
}
export interface WorkspaceLocationRef {
  action: "branch-off" | "checkout";
  refName?: string;
  changeRequest?: { forge: string; number: number; projectPath?: string };
}
interface WorkspaceLocationContribution {
  id: string;
  title: string;
  icon: string;
  isAvailable?(context: { hostId: string; project: WorkspaceLocationProject }): boolean;
  /** Show the branch picker (default true). */
  usesRef?: boolean;
  createWorkspace(context: {
    hostId: string;
    project: WorkspaceLocationProject;
    settings: unknown;
    idempotencyKey: string;
    prompt: string;
    slug: string;
    ref: WorkspaceLocationRef | null;
  }): Promise<{ workspaceId: string; agentId?: string }>;
}
type WithWorkspaceLocation = PluginClientContext & {
  addWorkspaceLocation?: (contribution: WorkspaceLocationContribution) => () => void;
};

const REFRESH_MS = 30_000;

/** The Claude OAuth token: without it a pod agent cannot run. GitHub access needs no pod credential. */
export function credentialsReady(set: Record<string, boolean>): boolean {
  return set.CLAUDE_CODE_OAUTH_TOKEN === true;
}

/** Registers "Pod" in the New workspace dropdown. Returns a cleanup; a no-op without the fork API. */
export function contributePodLocation(client: PluginClientContext): () => void {
  const host = client as WithWorkspaceLocation;
  if (typeof host.addWorkspaceLocation !== "function") return () => {};

  let ready = false;
  let lastRefresh = 0;
  const refresh = () => {
    lastRefresh = Date.now();
    client.rpc(credentialsStatus, {}).then(
      (result) => {
        ready = credentialsReady(result.set);
      },
      () => {
        ready = false;
      },
    );
  };
  refresh();

  return host.addWorkspaceLocation({
    id: "pod",
    title: "Pod",
    icon: "ShipWheel",
    usesRef: true,
    isAvailable() {
      if (Date.now() - lastRefresh > REFRESH_MS) refresh();
      return ready;
    },
    async createWorkspace({ project, idempotencyKey, slug, ref }) {
      const status = await client.rpc(credentialsStatus, {});
      if (!credentialsReady(status.set)) {
        throw new Error("Set CLAUDE_CODE_OAUTH_TOKEN in the Kubernetes Runtime screen first.");
      }
      // The workspace runs in the Kubernetes runtime; Paseo starts its first agent itself, with the composer's
      // provider, model, thinking level and mode, so it is a real claude or codex agent running in the pod.
      const workspace = await client.paseo.workspaces.create({
        source: { kind: "directory", path: project.directory, projectId: project.id },
        title: `${project.name}-${slug}`,
        idempotencyKey,
        runtime: { id: RUNTIME_ID, options: runtimeOptions(project.directory, slug, ref, `${project.name}-${slug}`) },
      } as never);
      return { workspaceId: workspace.id };
    },
  });
}
