import { describe, expect, it } from "vitest";
import { OrphanReaper, paseoAgentState, paseoWorkspaceBusy, paseoWorkspaceIds, type AgentState } from "../server/orphans.js";
import { buildSandbox, labelValue } from "../server/sandbox.js";
import { readDaemonId } from "../server/daemon.js";
import { ConfigSchema } from "../shared/settings.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeKube } from "./fakes.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-24T12:00:00Z");
const old = new Date(NOW - 60 * MIN).toISOString();
const fresh = new Date(NOW - 1 * MIN).toISOString();
const sandbox = (name: string, labels: Record<string, string>, createdAt = old) => ({ name, labels: { "app.kubernetes.io/managed-by": "paseo-kube-agents", ...labels }, annotations: {}, operatingMode: "Running" as const, createdAt });
const mine = { "paseo.sh/daemon": "srv_ME" };

function setup(workspaces: string[] | null, opts: { agents?: Record<string, AgentState>; daemonId?: string | null; sweep?: boolean; active?: string[] } = {}) {
  const kube = new FakeKube();
  const logs: string[] = [];
  const asked: string[] = [];
  const reaper = new OrphanReaper({
    getConfig: async () => ConfigSchema.parse({ sweepUnlabelled: opts.sweep ?? true }),
    kubeFor: () => kube,
    daemonId: opts.daemonId === null ? undefined : (opts.daemonId ?? "srv_ME"),
    workspaceIds: async () => (workspaces ? new Set(workspaces) : null),
    agentState: async (id) => (asked.push(id), opts.agents?.[id] ?? "unknown"),
    activeSandboxes: () => new Set(opts.active ?? []),
    now: () => NOW,
    log: (l) => logs.push(l),
  });
  return { kube, logs, asked, reaper };
}

