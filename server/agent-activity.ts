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

/**
 * The labels of one agent from the agent list (`{ entries: [{ agent }] }`, or a plain array). Undefined when the agent is
 * not in the list or the list is not readable.
 */
export async function labelsOfAgent(paseo: AgentListApi | null, agentId: string): Promise<Record<string, string> | undefined> {
  if (!paseo) return undefined;
  try {
    const result = (await paseo.agents.list({})) as { entries?: { agent?: AgentLike & { labels?: Record<string, string> } }[] } | (AgentLike & { labels?: Record<string, string> })[];
    const entries = Array.isArray(result) ? result : (result.entries ?? []);
    const agents = entries.map((e) => ((e as { agent?: AgentLike }).agent ?? e) as AgentLike & { labels?: Record<string, string> });
    return agents.find((a) => a.id === agentId)?.labels;
  } catch {
    return undefined;
  }
}
