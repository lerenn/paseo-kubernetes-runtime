// Error mails (task 6abe295b): when an agent's pod fails (out-of-memory kill, a pod that cannot start or pull its image,
// or an eviction the automatic resume gave up on), one mail goes to the configured address through Agents Mail, with the
// agent, the workspace, the reason and the last log lines. One mail per agent and reason per window (30 min by default).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type ErrorReason = "oom" | "pod-start" | "image-pull" | "eviction" | "resume-stopped";

export interface ErrorEvent {
  /** The agent that failed; "-" when the failure is the workspace's (no agent had a turn open). */
  agentId: string;
  workspaceId: string;
  pod?: string;
  reason: ErrorReason;
  /** One line: what happened. */
  detail: string;
  /** The last log lines (stderr of the process, the pod's problem), already scrubbed of secrets. */
  logs?: string;
}

/** Sends one mail; false when Agents Mail is not there or refused it (the caller logs it). */
export type MailSender = (to: string, subject: string, body: string) => Promise<boolean>;

export const mailEndpointFile = () => process.env.RUNTIME_MAIL_ENDPOINT ?? path.join(process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"), "agents-mail", "endpoint.json");

/** Agents Mail over its local HTTP API (the endpoint file it writes), as the Kubernetes Runtime. */
export function agentsMailSender(file = mailEndpointFile, fetchImpl: typeof fetch = fetch): MailSender {
  return async (to, subject, body) => {
    let endpoint: { url?: string; token?: string };
    try {
      endpoint = JSON.parse(readFileSync(file(), "utf8"));
    } catch {
      return false;
    }
    if (!endpoint.url || !endpoint.token) return false;
    try {
      const res = await fetchImpl(`${endpoint.url.replace(/\/$/, "")}/api/mails`, {
        method: "POST",
        headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
        body: JSON.stringify({ to, subject: subject.slice(0, 200), body: body.slice(0, 16_000), kind: "error", asAgent: { agentId: "kubernetes-runtime", name: "Kubernetes Runtime" } }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
}

const LABEL: Record<ErrorReason, string> = {
  oom: "ran out of memory (exit 137)",
  "pod-start": "pod could not start",
  "image-pull": "pod could not pull its image",
  eviction: "pod was evicted or lost",
  "resume-stopped": "automatic resume stopped",
};

/** The subject and body of one error mail. Pure. */
export function errorMailText(e: ErrorEvent): { subject: string; body: string } {
  const who = e.agentId === "-" ? `workspace ${e.workspaceId}` : `agent ${e.agentId.slice(0, 8)}`;
  return {
    subject: `Kubernetes Runtime: ${who} ${LABEL[e.reason]}`,
    body: [
      `Agent: ${e.agentId === "-" ? "(none had a turn open)" : e.agentId}`,
      `Workspace: ${e.workspaceId}${e.pod ? ` (pod ${e.pod})` : ""}`,
      `Reason: ${LABEL[e.reason]}: ${e.detail}`,
      ...(e.logs?.trim() ? ["", "Last log lines:", ...e.logs.trim().split("\n").slice(-15)] : []),
    ].join("\n"),
  };
}

/** Image pull problems, as the pod's status or the start error names them. */
export const isImagePull = (text: string) => /ImagePull|ErrImage|pull (access|image)|manifest unknown/i.test(text);

/** Dedupes error mails per agent and reason (persisted, so a restart does not mail again) and sends them. */
export class ErrorMailer {
  private sent: Record<string, number>;

  constructor(
    private readonly file: string | null,
    private readonly send: MailSender,
    private readonly log: (line: string) => void,
  ) {
    this.sent = this.load();
  }

  private load(): Record<string, number> {
    if (!this.file) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(this.sent));
      renameSync(temp, this.file);
    } catch {
      // dedupe still works in memory
    }
  }

  /** Mails the event unless the same agent and reason were mailed within `windowMs`. Returns whether a mail went out. */
  async notify(e: ErrorEvent, o: { to: string; windowMs: number; now: number }): Promise<boolean> {
    const key = `${e.agentId === "-" ? e.workspaceId : e.agentId}:${e.reason}`;
    for (const [k, at] of Object.entries(this.sent)) if (o.now - at >= o.windowMs) delete this.sent[k];
    if (this.sent[key] !== undefined) return false;
    this.sent[key] = o.now;
    this.save();
    const { subject, body } = errorMailText(e);
    const ok = await this.send(o.to, subject, body).catch(() => false);
    if (!ok) this.log(`[kubernetes-runtime] error mail to ${o.to} not sent (Agents Mail unreachable): ${subject}`);
    return ok;
  }
}
