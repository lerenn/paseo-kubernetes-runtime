/** The part of the Paseo API this needs: the agent list. */
export interface AgentListApi {
  agents: { list(options?: object): Promise<unknown> };
}

interface AgentLike {
  id?: string;
  workspaceId?: string | null;
  status?: string;
  archivedAt?: string | null;
  activeTurn?: { turnId?: string } | null;
  pendingPermissions?: unknown[];
}

/**
 * Whether an agent of this workspace is working: it has a turn open (`activeTurn`, which covers a foreground turn and
 * a woken autonomous one), is `running`, or waits on a permission. Matched on the workspace id, not on a directory
 * (several workspaces share one). Null when the list cannot be read: callers treat that as busy.
 */
export async function workspaceAgentsBusy(paseo: AgentListApi | null, workspaceId: string): Promise<boolean | null> {
  if (!paseo) return null;
  try {
    const result = (await paseo.agents.list({})) as { entries?: { agent?: AgentLike }[] } | AgentLike[];
    const entries = Array.isArray(result) ? result : (result.entries ?? []);
    const agents = entries.map((e) => ((e as { agent?: AgentLike }).agent ?? e) as AgentLike);
    return agents.some(
      (a) => a.workspaceId === workspaceId && !a.archivedAt && (a.activeTurn != null || a.status === "running" || (a.pendingPermissions?.length ?? 0) > 0),
    );
  } catch {
    return null;
  }
}
