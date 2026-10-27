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

/** Whether one agent has a turn open (or waits on a permission), from the agent list; null when it cannot be read. */
export async function agentHasOpenTurn(paseo: AgentListApi | null, agentId: string): Promise<boolean | null> {
  if (!paseo) return null;
  try {
    const result = (await paseo.agents.list({})) as { entries?: { agent?: AgentLike }[] } | AgentLike[];
    const entries = Array.isArray(result) ? result : (result.entries ?? []);
    const a = entries.map((e) => ((e as { agent?: AgentLike }).agent ?? e) as AgentLike).find((x) => x.id === agentId);
    if (!a) return null;
    return a.activeTurn != null || a.status === "running" || (a.pendingPermissions?.length ?? 0) > 0;
  } catch {
    return null;
  }
}

/**
 * Sends a prompt that must not steer a running turn. Uses the host's `activeTurnBehavior: "skip"`; a host without it
 * ("Update the Paseo host") gets the same effect by looking first: an agent with no open turn is sent the prompt
 * (steer and skip are the same for it), one with an open turn or an unknown state is left alone.
 */
export async function sendUnlessBusy(
  paseo: (AgentListApi & { agents: { ref(id: string): { send(text: string, o: { activeTurnBehavior: string }): Promise<unknown> } } }) | null,
  agentId: string,
  text: string,
): Promise<"sent" | "skipped"> {
  if (!paseo) throw new Error("Paseo's API has not reached the plugin yet");
  try {
    const result = (await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "skip" })) as { skipped?: boolean } | undefined;
    return result?.skipped ? "skipped" : "sent";
  } catch (error) {
    if (!/Update the Paseo host/i.test((error as Error).message)) throw error;
    if ((await agentHasOpenTurn(paseo, agentId)) !== false) return "skipped";
    await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    return "sent";
  }
}

/**
 * The labels of each live (not archived) agent of a workspace, from the agent list. Null when the list cannot be read, which
 * callers treat as "unknown", never as "no labels".
 */
export async function labelsOfWorkspace(paseo: AgentListApi | null, workspaceId: string): Promise<Record<string, string>[] | null> {
  if (!paseo) return null;
  try {
    const result = (await paseo.agents.list({})) as { entries?: { agent?: AgentLike & { labels?: Record<string, string> } }[] } | (AgentLike & { labels?: Record<string, string> })[];
    const entries = Array.isArray(result) ? result : (result.entries ?? []);
    const agents = entries.map((e) => ((e as { agent?: AgentLike }).agent ?? e) as AgentLike & { labels?: Record<string, string> });
    return agents.filter((a) => a.workspaceId === workspaceId && !a.archivedAt).map((a) => a.labels ?? {});
  } catch {
    return null;
  }
}
