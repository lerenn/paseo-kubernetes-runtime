import { describe, expect, it } from "vitest";
import { podOnlyAgent, podOnlyWorkspace, type WorkspaceCreateLike } from "../server/pod-only.js";
import { ConfigSchema } from "../shared/settings.js";

const on = ConfigSchema.parse({ podOnly: { enabled: true } }).podOnly;
const off = ConfigSchema.parse({}).podOnly;
const dir: WorkspaceCreateLike = { source: { kind: "directory", path: "/home/me/repo" }, title: "Fix it" };
const tree: WorkspaceCreateLike = { source: { kind: "worktree", cwd: "/home/me/repo", projectId: "p1", action: "branch-off", refName: "main", worktreeSlug: "brave-otter-12" } };

describe("podOnly defaults", () => {
  it("is off, with the assistant exempt", () => {
    expect(off.enabled).toBe(false);
    expect(off.exemptLabels).toEqual(["paseo.assistant=1"]);
    expect(podOnlyWorkspace(dir, off)).toBe(dir);
    expect(() => podOnlyAgent({ runtimeId: null }, off)).not.toThrow();
  });
});

describe("before workspace.create", () => {
  it("moves a Local workspace to a pod", () => {
    expect(podOnlyWorkspace(dir, on)).toMatchObject({ source: { kind: "directory", path: "/home/me/repo" }, runtime: { id: "kubernetes", options: { cwd: "/home/me/repo", title: "Fix it" } } });
  });

  it("moves a Worktree workspace to a pod on the same project, keeping the branch choice and slug", () => {
    const out = podOnlyWorkspace(tree, on);
    expect(out.source).toEqual({ kind: "directory", path: "/home/me/repo", projectId: "p1" });
    expect(out.runtime).toEqual({ id: "kubernetes", options: { cwd: "/home/me/repo", slug: "brave-otter-12", ref: { action: "branch-off", refName: "main" } } });
  });

  it("leaves pod workspaces, exempt agents and caller-created workspaces alone, and refuses other runtimes", () => {
    const pod = { ...dir, runtime: { id: "kubernetes", options: { cwd: "/x/y" } } };
    expect(podOnlyWorkspace(pod, on)).toBe(pod);
    const assistant = { ...dir, agent: { labels: { "paseo.assistant": "1" } } };
    expect(podOnlyWorkspace(assistant, on)).toBe(assistant);
    const fromAgent = { ...dir, callerAgentId: "ag_1" };
    expect(podOnlyWorkspace(fromAgent, on)).toBe(fromAgent);
    expect(() => podOnlyWorkspace({ ...dir, runtime: { id: "ssh" } }, on)).toThrow(/Only pod workspaces/);
    expect(podOnlyWorkspace({ ...dir, agent: { labels: { "paseo.assistant": "0" } } }, on).runtime?.id).toBe("kubernetes");
  });

  it("refuses instead when asked to, and a worktree without a project directory", () => {
    const refuse = { ...on, localWorkspaces: "refuse" as const };
    expect(() => podOnlyWorkspace(dir, refuse)).toThrow(/refused/);
    expect(() => podOnlyWorkspace({ source: { kind: "worktree" } }, on)).toThrow(/no project directory/);
  });
});

describe("before agent.create", () => {
  it("refuses agents and subagents in local workspaces, except exempt ones", () => {
    expect(() => podOnlyAgent({ runtimeId: null, labels: {}, parentAgentId: null }, on)).toThrow(/agent in a local workspace is refused/);
    expect(() => podOnlyAgent({ runtimeId: null, labels: {}, parentAgentId: "ag_p" }, on)).toThrow(/subagent of an agent in a local workspace/);
    expect(() => podOnlyAgent({ runtimeId: null, labels: { "paseo.assistant": "1" } }, on)).not.toThrow();
    expect(() => podOnlyAgent({ runtimeId: "kubernetes", labels: {}, parentAgentId: "ag_p" }, on)).not.toThrow();
  });
  it("does not restrict a daemon that does not say where the workspace runs", () => {
    expect(() => podOnlyAgent({ labels: {} }, on)).not.toThrow();
  });
});