describe("orphan reaper: workspaces", () => {
  it("goes by the workspace-id label, whatever the display label says, and reports names after each run", async () => {
    const kube = new FakeKube();
    let told: Map<string, string> | undefined;
    const reaper = new OrphanReaper({
      getConfig: async () => ConfigSchema.parse({}),
      kubeFor: () => kube,
      daemonId: "srv_ME",
      workspaces: async () => new Map([["wks_alive", "Renamed"]]),
      onNames: async (names) => void (told = names),
      now: () => NOW,
      log: () => undefined,
    });
    kube.sandboxes = [
      sandbox("sb-gone", { ...mine, "paseo.sh/workspace-id": "wks_gone", "paseo.sh/workspace": "Old-Name" }),
      sandbox("sb-alive", { ...mine, "paseo.sh/workspace-id": "wks_alive", "paseo.sh/workspace": "Old-Name" }),
    ];
    await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:sandbox"))).toEqual(["delete:sandbox/sb-gone"]);
    expect(told?.get("wks_alive")).toBe("Renamed");
  });

  it("deletes the sandbox and claim of a workspace Paseo no longer has, and logs it", async () => {
    const { kube, logs, reaper } = setup(["wks_alive"]);
    kube.sandboxes = [sandbox("sb-gone", { ...mine, "paseo.sh/workspace": "wks_gone" }), sandbox("sb-alive", { ...mine, "paseo.sh/workspace": "wks_alive" })];
    const status = await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toEqual(["delete:sandbox/sb-gone", "delete:pvc/workspace-sb-gone"]);
    expect(logs).toEqual([expect.stringContaining("deleting sandbox sb-gone (workspace wks_gone is gone or archived)")]);
    expect(status).toMatchObject({ removed: 1, removedTotal: 1, lastRunAt: new Date(NOW).toISOString() });
  });

  it("deletes nothing when the workspace list could not be read (unknown is not gone)", async () => {
    const { kube, reaper } = setup(null);
    kube.sandboxes = [sandbox("sb", { ...mine, "paseo.sh/workspace": "wks_x" })];
    await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
  });

  it("leaves alone young resources, other daemons' resources and unlabelled-for-workspace ones", async () => {
    const { kube, reaper } = setup(["wks_other"]);
    kube.sandboxes = [
      sandbox("young", { ...mine, "paseo.sh/workspace": "wks_young" }, fresh), // within the grace period
      sandbox("other-daemon", { "paseo.sh/daemon": "srv_OTHER", "paseo.sh/workspace": "wks_gone" }),
      sandbox("no-workspace", { ...mine }),
    ];
    await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
  });

  it("still cleans up sandboxes of the earlier provider-based design by their agent label", async () => {
    const { kube, asked, reaper } = setup(["wks_x"], { agents: { a1: "gone", a2: "alive", a3: "unknown" } });
    kube.sandboxes = [sandbox("legacy-gone", { ...mine, "paseo.sh/agent": "a1" }), sandbox("legacy-alive", { ...mine, "paseo.sh/agent": "a2" }), sandbox("legacy-unknown", { ...mine, "paseo.sh/agent": "a3" })];
    await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:sandbox/"))).toEqual(["delete:sandbox/legacy-gone"]);
    expect(asked.sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("deletes a volume claim whose sandbox is gone, but not one whose sandbox exists", async () => {
    const { kube, reaper } = setup(["wks_a"]);
    kube.sandboxes = [sandbox("sb-1", { ...mine, "paseo.sh/workspace": "wks_a" })];
    kube.claims = [
      { name: "workspace-sb-1", labels: mine, createdAt: old },
      { name: "workspace-sb-dead", labels: mine, createdAt: old },
      { name: "workspace-other", labels: { "paseo.sh/daemon": "srv_OTHER" }, createdAt: old },
    ];
    await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toEqual(["delete:pvc/workspace-sb-dead"]);
  });

  it("does nothing, and says so, without a daemon id", async () => {
    const { kube, reaper } = setup(["wks_x"], { daemonId: null });
    kube.sandboxes = [sandbox("sb", { ...mine, "paseo.sh/workspace": "wks_gone" })];
    expect((await reaper.run()).error).toMatch(/daemon id unknown/);
    expect(kube.calls).toEqual([]);
  });

  it("keeps its previous result and reports the error when the cluster cannot be read", async () => {
    const { kube, reaper } = setup(["wks_x"]);
    kube.listSandboxes = async () => {
      throw new Error("api down");
    };
    const status = await reaper.run();
    expect(status.error).toBe("api down");
    expect(status.removed).toBe(0);
  });

  it("runs once at a time", async () => {
    const { kube, reaper } = setup(["wks_x"]);
    let calls = 0;
    const original = kube.listSandboxes.bind(kube);
    kube.listSandboxes = async (s: string) => (calls++, original(s));
    await Promise.all([reaper.run(), reaper.run()]);
    expect(calls).toBeLessThanOrEqual(4); // one pass, not two
  });
});

describe("orphan reaper: unlabelled leftovers", () => {
  it("deletes old unlabelled pka- sandboxes and claims, logging each, but never what this plugin runs, young ones, or other names", async () => {
    const { kube, logs, reaper } = setup(["wks_x"], { active: ["pka-running"] });
    kube.sandboxes = [sandbox("pka-draft", {}), sandbox("pka-young", {}, fresh), sandbox("pka-running", {}), sandbox("not-ours", {}), sandbox("pka-other-daemon", { "paseo.sh/daemon": "srv_OTHER" })];
    kube.claims = [{ name: "workspace-pka-gone", labels: {}, createdAt: old }, { name: "workspace-unrelated", labels: {}, createdAt: old }];
    const status = await reaper.run();
    expect(kube.calls.filter((c) => c.startsWith("delete:sandbox/"))).toEqual(["delete:sandbox/pka-draft"]);
    expect(kube.calls).toContain("delete:pvc/workspace-pka-gone");
    expect(kube.calls).not.toContain("delete:pvc/workspace-unrelated");
    expect(logs.filter((l) => l.includes("deleting unlabelled sandbox"))).toHaveLength(1);
    expect(status.removed).toBe(2); // one sandbox and one claim without a sandbox
  });

  it("is off when the setting is off: it reports them and deletes nothing", async () => {
    const { kube, logs, reaper } = setup(["wks_x"], { sweep: false });
    kube.sandboxes = [sandbox("pka-draft", {})];
    const status = await reaper.run();
    expect(status.unlabelled).toEqual(["pka-draft"]);
    expect(logs[0]).toContain("left alone: pka-draft");
    expect(kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    await reaper.run();
    expect(logs).toHaveLength(1); // told once, not every ten minutes
  });
});

describe("workspaces Paseo has", () => {
  const out = (list: unknown[]) => async (_f: string, args: string[]) => ({ stdout: JSON.stringify(args.includes("--background") ? [] : list) });
  it("lists active and background workspaces", async () => {
    const calls: string[][] = [];
    const ids = await paseoWorkspaceIds(async (_f, args) => (calls.push(args), { stdout: JSON.stringify(args.includes("--background") ? [{ workspaceId: "wks_bg" }] : [{ workspaceId: "wks_a" }]) }));
    expect(ids).toEqual(new Set(["wks_a", "wks_bg"]));
    expect(calls).toHaveLength(2);
  });
  it("is null, never empty, when it cannot be trusted: nothing listed, garbage, or a failure", async () => {
    expect(await paseoWorkspaceIds(out([]))).toBeNull();
    expect(await paseoWorkspaceIds(async () => ({ stdout: "nope" }))).toBeNull();
    expect(await paseoWorkspaceIds(async () => { throw new Error("daemon down"); })).toBeNull();
  });
});

describe("labels", () => {
  const config = ConfigSchema.parse({});
  it("labels the sandbox and its volume claim with the daemon and the workspace", () => {
    const sb = buildSandbox({ name: "n", workspaceId: "wks_1", cwd: "/p", config, daemonId: "srv_ME" }) as any;
    expect(sb.metadata.labels).toMatchObject({ "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": "wks_1" });
    expect(sb.spec.volumeClaimTemplates[0].metadata.labels).toEqual({ "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": "wks_1" });
    expect(sb.spec.podTemplate.metadata.labels).not.toHaveProperty("paseo.sh/daemon"); // the pod only carries the NetworkPolicy label
  });

  it("labels the sandbox, pod and claim with the workspace name, agent, repo and state for people", () => {
    const meta = { workspaceName: "My Repo: fix the login (v2)!", repo: "my-repo", repoUrl: "https://user:tok@github.com/o/my-repo.git", agent: "0c0f7a18", state: "running" as const };
    const sb = buildSandbox({ name: "pka-n", workspaceId: "wks_1", cwd: "/p", config, daemonId: "srv_ME", meta }) as any;
    const shown = { "paseo.sh/workspace": "My-Repo-fix-the-login-v2", "paseo.sh/agent": "0c0f7a18", "paseo.sh/repo": "my-repo", "paseo.sh/state": "running" };
    expect(sb.metadata.labels).toMatchObject(shown);
    expect(sb.spec.podTemplate.metadata.labels).toMatchObject(shown);
    expect(sb.spec.volumeClaimTemplates[0].metadata.labels).toMatchObject(shown);
    expect(sb.metadata.annotations["paseo.sh/workspace-name"]).toBe("My Repo: fix the login (v2)!"); // the full name lives in an annotation
    expect(sb.metadata.annotations["paseo.sh/repo-url"]).toBe("https://github.com/o/my-repo.git"); // credentials never end up on the object
    expect(sb.metadata.name).not.toContain("warm");
    const long = (buildSandbox({ name: "n", workspaceId: "w", cwd: "/p", config, meta: { ...meta, workspaceName: "x".repeat(200) + "-" } }) as any).metadata.labels["paseo.sh/workspace"];
    expect(long).toHaveLength(63);
    expect(labelValue("--")).toBeUndefined();
    expect(labelValue("a b")).toBe("a-b");
  });

  it("reads the daemon id from Paseo's home", () => {
    const home = mkdtempSync(join(tmpdir(), "kube-home-"));
    expect(readDaemonId(home)).toBeUndefined();
    writeFileSync(join(home, "server-id"), "srv_ABC123\n");
    expect(readDaemonId(home)).toBe("srv_ABC123");
    writeFileSync(join(home, "server-id"), "not a valid label value!!");
    expect(readDaemonId(home)).toBeUndefined();
  });
});

describe("asking Paseo about an agent", () => {
  const ok = (body: object) => async () => ({ stdout: JSON.stringify(body) });
  const fail = (streams: { stdout?: string; stderr?: string }) => async () => {
    throw Object.assign(new Error("exit 1"), streams);
  };
  const notFound = JSON.stringify({ error: { code: "AGENT_NOT_FOUND", message: "Agent not found: x" } });

  it("alive when found and not archived, gone when archived", async () => {
    expect(await paseoAgentState("a", ok({ Id: "a", Archived: false }))).toBe("alive");
    expect(await paseoAgentState("a", ok({ Id: "a", Archived: true }))).toBe("gone");
  });

  it("gone when Paseo says AGENT_NOT_FOUND, on stderr (what the CLI really does) or stdout", async () => {
    expect(await paseoAgentState("a", fail({ stderr: notFound }))).toBe("gone");
    expect(await paseoAgentState("a", fail({ stdout: notFound }))).toBe("gone");
    expect(await paseoAgentState("a", ok(JSON.parse(notFound)))).toBe("gone");
  });

  it("unknown, never gone, for anything else: daemon unreachable, a crash, garbage, a missing binary", async () => {
    const unreachable = JSON.stringify({ error: { code: "DAEMON_UNREACHABLE" } });
    expect(await paseoAgentState("a", fail({ stderr: unreachable }))).toBe("unknown");
    expect(await paseoAgentState("a", fail({ stderr: "boom" }))).toBe("unknown");
    expect(await paseoAgentState("a", async () => ({ stdout: "not json" }))).toBe("unknown");
    expect(await paseoAgentState("a", async () => { throw new Error("spawn paseo ENOENT"); })).toBe("unknown");
  });
});

describe("asking Paseo whether a workspace has a running agent", () => {
  const list = (agents: object[]) => async () => ({ stdout: JSON.stringify(agents) });
  it("is true for a running agent in the directory or below it, false otherwise, null when unknown", async () => {
    const agents = [{ status: "running", cwd: "/w/a/sub" }, { status: "idle", cwd: "/w/b" }, { status: "running", cwd: "/w/ab" }];
    expect(await paseoWorkspaceBusy("/w/a", list(agents))).toBe(true);
    expect(await paseoWorkspaceBusy("/w/b", list(agents))).toBe(false);
    expect(await paseoWorkspaceBusy("/w/a/", list([{ status: "running", cwd: "/w/a" }]))).toBe(true);
    expect(await paseoWorkspaceBusy("/w/a", async () => { throw new Error("daemon down"); })).toBeNull();
    expect(await paseoWorkspaceBusy("/w/a", async () => ({ stdout: "nope" }))).toBeNull();
  });
});
