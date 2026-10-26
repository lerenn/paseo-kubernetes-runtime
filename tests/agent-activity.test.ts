import { describe, expect, it } from "vitest";
import { labelsOfAgent, workspaceAgentsBusy } from "../server/agent-activity.js";

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
    const list = api([agent({ id: "a1", labels: { "paseo.ops": "1" } }), agent({ id: "a2", labels: { x: "y" } })]);
    expect(await labelsOfAgent(list, "a1")).toEqual({ "paseo.ops": "1" });
    expect(await labelsOfAgent(list, "nope")).toBeUndefined();
    expect(await labelsOfAgent(null, "a1")).toBeUndefined();
    expect(await labelsOfAgent(api(new Error("gone")), "a1")).toBeUndefined();
  });
});
