import { describe, expect, it } from "vitest";
import { KubernetesRuntime } from "../server/runtime.js";
import { PodRegistry } from "../server/registry.js";
import { ConfigSchema, projectProfileFor } from "../shared/settings.js";
import { FakeKube, fakeSeeder } from "./fakes.js";

const PROJECT = "/home/paseo/src/github.com/lerenn/paseo";
const WORKTREE = "/home/paseo/.paseo/worktrees/abc123/fix-it";

describe("projectProfileFor", () => {
  const map = { [PROJECT]: "builder", "/home/paseo/src/github.com/anyshift-io": "small", "/home/paseo/src/github.com/anyshift-io/big": "builder" };
  it("matches the exact path, a directory below a listed one, and the longest entry", () => {
    expect(projectProfileFor(map, PROJECT)).toBe("builder");
    expect(projectProfileFor(map, `${PROJECT}/packages/x`)).toBe("builder");
    expect(projectProfileFor(map, "/home/paseo/src/github.com/anyshift-io/other")).toBe("small");
    expect(projectProfileFor(map, "/home/paseo/src/github.com/anyshift-io/big")).toBe("builder");
  });
  it("does not match a sibling that only shares the text prefix", () => {
    expect(projectProfileFor(map, `${PROJECT}-fork`)).toBeUndefined();
    expect(projectProfileFor({ [`${PROJECT}/`]: "builder" }, PROJECT)).toBe("builder");
  });
});

function setup(settings: object, git?: (args: string[], o?: { cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>) {
  const kube = new FakeKube();
  const logs: string[] = [];
  const runtime = new KubernetesRuntime({
    getConfig: async () => ConfigSchema.parse({ readyTimeoutSeconds: 1, image: "default:1", ...settings }),
    kubeFor: () => kube,
    daemonId: "srv_ME",
    registry: new PodRegistry(),
    seeder: fakeSeeder,
    detectRepo: async () => ({ url: "https://github.com/lerenn/x.git", branch: "main" }),
    git: (git ?? (async () => ({ code: 1, stdout: "", stderr: "" }))) as never,
    sleep: async () => undefined,
    ticker: () => () => undefined,
    log: (l: string) => void logs.push(l),
  });
  const ctx = { notice: () => undefined, signal: new AbortController().signal };
  const prepare = (cwd: string, profile?: string) =>
    runtime.registration().prepare!({ workspaceId: "wks_1", options: { cwd, slug: "ws", ref: null, ...(profile ? { profile } : {}) }, purpose: "session", argv: ["claude"], env: { PASEO_AGENT_ID: "a1" } } as never, ctx);
  const image = () => JSON.stringify(kube.applied);
  return { runtime, ctx, prepare, image, logs };
}

const settings = { profiles: { builder: { image: "builder:1" }, other: { image: "other:1" } }, projectProfiles: { [PROJECT]: "builder" } };

describe("projectProfiles", () => {
  it("gives a listed project's workspace the profile", async () => {
    const t = setup(settings);
    await t.prepare(PROJECT);
    expect(t.image()).toContain("builder:1");
  });

  it("leaves an unlisted project on the default pod", async () => {
    const t = setup(settings);
    await t.prepare("/home/paseo/src/github.com/lerenn/other");
    expect(t.image()).toContain("default:1");
    expect(t.image()).not.toContain("builder:1");
  });

  it("lets an explicit profile win", async () => {
    const t = setup(settings);
    await t.prepare(PROJECT, "other");
    expect(t.image()).toContain("other:1");
    expect(t.image()).not.toContain("builder:1");
  });

  it("finds the project of a Paseo worktree through its repository", async () => {
    const git = async (args: string[], o?: { cwd?: string }) =>
      args.includes("--git-common-dir") && o?.cwd === WORKTREE ? { code: 0, stdout: `${PROJECT}/.git\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    const t = setup(settings, git);
    await t.prepare(WORKTREE);
    expect(t.image()).toContain("builder:1");
  });

  it("keeps a worktree whose repository cannot be found on the default pod", async () => {
    const t = setup(settings);
    await t.prepare(WORKTREE);
    expect(t.image()).toContain("default:1");
  });

  it("does not take the profile of a caller's options that a worktree workspace inherited, on any call", async () => {
    const git = async (args: string[], o?: { cwd?: string }) =>
      args.includes("--git-common-dir") && o?.cwd === WORKTREE ? { code: 0, stdout: `${PROJECT}/.git\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    const t = setup(settings, git);
    const reg = t.runtime.registration();
    const inherited = { cwd: "/home/paseo/src/github.com/anyshift-io/lab", slug: "caller", ref: null, title: "Caller", profile: "other" };
    await reg.create!({ workspaceId: "wks_1", options: inherited, cwd: WORKTREE } as never, t.ctx);
    await reg.prepare!({ workspaceId: "wks_1", options: inherited, workspaceCwd: WORKTREE, purpose: "session", argv: ["claude"], env: { PASEO_AGENT_ID: "a1" } } as never, t.ctx);
    expect(t.image()).toContain("builder:1");
    expect(t.image()).not.toContain("other:1");
  });

  it("does not take an inherited profile after a reconcile either", async () => {
    const git = async (args: string[], o?: { cwd?: string }) =>
      args.includes("--git-common-dir") && o?.cwd === WORKTREE ? { code: 0, stdout: `${PROJECT}/.git\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    const t = setup(settings, git);
    const reg = t.runtime.registration();
    const inherited = { cwd: "/home/paseo/src/github.com/anyshift-io/lab", slug: "caller", ref: null, profile: "other" };
    await reg.reconcile!({ workspaces: [{ workspaceId: "wks_1", options: inherited, cwd: WORKTREE }] } as never, t.ctx);
    await reg.prepare!({ workspaceId: "wks_1", options: inherited, workspaceCwd: WORKTREE, purpose: "session", argv: ["claude"], env: { PASEO_AGENT_ID: "a1" } } as never, t.ctx);
    expect(t.image()).toContain("builder:1");
    expect(t.image()).not.toContain("other:1");
  });

  it("keeps the workspace's own explicit profile on later calls", async () => {
    const t = setup(settings);
    const reg = t.runtime.registration();
    const own = { cwd: PROJECT, slug: "ws", ref: null, profile: "other" };
    await reg.create!({ workspaceId: "wks_1", options: own, cwd: PROJECT } as never, t.ctx);
    await reg.prepare!({ workspaceId: "wks_1", options: own, workspaceCwd: PROJECT, purpose: "session", argv: ["claude"], env: { PASEO_AGENT_ID: "a1" } } as never, t.ctx);
    expect(t.image()).toContain("other:1");
  });

  it("falls back to no profile, with a log line, when the listed profile is not defined", async () => {
    const t = setup({ ...settings, projectProfiles: { [PROJECT]: "missing" } });
    await t.prepare(PROJECT);
    expect(t.image()).toContain("default:1");
    expect(t.logs.some((l) => l.includes('"missing"'))).toBe(true);
  });
});
