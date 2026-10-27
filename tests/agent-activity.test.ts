import { describe, expect, it } from "vitest";
import { labelsOfAgent, sendUnlessBusy, workspaceAgentsBusy } from "../server/agent-activity.js";

const api = (entries: unknown[] | Error) => ({ agents: { list: async () => (entries instanceof Error ? Promise.reject(entries) : { entries }) } });
const agent = (over: object) => ({ agent: { id: "a", workspaceId: "wks_1", status: "idle", activeTurn: null, pendingPermissions: [], archivedAt: null, ...over } });

describe("workspaceAgentsBusy", () => {
  it("is busy for an open turn (even when the status reads idle), a running status or a pending permission, in this workspace only", async () => {
    expect(await workspaceAgentsBusy(api([agent({ activeTurn: { turnId: "autonomous-1" } })]), "wks_1")).toBe(true);
    expect(await workspaceAgentsBusy(api([agent({ status: "running" })]), "wks_1")).toBe(true);
    expect(await workspaceAgentsBusy(api([agent({ pendingPermissions: [{}] })]), "wks_1")).toBe(true);
    expect(await workspaceAgentsBusy(api([agent({ status: "running", workspaceId: "wks_2" })]), "wks_1")).toBe(false);
  });

  it("is idle for idle, errored (a suspended agent) and archived agents, and does not know without the API or when the list fails", async () => {
    expect(await workspaceAgentsBusy(api([agent({}), agent({ status: "error" }), agent({ status: "running", archivedAt: "2026-10-26T00:00:00Z" })]), "wks_1")).toBe(false);
    expect(await workspaceAgentsBusy(null, "wks_1")).toBeNull();
    expect(await workspaceAgentsBusy(api(new Error("daemon gone")), "wks_1")).toBeNull();
  });
});

describe("labelsOfAgent", () => {
  it("reads the labels of one agent from the list's entries, and nothing when it is missing or unreadable", async () => {
    const list = api([agent({ id: "a1", labels: { "paseo.scoped-daemon-access": "1" } }), agent({ id: "a2", labels: { x: "y" } })]);
    expect(await labelsOfAgent(list, "a1")).toEqual({ "paseo.scoped-daemon-access": "1" });
    expect(await labelsOfAgent(list, "nope")).toBeUndefined();
    expect(await labelsOfAgent(null, "a1")).toBeUndefined();
    expect(await labelsOfAgent(api(new Error("gone")), "a1")).toBeUndefined();
  });
});

describe("sendUnlessBusy", () => {
  const host = (list: unknown[], send: (text: string, o: { activeTurnBehavior: string }) => Promise<unknown>) => ({
    agents: { list: async () => ({ entries: list }), ref: () => ({ send }) },
  });

  it("uses skip when the host has it, and reports a skipped (mid-turn) agent", async () => {
    const sent: string[] = [];
    expect(await sendUnlessBusy(host([], async (_t, o) => (sent.push(o.activeTurnBehavior), {})), "a", "go")).toBe("sent");
    expect(await sendUnlessBusy(host([], async () => ({ skipped: true })), "a", "go")).toBe("skipped");
    expect(sent).toEqual(["skip"]);
  });

  it("on a host without skip, sends to an idle agent and leaves a busy or unknown one alone", async () => {
    const calls: string[] = [];
    const old = (list: unknown[]) =>
      host(list, async (_t, o) => {
        calls.push(o.activeTurnBehavior);
        if (o.activeTurnBehavior === "skip") throw new Error("Update the Paseo host to use activeTurnBehavior skip");
        return {};
      });
    expect(await sendUnlessBusy(old([agent({ id: "a" })]), "a", "go")).toBe("sent");
    expect(calls).toEqual(["skip", "steer"]);
    calls.length = 0;
    expect(await sendUnlessBusy(old([agent({ id: "a", activeTurn: { turnId: "t" } })]), "a", "go")).toBe("skipped");
    expect(await sendUnlessBusy(old([]), "a", "go")).toBe("skipped"); // unknown: not sent
    expect(calls).toEqual(["skip", "skip"]);
  });

  it("passes other errors on", async () => {
    await expect(sendUnlessBusy(host([], async () => { throw new Error("agent not found"); }), "a", "go")).rejects.toThrow("agent not found");
    await expect(sendUnlessBusy(null, "a", "go")).rejects.toThrow(/not reached/);
  });
});
