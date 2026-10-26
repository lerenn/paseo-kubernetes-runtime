import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PodInfo } from "./kube.js";

export type StopKind = "interrupted" | "failed";

export interface Stop {
  kind: StopKind;
  /** For people: why the pod is thought to be taken away or why it was not. */
  why: string;
}

/**
 * Tells apart a process that ended because the platform took its pod away (a Spot reclaim, a node loss, an eviction)
 * from one that failed on its own, once it is known that the plugin did not end it. `info` is the pod now, `knownUid`
 * the pod the process ran in. A pod that is gone, replaced, being deleted, disrupted or not ready means interrupted;
 * a healthy pod means the process itself died (an out-of-memory kill is said so).
 */
export function classifyStop(info: PodInfo | null, knownUid: string | undefined): Stop {
  if (!info) return { kind: "interrupted", why: "the pod is gone" };
  if (knownUid && info.uid && info.uid !== knownUid) return { kind: "interrupted", why: "the pod was replaced" };
  if (info.disrupted) return { kind: "interrupted", why: `the pod is being disrupted (${info.disrupted})` };
  if (info.terminating) return { kind: "interrupted", why: "the pod is being deleted" };
  if (!info.ready) return { kind: "interrupted", why: info.problem ?? "the pod is not ready" };
  if (info.oomKilled) return { kind: "failed", why: "the process ran out of memory" };
  return { kind: "failed", why: "the pod is healthy" };
}

export const RESUME_MIN_GAP_MS = 10 * 60_000;
export const RESUME_PER_HOUR = 3;
export const FAILED_RESUME_WINDOW_MS = 2 * 60_000;
export const MAX_FAILED_RESUMES = 2;

interface AgentRecord {
  /** When resume prompts were sent (epoch ms), the last hour's. */
  resumes: number[];
  /** Interruptions that came within FAILED_RESUME_WINDOW_MS of a resume, without a turn completing in between. */
  failures: number;
}

/**
 * Keeps the automatic resume from looping. One prompt per interruption is the caller's rule; this adds: at least ten
 * minutes between two resumes of an agent, three an hour, and a stop after two interruptions that came right after a
 * resume (the agent cannot get through, so someone should look). A completed turn clears the failures. Persisted, so
 * a restarted plugin does not start over.
 */
export class ResumeGuard {
  private readonly agents: Record<string, AgentRecord>;

  constructor(private readonly file: string | null) {
    this.agents = this.load();
  }

  private load(): Record<string, AgentRecord> {
    if (!this.file) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(this.agents));
      renameSync(temp, this.file);
    } catch {
      // the guard still works in memory
    }
  }

  private record(id: string): AgentRecord {
    return (this.agents[id] ??= { resumes: [], failures: 0 });
  }

  /** Call when an agent's turn was cut by an interruption. Returns whether a resume may be sent, and why not. */
  allow(agentId: string, now: number): { ok: true } | { ok: false; reason: string } {
    const r = this.record(agentId);
    r.resumes = r.resumes.filter((t) => now - t < 3_600_000);
    const last = r.resumes[r.resumes.length - 1];
    if (last !== undefined && now - last < FAILED_RESUME_WINDOW_MS) r.failures += 1;
    this.save();
    if (r.failures >= MAX_FAILED_RESUMES) return { ok: false, reason: `interrupted again right after ${r.failures} resumes: not trying again` };
    if (last !== undefined && now - last < RESUME_MIN_GAP_MS) return { ok: false, reason: "resumed less than 10 minutes ago" };
    if (r.resumes.length >= RESUME_PER_HOUR) return { ok: false, reason: `resumed ${RESUME_PER_HOUR} times in the last hour` };
    return { ok: true };
  }

  sent(agentId: string, now: number): void {
    this.record(agentId).resumes.push(now);
    this.save();
  }

  /** A turn of the agent completed: whatever went wrong before, it can work. */
  healthy(agentId: string): void {
    const r = this.agents[agentId];
    if (r && r.failures) {
      r.failures = 0;
      this.save();
    }
  }
}

export const resumePrompt = (at: Date) =>
  `Your previous turn was interrupted by a node reclaim at ${at.toISOString().slice(11, 16)}Z. Resume from your saved state (git and files on the volume): check what is committed and what is not, and carry on.`;

export const checkpointPrompt =
  "A node reclaim is under way: commit and push your work now (a WIP commit is fine). You may be stopped within about two minutes.";
