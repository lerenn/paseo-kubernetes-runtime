import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KubernetesRuntimeConfig } from "./config.js";
import type { Kube } from "./kube.js";
import { sweepDockerOrphans } from "./docker-sandbox.js";
import { AGENT_LABEL, DAEMON_LABEL, MANAGED_BY, MANAGED_BY_LABEL, WORKSPACE_ID_LABEL, WORKSPACE_LABEL, workspaceClaimName } from "./sandbox.js";

const execFileAsync = promisify(execFile);

export type AgentState = "alive" | "gone" | "unknown";

type Exec = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr?: string }>;

function errorCode(text: string | undefined): string | undefined {
  try {
    return (JSON.parse(text ?? "") as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

/**
 * Asks Paseo whether an agent still exists and is not archived. The CLI prints its JSON error to stderr
 * and exits non-zero when the agent is not found; anything but a clear answer is "unknown".
 */
export async function paseoAgentState(agentId: string, exec: Exec = execFileAsync as unknown as Exec): Promise<AgentState> {
  try {
    const { stdout } = await exec("paseo", ["agent", "inspect", agentId, "--json"], { timeout: 20_000 });
    const parsed = JSON.parse(stdout) as { Archived?: boolean; error?: { code?: string } };
    if (parsed.error) return parsed.error.code === "AGENT_NOT_FOUND" ? "gone" : "unknown";
    return parsed.Archived === true ? "gone" : "alive";
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    const code = errorCode(failed.stderr) ?? errorCode(failed.stdout);
    return code === "AGENT_NOT_FOUND" ? "gone" : "unknown";
  }
}

/**
 * The workspaces Paseo still has (active and background) with their names, or null when that cannot be read, in
 * which case nothing is deleted on a workspace's account.
 */
export async function paseoWorkspaces(exec: Exec = execFileAsync as unknown as Exec): Promise<Map<string, string> | null> {
  const found = new Map<string, string>();
  try {
    for (const extra of [[], ["--background"]]) {
      const { stdout } = await exec("paseo", ["workspace", "ls", "--json", ...extra], { timeout: 20_000 });
      const list = JSON.parse(stdout) as { workspaceId?: string; name?: string }[];
      if (!Array.isArray(list)) return null;
      for (const entry of list) if (entry.workspaceId) found.set(entry.workspaceId, entry.name ?? "");
    }
    // an empty answer is not trusted: deleting every workspace's pod because a listing came back empty would be a disaster
    return found.size > 0 ? found : null;
  } catch {
    return null;
  }
}

export const paseoWorkspaceIds = async (exec?: Exec): Promise<Set<string> | null> => {
  const found = await paseoWorkspaces(exec);
  return found && new Set(found.keys());
};

/**
 * Whether Paseo has an agent in `running` state in this workspace directory (including its subdirectories), from
 * `paseo agent ls`. Null when the answer cannot be had, which callers treat as "busy".
 */
export async function paseoWorkspaceBusy(cwd: string, exec: Exec = execFileAsync as unknown as Exec): Promise<boolean | null> {
  try {
    const { stdout } = await exec("paseo", ["agent", "ls", "--json", "--global", "--background"], { timeout: 20_000 });
    const agents = JSON.parse(stdout) as { status?: string; cwd?: string }[];
    if (!Array.isArray(agents)) return null;
    const root = cwd.replace(/\/+$/, "");
    return agents.some((a) => a.status === "running" && typeof a.cwd === "string" && (a.cwd === root || a.cwd.startsWith(`${root}/`)));
  } catch {
    return null;
  }
}

export interface ReapStatus {
  /** ISO time of the last run. */
  lastRunAt?: string;
  /** Orphans deleted by the last run. */
  removed: number;
  /** Total deleted since the plugin started. */
  removedTotal: number;
  /** Plugin-looking resources with no daemon label: reported, never deleted. */
  unlabelled: string[];
  error?: string;
}

export interface ReaperDeps {
  getConfig(): Promise<KubernetesRuntimeConfig>;
  kubeFor(config: KubernetesRuntimeConfig): Kube;
  /** This daemon's id; without one the reaper does nothing. */
  daemonId?: string;
  agentState?: (agentId: string) => Promise<AgentState>;
  now?: () => number;
  /** Resources younger than this are left alone: the agent may not be registered yet. */
  graceMs?: number;
  /** Unlabelled leftovers get a longer grace period (default 15 minutes). */
  unlabelledGraceMs?: number;
  /** The workspaces Paseo still has; null when unknown. */
  workspaceIds?: () => Promise<Set<string> | null>;
  /** The same with names, to keep pod labels current after a rename; takes precedence over `workspaceIds`. */
  workspaces?: () => Promise<Map<string, string> | null>;
  /** Told the workspaces' current names after each run. */
  onNames?: (names: Map<string, string>) => Promise<void>;
  /** Sandboxes this plugin is running right now, never swept. */
  activeSandboxes?: () => Set<string>;
  log?: (line: string) => void;
}

const created = (iso?: string) => (iso ? Date.parse(iso) : 0);

/**
 * Safety net for resources whose agent is gone (deleted, or archived while the plugin was stopped). It
 * only considers Sandboxes and claims labelled with THIS daemon's id and an agent id; anything labelled
 * for another daemon is never listed, and anything without a daemon label is reported, not deleted.
 */
export class OrphanReaper {
  private status: ReapStatus = { removed: 0, removedTotal: 0, unlabelled: [] };
  private timer?: NodeJS.Timeout;
  private running?: Promise<ReapStatus>;

  constructor(private readonly deps: ReaperDeps) {}

  current(): ReapStatus {
    return this.status;
  }

  start(intervalMs = 10 * 60_000, firstRunDelayMs = 20_000): void {
    this.stop();
    const run = () => void this.run().catch(() => undefined);
    const first = setTimeout(run, firstRunDelayMs) as unknown as NodeJS.Timeout;
    first.unref?.();
    this.timer = setInterval(run, intervalMs) as unknown as NodeJS.Timeout;
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  run(): Promise<ReapStatus> {
    this.running ??= this.reap().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async reap(): Promise<ReapStatus> {
    const { daemonId } = this.deps;
    const now = this.deps.now ?? Date.now;
    const log = this.deps.log ?? ((line: string) => console.log(line));
    const agentState = this.deps.agentState ?? paseoAgentState;
    const grace = this.deps.graceMs ?? 5 * 60_000;
    if (!daemonId) return (this.status = { ...this.status, error: "daemon id unknown: orphan cleanup is off" });
    try {
      const config = await this.deps.getConfig();
      const kube = this.deps.kubeFor(config);
      let removed = 0;

      const mine = await kube.listSandboxes(`${DAEMON_LABEL}=${daemonId}`);
      const workspaceKey = (s: { labels: Record<string, string> }) =>
        s.labels[WORKSPACE_ID_LABEL] ?? (s.labels[WORKSPACE_LABEL]?.startsWith("wks_") ? s.labels[WORKSPACE_LABEL] : undefined);
      let names: Map<string, string> | null = null;
      let workspaces: Set<string> | null = null;
      if (mine.some(workspaceKey)) {
        if (this.deps.workspaces || !this.deps.workspaceIds) {
          names = await (this.deps.workspaces ?? paseoWorkspaces)();
          workspaces = names && new Set(names.keys());
        } else {
          workspaces = await this.deps.workspaceIds();
        }
      }
      const known = new Map<string, AgentState>();
      for (const sandbox of mine) {
        if (now() - created(sandbox.createdAt) < grace) continue;
        const workspace = workspaceKey(sandbox);
        const agent = sandbox.labels[AGENT_LABEL]; // sandboxes made by the earlier provider-based design
        let reason: string | undefined;
        if (workspace) {
          if (workspaces && !workspaces.has(workspace)) reason = `workspace ${workspace} is gone or archived`;
        } else if (agent) {
          if (!known.has(agent)) known.set(agent, await agentState(agent));
          if (known.get(agent) === "gone") reason = `agent ${agent} is gone or archived`;
        }
        if (!reason) continue;
        log(`[kubernetes-runtime] orphan cleanup: deleting sandbox ${sandbox.name} (${reason})`);
        await kube.delete("sandbox", sandbox.name);
        await kube.delete("pvc", workspaceClaimName(sandbox.name)).catch(() => undefined);
        removed++;
      }

      // A claim outlives its sandbox only if garbage collection lags; delete it when its sandbox is gone.
      const live = new Set((await kube.listSandboxes(`${DAEMON_LABEL}=${daemonId}`)).map((s) => s.name));
      for (const claim of await kube.listClaims(`${DAEMON_LABEL}=${daemonId}`)) {
        const owner = claim.name.replace(/^workspace-/, "");
        if (live.has(owner) || now() - created(claim.createdAt) < grace) continue;
        log(`[kubernetes-runtime] orphan cleanup: deleting volume claim ${claim.name} (its sandbox is gone)`);
        await kube.delete("pvc", claim.name);
        removed++;
      }

      // Ours by name, but without a daemon label (made before labelling existed).
      const unlabelledGrace = this.deps.unlabelledGraceMs ?? 15 * 60_000;
      const active = this.deps.activeSandboxes?.() ?? new Set<string>();
      const left: string[] = [];
      for (const sandbox of (await kube.listSandboxes(`${MANAGED_BY_LABEL}=${MANAGED_BY}`)).filter((s) => !s.labels[DAEMON_LABEL])) {
        const sweepable = config.sweepUnlabelled && sandbox.name.startsWith("pka-") && !active.has(sandbox.name) && now() - created(sandbox.createdAt) >= unlabelledGrace;
        if (!sweepable) {
          left.push(sandbox.name);
          continue;
        }
        log(`[kubernetes-runtime] orphan cleanup: deleting unlabelled sandbox ${sandbox.name} (it belongs to no workspace of this daemon)`);
        await kube.delete("sandbox", sandbox.name);
        await kube.delete("pvc", workspaceClaimName(sandbox.name)).catch(() => undefined);
        removed++;
      }
      if (config.sweepUnlabelled) {
        const sandboxNames = new Set((await kube.listSandboxes(`${MANAGED_BY_LABEL}=${MANAGED_BY}`)).map((s) => s.name));
        for (const claim of await kube.listClaims()) {
          if (claim.labels[DAEMON_LABEL] || !claim.name.startsWith("workspace-pka-")) continue;
          if (sandboxNames.has(claim.name.replace(/^workspace-/, "")) || now() - created(claim.createdAt) < unlabelledGrace) continue;
          log(`[kubernetes-runtime] orphan cleanup: deleting unlabelled volume claim ${claim.name} (its sandbox is gone)`);
          await kube.delete("pvc", claim.name);
          removed++;
        }
      }
      // Docker sandboxes (another namespace) whose workspace pod is gone. Not having that namespace, or the rights to it, is no error.
      try {
        removed += await sweepDockerOrphans(this.deps.kubeFor({ ...config, namespace: config.docker.namespace }), daemonId, live, now(), grace, log);
      } catch {
        // none to sweep
      }
      const unlabelled = left.sort();
      const unseen = unlabelled.filter((n) => !this.status.unlabelled.includes(n));
      if (unseen.length) log(`[kubernetes-runtime] orphan cleanup: ${unseen.length} sandbox(es) without a daemon label are left alone: ${unseen.join(", ")}`);

      if (names && this.deps.onNames) await this.deps.onNames(names).catch(() => undefined);
      this.status = {
        lastRunAt: new Date(now()).toISOString(),
        removed,
        removedTotal: this.status.removedTotal + removed,
        unlabelled,
      };
    } catch (error) {
      this.status = { ...this.status, lastRunAt: new Date(now()).toISOString(), error: (error as Error).message };
    }
    return this.status;
  }
}
