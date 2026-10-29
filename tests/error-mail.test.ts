import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentsMailSender, ErrorMailer, errorMailText, isImagePull } from "../server/error-mail.js";

describe("error mails", () => {
  it("dedupes per agent and reason within the window, persists it, and mails again after it", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "em-")), "error-mail.json");
    const sent: string[] = [];
    const send = async (_to: string, subject: string) => (sent.push(subject), true);
    const m = new ErrorMailer(file, send, () => undefined);
    const e = { agentId: "agent-123456789", workspaceId: "wks_1", reason: "oom" as const, detail: "limit 3Gi" };
    const o = { to: "@assistant", windowMs: 30 * 60_000 };
    expect(await m.notify(e, { ...o, now: 0 })).toBe(true);
    expect(await m.notify(e, { ...o, now: 60_000 })).toBe(false);
    expect(await m.notify({ ...e, reason: "pod-start" }, { ...o, now: 60_000 })).toBe(true); // another reason
    expect(await new ErrorMailer(file, send, () => undefined).notify(e, { ...o, now: 120_000 })).toBe(false); // survives a restart
    expect(await m.notify(e, { ...o, now: 31 * 60_000 })).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it("logs a mail Agents Mail did not take", async () => {
    const logs: string[] = [];
    const m = new ErrorMailer(null, async () => false, (l) => void logs.push(l));
    await m.notify({ agentId: "-", workspaceId: "wks_2", reason: "image-pull", detail: "ErrImagePull" }, { to: "@assistant", windowMs: 1000, now: 0 });
    expect(logs[0]).toMatch(/not sent .*workspace wks_2 pod could not pull its image/);
  });

  it("names the agent, workspace, reason and last log lines", () => {
    const { subject, body } = errorMailText({ agentId: "abcdef1234", workspaceId: "wks_9", pod: "pka-x", reason: "resume-stopped", detail: "interrupted again right after 2 resumes", logs: "a\nb" });
    expect(subject).toBe("Kubernetes Runtime: agent abcdef12 automatic resume stopped");
    expect(body).toContain("Workspace: wks_9 (pod pka-x)");
    expect(body).toContain("Last log lines:\na\nb");
    expect(isImagePull("Back-off pulling image: ErrImagePull")).toBe(true);
    expect(isImagePull("not ready after 120s")).toBe(false);
  });

  it("posts to the Agents Mail endpoint as the Kubernetes Runtime", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "em-")), "endpoint.json");
    writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:1/", token: "t" }));
    const calls: { url: string; body: string }[] = [];
    const send = agentsMailSender(() => file, (async (url: string, init: { body: string }) => (calls.push({ url, body: init.body }), { ok: true })) as never);
    expect(await send("@assistant", "s", "b")).toBe(true);
    expect(calls[0]!.url).toBe("http://127.0.0.1:1/api/mails");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ to: "@assistant", kind: "error", asAgent: { agentId: "kubernetes-runtime" } });
    expect(await agentsMailSender(() => path.join(path.dirname(file), "missing.json"))("@a", "s", "b")).toBe(false);
  });
});
