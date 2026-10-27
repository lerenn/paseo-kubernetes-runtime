import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface OomEntry {
  count: number;
  /** Epoch ms of the last OOM kill. */
  lastAt: number;
  /** The container's memory limit when it was read (e.g. 3Gi). */
  limit?: string;
  /** Peak memory of the container in bytes since it started, when readable. */
  peakBytes?: number;
  /** Kills by agent (the agents that had a turn open). */
  agents: Record<string, { count: number; lastAt: number }>;
}

interface OomState {
  workspaces: Record<string, OomEntry>;
  /** Epoch ms of the last daily summary; kills after it are the next summary's. */
  summarizedAt: number;
  /** Kills since `summarizedAt`, by workspace. */
  pending: Record<string, number>;
}

export const SUMMARY_EVERY_MS = 24 * 3_600_000;

/** Counts OOM kills per workspace and agent, persisted like the resume guard so a restart keeps them. */
export class OomLedger {
  private state: OomState;

  constructor(private readonly file: string | null, now: number) {
    this.state = this.load(now);
  }

  private load(now: number): OomState {
    try {
      if (this.file) {
        const s = JSON.parse(readFileSync(this.file, "utf8")) as Partial<OomState>;
        return { workspaces: s.workspaces ?? {}, summarizedAt: s.summarizedAt ?? now, pending: s.pending ?? {} };
      }
    } catch {
      // none yet
    }
    return { workspaces: {}, summarizedAt: now, pending: {} };
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(this.state));
      renameSync(temp, this.file);
    } catch {
      // still counted in memory
    }
  }

  record(workspaceId: string, agentIds: readonly string[], at: number, facts: { limit?: string; peakBytes?: number } = {}): OomEntry {
    const e = (this.state.workspaces[workspaceId] ??= { count: 0, lastAt: at, agents: {} });
    e.count += 1;
    e.lastAt = at;
    if (facts.limit) e.limit = facts.limit;
    if (facts.peakBytes !== undefined) e.peakBytes = facts.peakBytes;
    for (const id of agentIds) {
      const a = (e.agents[id] ??= { count: 0, lastAt: at });
      a.count += 1;
      a.lastAt = at;
    }
    this.state.pending[workspaceId] = (this.state.pending[workspaceId] ?? 0) + 1;
    this.save();
    return e;
  }

  get(workspaceId: string): OomEntry | undefined {
    return this.state.workspaces[workspaceId];
  }

  all(): ReadonlyMap<string, OomEntry> {
    return new Map(Object.entries(this.state.workspaces));
  }

  /** The daily summary line when a day has passed since the last one and there were kills; null (and the day restarts) otherwise. */
  dueSummary(now: number): string | null {
    if (now - this.state.summarizedAt < SUMMARY_EVERY_MS) return null;
    const lines = Object.entries(this.state.pending).map(([ws, n]) => {
      const e = this.state.workspaces[ws];
      return `${ws}: ${n}${e?.limit ? ` (limit ${e.limit})` : ""}`;
    });
    this.state.summarizedAt = now;
    this.state.pending = {};
    this.save();
    return lines.length ? `${lines.length} workspace(s) hit OOM in the last day: ${lines.join("; ")}` : null;
  }
}

export const oomResumePrompt =
  "Your pod ran out of memory and your process was killed. Resume from your saved state (git and files on the volume): check what is committed and what is not, and carry on. " +
  "Commit and push more often, so a kill costs little. If the work needs more memory, say so: a bigger pod profile (e.g. `builder`) exists for heavy builds.";

/** Bytes of a cgroup `memory.peak` reading, or undefined. */
export function parsePeak(output: string): number | undefined {
  const n = Number(output.trim().split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
