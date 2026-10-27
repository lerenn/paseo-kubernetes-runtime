import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PodRow } from "../shared/status.js";
import type { ClaimInfo, Kube, PodInfo, SandboxInfo } from "./kube.js";
import { CWD_ANNOTATION, DAEMON_LABEL, STATE_LABEL, WARM_STATE, WORKSPACE_ID_LABEL, WORKSPACE_LABEL, workspaceClaimName } from "./sandbox.js";
import type { PodEntry } from "./registry.js";
import type { OomEntry } from "./oom.js";

const execFileAsync = promisify(execFile);

/** Rows of warm pods carry this prefix in place of a workspace id. */
export const WARM_PREFIX = "warm:";

export interface AgentSummary {
  id: string;
  title: string;
  status: string;
  cwd: string;
}

/** The agents Paseo has (not archived), for the Agents column and the busy check. Null when unreadable. */
export async function paseoAgents(
  exec: (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }> = execFileAsync as never,
): Promise<AgentSummary[] | null> {
  try {
    const { stdout } = await exec("paseo", ["agent", "ls", "--json", "--global", "--background"], { timeout: 20_000 });
    const list = JSON.parse(stdout) as { id?: string; name?: string; status?: string; cwd?: string }[];
    if (!Array.isArray(list)) return null;
    return list.filter((a) => a.id).map((a) => ({ id: a.id!, title: a.name || a.id!.slice(0, 8), status: a.status ?? "", cwd: a.cwd ?? "" }));
  } catch {
    return null;
  }
}

/** `registry.example/org/name@sha256:0123456789abcdef...` becomes `name@0123456789ab`; a tag stays `name:tag`. */
export function shortImage(image: string | undefined): string | undefined {
  if (!image) return undefined;
  const [ref, digest] = image.split("@");
  const name = ref!.split("/").pop()!;
  return digest ? `${name.split(":")[0]}@${digest.replace(/^sha256:/, "").slice(0, 12)}` : name;
}

/** The agents running in a workspace directory (the workspace's own agents, including those in subdirectories). */
export function agentsIn(agents: readonly AgentSummary[], cwd: string | undefined) {
  if (!cwd) return [];
  const root = cwd.replace(/\/+$/, "");
  return agents
    .filter((a) => a.cwd === root || a.cwd.startsWith(`${root}/`))
    .map(({ id, title, status }) => ({ id, title, status }));
}

export interface StatusInputs {
  sandboxes: readonly SandboxInfo[];
  claims: readonly ClaimInfo[];
  /** Pod facts by sandbox name (null: no pod). */
  pods: ReadonlyMap<string, PodInfo | null>;
  /** The plugin's own record of when each workspace entered its state. */
  entries: readonly PodEntry[];
  /** Workspace titles by id, from Paseo. */
  titles: ReadonlyMap<string, string> | null;
  agents: readonly AgentSummary[] | null;
  /** Out-of-memory kills by workspace id. */
  oom?: ReadonlyMap<string, OomEntry>;
}

/** The pods table: one row per workspace this daemon has a Sandbox for. */
export function buildPodRows(input: StatusInputs): PodRow[] {
  const claims = new Map(input.claims.map((c) => [c.name, c]));
  const entries = new Map(input.entries.map((e) => [e.workspaceId, e]));
  const rows: PodRow[] = [];
  for (const sandbox of input.sandboxes) {
    const warm = !sandbox.labels[WORKSPACE_ID_LABEL] && sandbox.labels[STATE_LABEL] === WARM_STATE;
    const workspaceId = warm ? `${WARM_PREFIX}${sandbox.name}` : (sandbox.labels[WORKSPACE_ID_LABEL] ?? sandbox.labels[WORKSPACE_LABEL]);
    if (!workspaceId) continue;
    const pod = input.pods.get(sandbox.name) ?? null;
    let state: PodRow["state"];
    let problem: string | undefined;
    if (sandbox.operatingMode === "Suspended" && !pod) state = "suspended";
    else if (pod?.problem) (state = "error"), (problem = pod.problem);
    else if (pod?.ready && !pod.terminating) state = "running";
    else state = "creating";
    const entry = entries.get(workspaceId);
    const oom = input.oom?.get(workspaceId);
    rows.push({
      workspaceId,
      title: warm ? "Warm pod (waiting for a workspace)" : input.titles?.get(workspaceId) || sandbox.annotations["paseo.sh/workspace-name"] || sandbox.labels[WORKSPACE_LABEL] || workspaceId,
      sandbox: sandbox.name,
      state,
      ...(problem ? { problem } : {}),
      ...(entry ? { since: new Date(entry.since).toISOString() } : {}),
      ...(shortImage(sandbox.image) ? { image: shortImage(sandbox.image) } : {}),
      ...(claims.get(workspaceClaimName(sandbox.name))?.size ? { size: claims.get(workspaceClaimName(sandbox.name))!.size } : {}),
      ...(oom ? { oom: { count: oom.count, lastAt: new Date(oom.lastAt).toISOString(), ...(oom.limit ? { limit: oom.limit } : {}), ...(oom.peakBytes ? { peakMi: Math.round(oom.peakBytes / 2 ** 20) } : {}) } } : {}),
      agents: agentsIn(input.agents ?? [], sandbox.annotations[CWD_ANNOTATION]),
    });
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title));
}

/** Reads the cluster for the table. */
export async function readPodRows(
  kube: Kube,
  daemonId: string | undefined,
  entries: readonly PodEntry[],
  titles: ReadonlyMap<string, string> | null,
  agents: readonly AgentSummary[] | null,
  oom?: ReadonlyMap<string, OomEntry>,
): Promise<PodRow[]> {
  if (!daemonId) return [];
  const sandboxes = await kube.listSandboxes(`${DAEMON_LABEL}=${daemonId}`);
  const claims = await kube.listClaims(`${DAEMON_LABEL}=${daemonId}`);
  const pods = new Map<string, PodInfo | null>();
  await Promise.all(sandboxes.map(async (s) => pods.set(s.name, await kube.podInfo(s.name).catch(() => null))));
  return buildPodRows({ sandboxes, claims, pods, entries, titles, agents, oom });
}
