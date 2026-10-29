import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OomLedger, SUMMARY_EVERY_MS } from "../server/oom.js";
import { buildPodRows } from "../server/status.js";
import { KubernetesRuntime, liveProviderChildren, IDLE_BACKGROUND_GRACE_MS, specRejected } from "../server/runtime.js";
import { PodRegistry } from "../server/registry.js";
import type { WorkspaceRuntimeRegistration } from "../server/runtime-types.js";
import { ConfigSchema } from "../shared/settings.js";
import { FakeKube, fakeSeeder } from "./fakes.js";

const MIN = 60_000;
const CWD = "/home/me/repo";
const repo = async () => ({ url: "https://github.com/lerenn/x.git", branch: "main" });

function setup(settings: object = {}, extra: object = {}, kube = new FakeKube()) {
  const registry = new PodRegistry();
  const notices: [string, string | undefined][] = [];
  let clock = 1_000_000;
  const runtime = new KubernetesRuntime({
    getConfig: async () => ConfigSchema.parse({ readyTimeoutSeconds: 1, ...settings }),
    kubeFor: () => kube,
    daemonId: "srv_ME",
    registry,
    seeder: fakeSeeder,
    detectRepo: repo,
    git: async () => ({ code: 1, stdout: "", stderr: "" }),
    sleep: async () => undefined,
    now: () => clock++, // every read moves the clock a little, so a pod that never becomes ready times out
    ticker: () => () => undefined,
    log: () => undefined,
    workspaceBusy: async () => false,
    ...extra,
  });
  const reg: WorkspaceRuntimeRegistration = runtime.registration();
  const ctx = { notice: (m: string, l?: "info" | "warning" | "error") => void notices.push([m, l]), signal: new AbortController().signal };
  const options = { cwd: CWD, slug: "brave-otter-12", ref: null };
  const base = { workspaceId: "wks_1", options };
  const prepare = (over: object = {}) => reg.prepare!({ ...base, purpose: "session", argv: ["claude", "--print"], env: { PASEO_AGENT_ID: "a1" }, ...over } as never, ctx);
  return {
    kube, runtime, reg, registry, notices, ctx, base, options, prepare,
    advance: (ms: number) => void (clock += ms),
    tick: async () => { await runtime.checkIdle(); },
    activity: (activity: string, agentId = "a1") => reg.onActivity!({ ...base, agentId, activity } as never),
  };
}

describe("registration", () => {
  it("is the kubernetes runtime with pipes and no pty, and creating a workspace touches nothing in the cluster", async () => {
    const t = setup();
    expect(t.reg.id).toBe("kubernetes");
    expect(t.reg.label).toBe("Kubernetes Runtime");
    expect(await t.reg.describe()).toEqual({ protocolVersion: 1, capabilities: { pipes: true, pty: false } });
    await t.reg.create!(t.base, t.ctx);
    expect(t.kube.calls).toEqual([]);
  });

  it("rejects options it cannot use", async () => {
    const t = setup();
    await expect(t.reg.create!({ workspaceId: "w", options: { cwd: "relative" } }, t.ctx)).rejects.toThrow(/no usable Kubernetes runtime options/);
    await expect(t.reg.create!({ workspaceId: "w", options: { cwd: "/workspace" } }, t.ctx)).rejects.toThrow(/Pick a project directory/);
    await expect(t.reg.create!({ workspaceId: "w" }, t.ctx)).rejects.toThrow();
  });
});

describe("prepare: the pod is created when the first process is about to start", () => {
  it("creates a labelled sandbox that shows the checkout at the daemon's own path, then seeds it from a bundle", async () => {
    const t = setup();
    await t.prepare();
    const sandbox = t.kube.applied[0] as any;
    expect(sandbox.metadata.name).toMatch(/^pka-x-brave-otter-12-[0-9a-f]{6}$/);
    expect(sandbox.metadata.labels).toMatchObject({ "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": "wks_1", "paseo.sh/workspace": "brave-otter-12", "paseo.sh/repo": "x", "paseo.sh/state": "running" });
    expect(sandbox.metadata.annotations["paseo.sh/cwd"]).toBe(CWD);
    expect(sandbox.spec.volumeClaimTemplates[0].metadata.labels).toMatchObject({ "paseo.sh/workspace-id": "wks_1" });
    const mounts = sandbox.spec.podTemplate.spec.containers[0].volumeMounts;
    expect(mounts).toContainEqual({ name: "workspace", mountPath: "/workspace" });
    expect(mounts).toContainEqual({ name: "workspace", mountPath: CWD, subPath: "checkout" }); // same absolute path as on the daemon
    expect(sandbox.spec.podTemplate.spec.initContainers[0].name).toBe("volume-init"); // makes the subPath writable for the agent user
    expect(sandbox.spec.shutdownTime).toBeUndefined(); // storage goes only on archive
    const seed = t.kube.execs.find((e) => e.argv[2]?.includes("git init"))!;
    expect(seed.argv[4]).toBe(CWD); // seeded where the daemon's path is
    expect(t.notices.map((n) => n[0])).toEqual(expect.arrayContaining(["Starting the pod...", "Copying the project into the pod..."]));
    expect(t.registry.list()[0]).toMatchObject({ workspaceId: "wks_1", state: "running" });
  });

  it("does nothing the second time: the pod is already ready", async () => {
    const t = setup();
    await t.prepare();
    const before = t.kube.calls.length;
    await t.prepare();
    expect(t.kube.calls.slice(before).filter((c) => c !== "pod:" + t.registry.list()[0]!.sandbox)).toEqual([]);
    expect(t.kube.applied).toHaveLength(1);
  });

  it("serializes concurrent prepares into one pod", async () => {
    const t = setup();
    await Promise.all([t.prepare(), t.prepare(), t.prepare()]);
    expect(t.kube.applied).toHaveLength(1);
  });

  it("tunnels the loopback ports of the agent's MCP servers, and widens the tunnel when a later agent needs more", async () => {
    const t = setup();
    await t.prepare({ mcpServers: { inbox: { type: "http", url: "http://127.0.0.1:47825/mcp" }, remote: { type: "http", url: "https://example.com/mcp" } } });
    expect(t.kube.streams[0]!.argv.at(-1)).toBe("47825");
    await t.prepare({ mcpServers: { leases: { type: "http", url: "http://localhost:47826/mcp" } } });
    expect(t.kube.streams.at(-1)!.argv.at(-1)).toBe("47825,47826");
    expect(t.kube.streams).toHaveLength(2);
  });

  it("gives an ops agent the scoped paseo from Scoped Daemon Access, once per pod, and tunnels the endpoint's port", async () => {
    const asked: string[] = [];
    const t = setup({}, { fetch: async (url: string, init: { headers: Record<string, string> }) => (asked.push(`${url} ${init.headers.authorization}`), new Response("#!/usr/bin/env node\n")) });
    const env = { PASEO_AGENT_ID: "a1", PASEO_SCOPED_DAEMON_ACCESS_URL: "http://127.0.0.1:47851", PASEO_SCOPED_DAEMON_ACCESS_CAPABILITY: "cap1" };
    await t.prepare({ env });
    expect(asked).toEqual(["http://127.0.0.1:47851/shim Bearer cap1"]);
    expect(t.kube.inputs.some((i) => i.argv.join(" ").includes("bin/paseo") || i.argv.includes("bin/paseo"))).toBe(true);
    expect(t.kube.streams[0]!.argv.at(-1)).toBe("47851");
    await t.prepare({ env });
    expect(asked).toHaveLength(1);
    await t.prepare(); // an agent without the tools changes nothing
    expect(asked).toHaveLength(1);
  });

  it("puts the autoscaler's annotations on a running pod that predates the setting", async () => {
    const t = setup({ podAnnotations: { "karpenter.sh/do-not-disrupt": "true" } });
    await t.prepare();
    expect(t.kube.labelled.find((l) => l.kind === "pod")?.annotations).toMatchObject({ "karpenter.sh/do-not-disrupt": "true" });
    expect(t.kube.labelled.find((l) => l.kind === "pvc")?.annotations?.["karpenter.sh/do-not-disrupt"]).toBeUndefined();
  });

  it("installs claude or codex on first use when the image lacks them; any other missing command is a clear error", async () => {
    const t = setup();
    let missing = true;
    const exec = t.kube.exec.bind(t.kube);
    t.kube.exec = async (pod: string, argv: string[]) => (argv[2]?.includes("command -v") && missing ? { code: 1, stdout: "", stderr: "" } : exec(pod, argv));
    await t.prepare();
    expect(t.kube.execs.some((e) => e.argv[2]?.includes("npm install") && e.argv[4] === "@anthropic-ai/claude-code")).toBe(true);
    await expect(t.prepare({ argv: ["mystery-agent"] })).rejects.toThrow(/mystery-agent is not in the pod image/);
    missing = false;
  });

  it("logs Codex in with the pod's OPENAI_API_KEY once per pod, never for other providers, and a failure is logged, not fatal", async () => {
    const logs: string[] = [];
    const t = setup({}, { log: (m: string) => void logs.push(m) });
    const logins = () => t.kube.execs.filter((e) => e.argv[2]?.includes("codex login --with-api-key"));
    await t.prepare();
    expect(logins()).toHaveLength(0); // claude
    await t.prepare({ argv: ["codex", "app-server"], env: { PASEO_AGENT_ID: "a2", CODEX_HOME: "/workspace/.home/.codex" } });
    expect(logins()).toHaveLength(1);
    expect(logins()[0]!.argv[2]).toContain("printenv OPENAI_API_KEY | codex login --with-api-key"); // the key is piped, never an argument
    expect(logins()[0]!.argv[4]).toBe("/workspace/.home/.codex");
    await t.prepare({ argv: ["codex", "app-server"], env: { PASEO_AGENT_ID: "a3" } });
    expect(logins()).toHaveLength(1); // same pod: done once

    const exec = t.kube.exec.bind(t.kube);
    const f = setup({}, { log: (m: string) => void logs.push(m) });
    f.kube.exec = async (pod: string, argv: string[]) => (argv[2]?.includes("codex login") ? { code: 1, stdout: "", stderr: "sk-secret" } : exec(pod, argv));
    await f.prepare({ argv: ["codex", "app-server"] });
    expect(logs.some((m) => m.includes("codex login --with-api-key failed (exit 1)"))).toBe(true);
    expect(logs.join("\n")).not.toContain("sk-secret");
  });

  it("explains a pod that cannot be scheduled, leaves the sandbox suspended and retries on the next prepare", async () => {
    const t = setup();
    t.kube.pods = [{ uid: "u", ready: false, terminating: false, problem: "Pod cannot be scheduled: no capacity" }];
    await expect(t.prepare()).rejects.toThrow(/could not start the pod: .*no capacity/s);
    expect(t.notices.some(([m, l]) => m.includes("no capacity") && l === "warning")).toBe(true);
    expect(t.notices.some(([m, l]) => m.startsWith("Could not start the pod") && l === "error")).toBe(true);
    expect(t.kube.patches2.at(-1)!.patch.spec.operatingMode).toBe("Suspended");
    t.kube.pods = [{ uid: "ok", ready: true, terminating: false }];
    await t.prepare();
    expect(t.kube.applied).toHaveLength(1); // the same sandbox is resumed, not a second one
    expect(t.kube.patches2.some((p) => p.patch.spec?.operatingMode === "Running")).toBe(true);
  });
});

describe("exec: real provider processes in the pod", () => {
  it("starts exactly the provider's command, in the daemon's directory, with an env file holding only the delta", async () => {
    const t = setup();
    const proc = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude", "--print", "--x"], cwd: CWD, env: { PASEO_AGENT_ID: "a1", MODE: "it's quoted" } } as never, t.ctx);
    const spawned = t.kube.procs[0]!;
    expect(spawned.argv.slice(0, 3)).toEqual(["sh", "-c", expect.stringContaining('exec "$@"')]);
    expect(spawned.argv.slice(-4)).toEqual([CWD, "claude", "--print", "--x"]);
    const envPath = spawned.argv[4]!;
    expect(envPath).toMatch(/\/\.home\/\.exec-env\/[0-9a-f]{12}$/);
    const written = t.kube.inputs.find((i) => i.argv.includes(".exec-env/" + envPath.split("/").at(-1)));
    expect(written).toBeDefined();
    // data flows both ways
    spawned.stdout.write("out");
    expect((await new Promise<Buffer>((r) => proc.stdout.once("data", r))).toString()).toBe("out");
    proc.stdin.write("in");
    expect((await new Promise<Buffer>((r) => spawned.stdin.once("data", r))).toString()).toBe("in");
  });

  it("refuses probes: they stay on the daemon host", async () => {
    const t = setup();
    await expect(t.reg.exec({ ...t.base, purpose: "probe", argv: ["claude", "--version"], env: {} } as never, t.ctx)).rejects.toThrow(/Probes run on the daemon host/);
    expect(t.kube.calls).toEqual([]);
  });

  it("reports a normal exit as exited, and an exec that ends because the pod went away as runtime-lost", async () => {
    const t = setup();
    const a = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.procs[0]!.end(0);
    expect(await a.exit).toMatchObject({ code: 0, reason: "exited" });

    const b = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.procs[1]!.end(2);
    expect(await b.exit).toMatchObject({ code: 2, reason: "exited" }); // the pod is fine: the process failed

    const c = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.pods = [{ uid: "x", ready: false, terminating: true }];
    t.kube.procs[2]!.end(137);
    expect(await c.exit).toMatchObject({ reason: "runtime-lost", message: expect.stringContaining("next message brings it back") });
  });

  it("reports a process that ended because the plugin suspended the idle workspace as a planned stop", async () => {
    const t = setup({ podIdleMinutes: 30 });
    const p = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.advance(31 * MIN);
    await t.tick(); // suspends: the phase changes before the pod goes
    t.kube.pods = [{ uid: "x", ready: false, terminating: true }];
    t.kube.procs[0]!.end(137);
    expect(await p.exit).toMatchObject({ reason: "suspended", message: expect.stringContaining("idle pod was suspended") });
  });

  it("stops the process when Paseo aborts the launch or signals it", async () => {
    const t = setup();
    const abort = new AbortController();
    const proc = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, { ...t.ctx, signal: abort.signal });
    await proc.signal("SIGINT");
    abort.abort();
    expect(t.kube.procs[0]!.killed).toEqual(["SIGINT", "SIGTERM"]);
  });
});

describe("inherited runtimes and command execs", () => {
  it("a workspace that inherited the caller's runtime options uses its own directory and no branch choice", async () => {
    const seen: { cwd: string; plan: unknown }[] = [];
    const t = setup({}, { seeder: async (cwd: string, plan: unknown) => (seen.push({ cwd, plan }), fakeSeeder(cwd, plan as never, "main")) });
    const inherited = { cwd: CWD, slug: "caller-slug", ref: { action: "branch-off", refName: "refs/heads/main" }, title: "caller" };
    await t.reg.create!({ workspaceId: "wks_new", options: inherited, cwd: "/home/me/.paseo/worktrees/x/feature" } as never, t.ctx);
    await t.reg.prepare!({ workspaceId: "wks_new", options: inherited, purpose: "session", argv: ["claude"], env: { PASEO_AGENT_ID: "a1" }, mcpServers: {} } as never, t.ctx);
    expect(seen).toEqual([{ cwd: "/home/me/.paseo/worktrees/x/feature", plan: null }]);
    expect((t.kube.applied[0] as any).metadata.annotations["paseo.sh/cwd"]).toBe("/home/me/.paseo/worktrees/x/feature");
  });

  it("a workspace created with just the runtime id (no options) uses its own directory", async () => {
    const seen: string[] = [];
    const t = setup({}, { seeder: async (cwd: string) => (seen.push(cwd), fakeSeeder(cwd, null, "main")) });
    await t.reg.create!({ workspaceId: "wks_bare", cwd: "/home/me/other" } as never, t.ctx);
    await t.reg.prepare!({ workspaceId: "wks_bare", workspaceCwd: "/home/me/other", purpose: "session", argv: ["claude"], env: {}, mcpServers: {} } as never, t.ctx);
    expect(seen).toEqual(["/home/me/other"]);
  });

  it("runs Git-style commands without a prepare, never installs a CLI for them, and does not wake a suspended pod for a background refresh", async () => {
    const t = setup({ podIdleMinutes: 30 });
    const exec = (over: object) => t.reg.exec!({ ...t.base, purpose: "command", argv: ["git", "status"], env: {}, ...over } as never, t.ctx);
    await expect(exec({ interactive: false })).rejects.toThrow(/background refreshes do not wake it/);
    const proc = await exec({ interactive: true });
    expect(proc).toBeTruthy();
    expect(t.kube.applied).toHaveLength(1); // an interactive command started the pod
    expect(t.kube.execs.some((e) => e.argv.join(" ").includes('command -v "$1"'))).toBe(false); // git is not a provider CLI
    t.advance(31 * MIN);
    await t.tick();
    await expect(exec({ interactive: false })).rejects.toThrow(/background refreshes/);
  });
});

describe("idle suspension asks Paseo before ending a pod", () => {
  it("does not suspend while Paseo says an agent is running in the workspace (a turn the plugin never saw start)", async () => {
    let busy: boolean | null = true;
    const t = setup({ podIdleMinutes: 30 }, { workspaceBusy: async () => busy });
    await t.prepare();
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running"); // an agent is running: left alone, and the idle clock restarts
    busy = null;
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running"); // unknown counts as busy
    busy = false;
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("suspended");
  });
});

describe("recovery from a node reclaim", () => {
  const messages: { agentId: string; text: string; behavior: string }[] = [];
  const messenger = { send: async (agentId: string, text: string, behavior: "steer" | "skip") => void messages.push({ agentId, text, behavior }) };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const lose = async (t: ReturnType<typeof setup>, n = 0) => {
    t.kube.pods = [{ uid: "other", ready: false, terminating: true }];
    t.kube.procs[n]!.end(137);
    await flush();
  };

  it("reports the stop as interrupted (when asked to) and sends the agent mid-turn ONE prompt with skip", async () => {
    messages.length = 0;
    const t = setup({ recovery: { interruptedExit: true } }, { messenger });
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "agent-1");
    const p = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    const q = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    await lose(t, 0);
    expect(await p.exit).toMatchObject({ reason: "interrupted", message: expect.stringContaining("Interrupted by a node reclaim") });
    t.kube.procs[1]!.end(137);
    expect(await q.exit).toMatchObject({ reason: "interrupted" });
    await flush();
    expect(messages).toHaveLength(1); // two processes of the pod, one resume
    expect(messages[0]).toMatchObject({ agentId: "agent-1", behavior: "skip" });
    expect(messages[0]!.text).toContain("Your pod was replaced");
  });

  it("keeps runtime-lost while interruptedExit is off, and does not resume an agent that was idle", async () => {
    messages.length = 0;
    const t = setup({}, { messenger });
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "busy");
    t.activity("turn_ended", "busy");
    const p = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    await lose(t);
    expect(await p.exit).toMatchObject({ reason: "runtime-lost" });
    expect(messages).toHaveLength(0);
  });

  it("does not call a healthy pod's failing process an interruption, and says when it ran out of memory", async () => {
    messages.length = 0;
    const t = setup({ recovery: { interruptedExit: true } }, { messenger });
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "agent-1");
    const p = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.pods = [{ uid: "uid-1", ready: true, terminating: false, oomKilled: true }];
    t.kube.procs[0]!.end(137);
    expect(await p.exit).toMatchObject({ reason: "exited", message: expect.stringContaining("out of memory") });
    await flush();
    expect(messages).toHaveLength(1); // the agent mid-turn is resumed once, with the memory note
    expect(messages[0]).toMatchObject({ agentId: "agent-1", behavior: "skip" });
    expect(messages[0]!.text).toMatch(/ran out of memory.*Commit and push more often.*`builder`/);
  });

  it("does not resume the same agent again within ten minutes (no loop)", async () => {
    messages.length = 0;
    const t = setup({}, { messenger });
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "agent-1");
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    await lose(t, 0);
    expect(messages).toHaveLength(1);
    // the pod comes back as a new one, the agent works a turn and is cut again 2 minutes later
    t.kube.pods = [{ uid: "uid-2", ready: true, terminating: false }];
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "agent-1");
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.advance(2 * MIN);
    t.kube.pods = [{ uid: "uid-3", ready: false, terminating: true }];
    t.kube.procs[1]!.end(137);
    await flush();
    expect(messages).toHaveLength(1);
  });

  it("tells an agent mid-turn to commit and push when its pod starts to be taken away, once", async () => {
    messages.length = 0;
    const t = setup({}, { messenger });
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "agent-1");
    await t.prepare();
    await t.runtime.checkInterruptions();
    expect(messages).toHaveLength(0); // a healthy pod
    t.kube.pods = [{ uid: "uid-1", ready: true, terminating: false, disrupted: "EvictionByEvictionAPI" }];
    await t.runtime.checkInterruptions();
    await t.runtime.checkInterruptions();
    expect(messages).toEqual([{ agentId: "agent-1", text: expect.stringContaining("commit and push"), behavior: "steer" }]);
  });
});

describe("idle suspension asks for the workspace's own agents by id", () => {
  it("does not suspend while one of its agents has a turn open that the directory check cannot see, nor when it cannot tell", async () => {
    let byId: boolean | null = true;
    const t = setup({ podIdleMinutes: 30 }, { workspaceBusy: async () => false, agentsBusy: async () => byId });
    await t.prepare();
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running"); // an open turn
    byId = null;
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running"); // unknown counts as busy
    byId = false;
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("suspended");
  });
});

describe("idle suspension and a prompt that arrives while the checks run", () => {
  it("does not suspend a workspace that got input after the idle decision was taken", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ podIdleMinutes: 30 }, { workspaceBusy: async () => (await gate, false) });
    await t.prepare();
    t.advance(31 * MIN);
    const ticking = t.tick(); // idle: Paseo is being asked
    await Promise.resolve();
    t.activity("input"); // a prompt arrives during the question
    release();
    await ticking;
    expect(t.registry.list()[0]!.state).toBe("running");
    // idle again for real: now it is suspended
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("suspended");
  });
});

describe("idle suspension exemptions", () => {
  it("never suspends a workspace whose first agent has an exempt label", async () => {
    const t = setup({ podIdleMinutes: 30, idleExemptLabels: ["paseo.keepalive=1"] });
    t.runtime.noteAgent("wks_1", { "paseo.keepalive": "1" });
    await t.prepare();
    t.advance(120 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
    const other = setup({ podIdleMinutes: 30, idleExemptLabels: ["paseo.keepalive=1"] });
    other.runtime.noteAgent("wks_1", { "paseo.keepalive": "0" });
    await other.prepare();
    other.advance(31 * MIN);
    await other.tick();
    expect(other.registry.list()[0]!.state).toBe("suspended");
  });
});

describe("the pod control of other plugins (podControl)", () => {
  async function ready(rules: object = {}, extra: object = {}) {
    const t = setup({ podIdleMinutes: 30, ...rules }, { workspaceBusy: async () => false, ...extra });
    await t.prepare();
    t.kube.execResult = { code: 0, stdout: " 6433     0 Ssl  claude --output-format stream-json", stderr: "" };
    return t;
  }

  it("suspends and resumes a quiet pod, reporting both to Paseo", async () => {
    const t = await ready();
    expect(await t.runtime.podControl("wks_1", "suspend")).toEqual({ ok: true });
    expect(t.registry.list()[0]!.state).toBe("suspended");
    expect(t.notices.map((n) => n[0])).toContain("The pod is suspended.");
    expect(await t.runtime.podControl("wks_1", "resume")).toEqual({ ok: true });
    expect(t.registry.list()[0]!.state).toBe("running");
  });

  it("refuses a pod with a running agent unless forced", async () => {
    let busy: boolean | null = true;
    const t = await ready({}, { workspaceBusy: async () => busy });
    expect(await t.runtime.podControl("wks_1", "suspend")).toMatchObject({ ok: false, busy: expect.stringContaining("agent is running") });
    busy = null;
    expect(await t.runtime.podControl("wks_1", "suspend")).toMatchObject({ ok: false, busy: expect.stringContaining("could not say") });
    expect(t.registry.list()[0]!.state).toBe("running");
    expect(await t.runtime.podControl("wks_1", "suspend", { force: true })).toEqual({ ok: true });
    expect(t.registry.list()[0]!.state).toBe("suspended");
  });

  it("leaves an idle-exempt workspace alone unless forced", async () => {
    const t = await ready({ idleExemptLabels: ["paseo.keepalive=1"] }, { workspaceLabels: async () => [{ "paseo.keepalive": "1" }] });
    expect(await t.runtime.podControl("wks_1", "suspend")).toMatchObject({ ok: false, busy: expect.stringContaining("idleExemptLabels") });
    expect(t.registry.list()[0]!.state).toBe("running");
    expect(await t.runtime.podControl("wks_1", "suspend", { force: true })).toEqual({ ok: true });
    expect(t.registry.list()[0]!.state).toBe("suspended");
  });

  it("suspends a workspace whose labels match no rule, and says so for an unknown workspace or action", async () => {
    const t = await ready({ idleExemptLabels: ["paseo.keepalive=1"] }, { workspaceLabels: async () => [{ role: "worker" }] });
    expect(await t.runtime.podControl("wks_1", "suspend")).toEqual({ ok: true });
    expect(await t.runtime.podControl("nope", "suspend")).toMatchObject({ ok: false, message: expect.stringContaining("no pod") });
    expect(await t.runtime.podControl("wks_1", "delete" as never)).toMatchObject({ ok: false });
  });
});

describe("idle-exempt labels after a plugin reload", () => {
  const rules = { podIdleMinutes: 30, idleExemptLabels: ["paseo.keep=1", "paseo.mail-alias"] };

  it("asks Paseo for the labels when the plugin has seen none, so a keep-labelled agent is not suspended", async () => {
    const t = setup(rules, { workspaceLabels: async () => [{ "paseo.keep": "1" }] });
    await t.prepare(); // no noteAgent: as after a reload
    t.advance(120 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
  });

  it("honours a key-only rule on any live agent of the workspace", async () => {
    const t = setup(rules, { workspaceLabels: async () => [{ role: "worker" }, { "paseo.mail-alias": "coordinator" }] });
    await t.prepare();
    t.advance(120 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
  });

  it("keeps the pod while the labels cannot be read at all", async () => {
    const t = setup(rules, { workspaceLabels: async () => null });
    await t.prepare();
    t.advance(120 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
  });

  it("suspends once Paseo says no agent carries an exempt label", async () => {
    const t = setup(rules, { workspaceLabels: async () => [{ role: "worker" }] });
    await t.prepare();
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("suspended");
  });
});

describe("a suspend never takes a turn that started at the last moment", () => {
  it("looks at Paseo once more right before suspending", async () => {
    let asked = 0;
    const t = setup({ podIdleMinutes: 30 }, { agentsBusy: async () => ++asked > 1 });
    await t.prepare();
    t.advance(31 * MIN);
    await t.tick();
    expect(asked).toBe(2);
    expect(t.registry.list()[0]!.state).toBe("running");
  });
});

describe("idle suspension and background work inside an agent's process", () => {
  const idleTree = [
    "    1     0 Ss   sleep infinity",
    " 6433     0 Ssl  claude --output-format stream-json --verbose",
    " 6345     0 Ssl  node /workspace/.home/bridge.mjs serve 47821",
    "  974     1 Z    [esbuild] <defunct>",
  ].join("\n");

  it("sees a live child of the provider process as background work, and zombies and the bridge as nothing", () => {
    expect(liveProviderChildren(idleTree)).toBe(false);
    expect(liveProviderChildren(`${idleTree}\n15452  6433 Ss   /bin/bash -c sleep 240\n15483 15452 S    sleep 240`)).toBe(true);
    expect(liveProviderChildren(`${idleTree}\n15452  6433 Z    [bash] <defunct>`)).toBe(false);
    expect(liveProviderChildren("    1     0 Ss   sleep infinity\n 2 1 S unrelated")).toBe(false); // no provider process at all
  });

  it("does not suspend a workspace whose idle agent still has a background command running", async () => {
    const t = setup({ podIdleMinutes: 30 });
    await t.prepare();
    t.kube.execResult = { code: 0, stdout: " 6433     0 Ssl  claude --output-format stream-json\n15483  6433 S    sleep 240", stderr: "" };
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
    t.kube.execResult = { code: 0, stdout: " 6433     0 Ssl  claude --output-format stream-json", stderr: "" };
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("suspended");
  });
});

describe("idle suspension skips say why, and do not hold a pod forever", () => {
  it("logs a background-work skip once, keeps the idle clock, and suspends after the grace", async () => {
    const logs: string[] = [];
    const t = setup({ podIdleMinutes: 30 }, { log: (m: string) => void logs.push(m) });
    await t.prepare();
    t.kube.execResult = { code: 0, stdout: " 6433     0 Ssl  claude --output-format stream-json\n15483  6433 S    npm run dev", stderr: "" };
    t.advance(31 * MIN);
    await t.tick();
    t.advance(3 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
    expect(logs.filter((l) => /not suspended: background work: npm run dev/.test(l))).toHaveLength(1);
    t.advance(IDLE_BACKGROUND_GRACE_MS);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("suspended");
    expect(logs.some((l) => /suspending it anyway/.test(l))).toBe(true);
  });

  it("a pod that cannot be looked at is checked again soon, without restarting its idle clock", async () => {
    const logs: string[] = [];
    const t = setup({ podIdleMinutes: 30 }, { log: (m: string) => void logs.push(m) });
    await t.prepare();
    t.kube.execResult = { code: 1, stdout: "", stderr: "kubectl: timeout" };
    t.advance(31 * MIN);
    await t.tick();
    expect(logs.some((l) => /could not look inside the pod \(kubectl: timeout\)/.test(l))).toBe(true);
    t.kube.execResult = { code: 0, stdout: " 6433     0 Ssl  claude --output-format stream-json", stderr: "" };
    t.advance(3 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("suspended"); // 34 min idle, not 3
  });
});

describe("node pool options", () => {
  const nodePool = {
    nodeSelector: { "lab.anyshift.io/pool": "agents" },
    tolerations: [{ key: "lab.anyshift.io/agents", operator: "Equal", value: "true", effect: "NoSchedule" }],
    resources: { requests: { cpu: "750m", memory: "2Gi" }, limits: { memory: "6Gi" } },
    podAnnotations: { "karpenter.sh/do-not-disrupt": "true" },
  };

  it("places a workspace pod on the pool with its tolerations, resources and the autoscaler's do-not-disrupt hint", async () => {
    const t = setup(nodePool);
    await t.prepare();
    const sb = t.kube.applied[0] as any;
    const spec = sb.spec.podTemplate.spec;
    expect(spec.nodeSelector).toEqual({ "lab.anyshift.io/pool": "agents" });
    expect(spec.tolerations).toEqual([{ key: "lab.anyshift.io/agents", operator: "Equal", value: "true", effect: "NoSchedule" }]);
    expect(spec.containers[0].resources).toEqual({ requests: { cpu: "750m", memory: "2Gi" }, limits: { memory: "6Gi" } }); // no cpu limit
    expect(sb.spec.podTemplate.metadata.annotations["karpenter.sh/do-not-disrupt"]).toBe("true");
  });

  it("keeps warm pods without the hint (a waiting pod may be moved) and adds it when a workspace claims one", async () => {
    const t = setup({ ...nodePool, warmPool: { enabled: true, size: 1 } });
    await t.runtime.maintainPool();
    const warm = t.kube.applied[0] as any;
    expect(warm.spec.podTemplate.spec.nodeSelector).toEqual({ "lab.anyshift.io/pool": "agents" }); // same placement
    expect(warm.spec.podTemplate.metadata.annotations?.["karpenter.sh/do-not-disrupt"]).toBeUndefined();
    await t.prepare();
    const claim = t.kube.patches2.find((p) => p.patch.spec?.podTemplate?.metadata?.annotations?.["paseo.sh/cwd"])!;
    expect(claim.patch.spec.podTemplate.metadata.annotations["karpenter.sh/do-not-disrupt"]).toBe("true");
  });

  it("a resumed pod follows today's placement and annotations", async () => {
    const t = setup(nodePool);
    await t.prepare();
    t.kube.execResult = { code: 0, stdout: " 6433     0 Ssl  claude --output-format stream-json", stderr: "" }; // nothing running in the pod
    expect(await t.runtime.podAction("wks_1", "restart", { force: true })).toEqual({ ok: true });
    const resume = t.kube.patches2.map((p) => p.patch).find((p) => p.spec?.operatingMode === "Running")!;
    expect(resume.spec.podTemplate.spec.nodeSelector).toEqual({ "lab.anyshift.io/pool": "agents" });
    expect(resume.spec.podTemplate.metadata.annotations).toEqual({ "karpenter.sh/do-not-disrupt": "true" });
  });

  it("lets the warm pod go after the idle timeout and brings it back when somebody needs a pod", async () => {
    const t = setup({ warmPool: { enabled: true, size: 1, idleMinutes: 20 } });
    await t.runtime.maintainPool();
    expect(t.kube.sandboxes).toHaveLength(1);
    t.advance(21 * MIN);
    await t.runtime.maintainPool();
    expect(t.kube.sandboxes).toHaveLength(0); // idle: removed, not replaced
    await t.runtime.maintainPool();
    expect(t.kube.sandboxes).toHaveLength(0);
    await t.prepare(); // a workspace appears: its own pod now, and the pool refills for the next one
    await new Promise((r) => setTimeout(r, 10));
    expect(t.kube.sandboxes.filter((s) => s.labels["paseo.sh/state"] === "warm")).toHaveLength(1);
  });
});

describe("the warm pool", () => {
  const IMAGE = "ghcr.io/x/img@sha256:aaa";
  const settings = (over: object = {}) => ({ image: IMAGE, warmPool: { enabled: true, size: 1 }, ...over });

  it("keeps the configured number of warm pods running, with neutral names and no workspace", async () => {
    const t = setup(settings({ warmPool: { enabled: true, size: 2 } }));
    await t.runtime.maintainPool();
    const warm = t.kube.sandboxes.filter((s) => s.labels["paseo.sh/state"] === "warm");
    expect(warm).toHaveLength(2);
    for (const w of warm) {
      expect(w.name).toMatch(/^pka-[0-9a-f]{6}$/); // no "warm" in the name: pods cannot be renamed
      expect(w.labels).not.toHaveProperty("paseo.sh/workspace-id");
      expect(w.labels["paseo.sh/daemon"]).toBe("srv_ME");
      expect(w.annotations["paseo.sh/layout"]).toBe("mapped");
    }
    await t.runtime.maintainPool(); // enough already: nothing more
    expect(t.kube.sandboxes).toHaveLength(2);
    const manifest = t.kube.applied[0] as any;
    const mounts = manifest.spec.podTemplate.spec.containers[0].volumeMounts;
    expect(mounts).toEqual([{ name: "workspace", mountPath: "/workspace" }]); // the checkout is inside the volume, no mount at a daemon path
  });

  it("removes warm pods when the pool is turned off, and replaces ones with another image", async () => {
    const t = setup(settings());
    await t.runtime.maintainPool();
    const first = t.kube.sandboxes[0]!.name;
    let config: object = settings({ image: "ghcr.io/x/img@sha256:bbb" });
    const t2 = setup(config, {}, t.kube);
    await t2.runtime.maintainPool();
    expect(t.kube.sandboxes.map((s) => s.name)).not.toContain(first); // stale image: removed and replaced
    expect(t.kube.sandboxes).toHaveLength(1);
    const t3 = setup({ image: "ghcr.io/x/img@sha256:bbb", warmPool: { enabled: false, size: 1 } }, {}, t.kube);
    await t3.runtime.maintainPool();
    expect(t.kube.sandboxes).toHaveLength(0);
    expect(t.kube.calls.filter((c) => c.startsWith("delete:pvc/"))).toHaveLength(2);
  });

  it("gives a new workspace a ready warm pod, relabelled for it, then starts the next warm pod", async () => {
    const t = setup(settings());
    await t.runtime.maintainPool();
    const warm = t.kube.sandboxes[0]!.name;
    await t.prepare();
    expect(t.kube.applied.every((m: any) => m.metadata.labels["paseo.sh/state"] === "warm")).toBe(true); // nothing was created for the workspace itself: no cold start
    const claimed = t.kube.sandboxes.find((s) => s.name === warm)!;
    expect(claimed.labels).toMatchObject({ "paseo.sh/workspace-id": "wks_1", "paseo.sh/state": "running", "paseo.sh/workspace": "brave-otter-12" });
    expect(claimed.annotations["paseo.sh/cwd"]).toBe(CWD);
    expect(t.kube.labelled.some((l) => l.kind === "pvc" && l.name === `workspace-${warm}` && l.labels["paseo.sh/workspace-id"] === "wks_1")).toBe(true);
    expect(t.notices.map((n) => n[0])).toContain("Using a pod that was already running...");
    await new Promise((r) => setTimeout(r, 10));
    expect(t.kube.sandboxes.filter((s) => s.labels["paseo.sh/state"] === "warm")).toHaveLength(1); // the pool refilled
    // the checkout is seeded at the fixed path inside the pod, not at the daemon's
    const seed = t.kube.execs.find((e) => e.argv[2]?.includes('git init -q "$dir"'))!;
    expect(seed.argv[4]).toBe("/workspace/checkout");
  });

  it("starts a mapped pod of its own when no warm pod is ready, and maps the workspace directory to the fixed path", async () => {
    const t = setup(settings());
    expect(await t.reg.mapCwd!({ ...t.base, cwd: CWD } as never)).toBe("/workspace/checkout");
    await t.prepare();
    const sb = t.kube.applied[0] as any;
    expect(sb.metadata.labels["paseo.sh/workspace-id"]).toBe("wks_1");
    expect(sb.metadata.annotations["paseo.sh/layout"]).toBe("mapped");
    expect(sb.spec.podTemplate.spec.containers[0].volumeMounts).toHaveLength(1);
  });

  it("leaves everything as it was with the pool off: the checkout is at the daemon's path and no mapping", async () => {
    const t = setup({ image: IMAGE });
    expect(await t.reg.mapCwd!({ ...t.base, cwd: CWD } as never)).toBe(CWD);
    await t.prepare();
    const sb = t.kube.applied[0] as any;
    expect(sb.metadata.annotations["paseo.sh/layout"]).toBeUndefined();
    expect(sb.spec.podTemplate.spec.containers[0].volumeMounts).toContainEqual({ name: "workspace", mountPath: CWD, subPath: "checkout" });
  });

  it("keeps an existing legacy pod legacy after the pool is turned on", async () => {
    const t = setup(settings());
    t.kube.sandboxes = [{ name: "pka-old", labels: { "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": "wks_1" }, annotations: { "paseo.sh/cwd": CWD }, operatingMode: "Running", image: IMAGE, createdAt: new Date(0).toISOString() }];
    await t.runtime.start();
    expect(await t.reg.mapCwd!({ ...t.base, cwd: CWD } as never)).toBe(CWD);
  });

  it("deletes a warm pod from the screen's action", async () => {
    const t = setup(settings());
    await t.runtime.maintainPool();
    const name = t.kube.sandboxes[0]!.name;
    expect(await t.runtime.podAction(`warm:${name}`, "delete")).toEqual({ ok: true });
    expect(await t.runtime.podAction(`warm:${name}`, "suspend")).toMatchObject({ ok: false });
    expect(t.kube.calls).toContain(`delete:sandbox/${name}`);
  });
});

describe("submodules do not hold the agent back", () => {
  it("returns from prepare while the submodule checkout is still running, then reports it", async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const exec = t.kube.exec.bind(t.kube);
    t.kube.exec = async (pod: string, argv: string[]) => {
      if (argv.includes("submodule") && argv.includes("update")) await gate; // a slow checkout
      if (argv[2]?.includes("submodule status")) return { code: 0, stdout: "-abc123 vendor/lib\n", stderr: "" };
      return exec(pod, argv);
    };
    await t.prepare(); // does not wait for the gate
    expect(t.notices.map((n) => n[0])).toContain("Fetching the submodules in the background...");
    expect(t.notices.map((n) => n[0])).not.toContain("Submodules are ready.");
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.notices.map((n) => n[0])).toContain("Submodules are ready.");
  });
});

describe("an idle suspend ends the agent's process itself", () => {
  it("terminates the provider process and reports the planned exit before the pod is touched, so a resume right after cannot turn it into a lost pod", async () => {
    const t = setup({ podIdleMinutes: 30 });
    const p = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.advance(31 * MIN);
    await t.tick(); // suspends: SIGTERM first, wait for the exit, then delete the pod
    expect(t.kube.procs[0]!.killed).toEqual(["SIGTERM"]);
    const order = t.kube.calls.filter((c) => c === "spawn" || c.startsWith("patch:"));
    expect(order[order.length - 1]).toMatch(/^patch:/); // the pod went last
    // a Git poll resumes the workspace while the old pod is still terminating
    expect(await t.runtime.podAction("wks_1", "resume")).toEqual({ ok: true });
    t.kube.pods = [{ uid: "old", ready: false, terminating: true }];
    expect(await p.exit).toMatchObject({ reason: "suspended", message: expect.stringContaining("idle pod was suspended") });
  });
});

describe("reporting a planned stop to Paseo", () => {
  const handle = () => {
    const calls: string[] = [];
    return {
      calls,
      reportSuspended: (r: { workspaceId: string; reason: string; message?: string }) => void calls.push(`suspended:${r.workspaceId}:${r.reason}:${r.message ?? ""}`),
      reportResumed: (r: { workspaceId: string }) => void calls.push(`resumed:${r.workspaceId}`),
    };
  };

  it("reports an idle suspend before the process is signalled, and the resume", async () => {
    const t = setup({ podIdleMinutes: 30 });
    const h = handle();
    t.runtime.attachHandle(h);
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    h.calls.length = 0;
    t.advance(31 * MIN);
    await t.tick();
    expect(h.calls).toEqual(["suspended:wks_1:idle:Pod suspended to save resources; it wakes on the next message."]);
    expect(t.kube.procs[0]!.killed).toEqual(["SIGTERM"]);
    await t.runtime.podAction("wks_1", "resume");
    expect(h.calls.at(-1)).toBe("resumed:wks_1");
  });

  it("reports a suspend asked for on the screen as manual", async () => {
    const t = setup();
    const h = handle();
    t.runtime.attachHandle(h);
    await t.prepare();
    await t.runtime.podAction("wks_1", "suspend");
    expect(h.calls.some((c) => c.startsWith("suspended:wks_1:manual:"))).toBe(true);
  });

  it("reports a pod found suspended when the plugin starts, again soon after, then rarely", async () => {
    const t = setup();
    const h = handle();
    t.runtime.attachHandle(h);
    t.kube.sandboxes = [{ name: "pka-old", labels: { "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": "wks_1" }, annotations: { "paseo.sh/cwd": CWD }, operatingMode: "Suspended", image: "img", createdAt: new Date(0).toISOString() }];
    await t.runtime.start();
    await t.runtime.reconcileSuspensions();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatch(/^suspended:wks_1:idle:/);
    t.advance(3 * MIN);
    await t.runtime.reconcileSuspensions();
    expect(h.calls).toHaveLength(2);
    t.advance(3 * MIN);
    await t.runtime.reconcileSuspensions();
    expect(h.calls).toHaveLength(2);
    t.advance(31 * MIN);
    await t.runtime.reconcileSuspensions();
    expect(h.calls).toHaveLength(3);
  });

  it("does not report a running pod, and stops once the workspace is resumed", async () => {
    const t = setup();
    const h = handle();
    t.runtime.attachHandle(h);
    await t.prepare();
    h.calls.length = 0;
    await t.runtime.reconcileSuspensions();
    expect(h.calls).toEqual([]);
    await t.runtime.podAction("wks_1", "suspend");
    await t.runtime.podAction("wks_1", "resume");
    h.calls.length = 0;
    t.advance(40 * MIN);
    await t.runtime.reconcileSuspensions();
    expect(h.calls).toEqual([]);
  });

  it("reports the suspended state when a pod fails to start", async () => {
    const t = setup();
    const h = handle();
    t.runtime.attachHandle(h);
    await t.prepare();
    await t.runtime.podAction("wks_1", "suspend");
    h.calls.length = 0;
    t.kube.pods = [{ uid: "never", ready: false, terminating: false }];
    await expect(t.prepare()).rejects.toThrow(/could not start the pod/);
    expect(h.calls.some((c) => c.startsWith("suspended:wks_1:idle:The pod could not start"))).toBe(true);
  });

  it("still suspends on a Paseo that gives no handle", async () => {
    const t = setup({ podIdleMinutes: 30 });
    t.runtime.attachHandle(undefined);
    await t.prepare();
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("suspended");
  });

  it("kills a process that is still alive after the grace period, and still reports the planned exit", async () => {
    const t = setup({ podIdleMinutes: 30 }, { stopGraceMs: 5 });
    const p = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.killEnds = false;
    const proc = t.kube.procs[0]!;
    t.advance(31 * MIN);
    const ticking = t.tick();
    await new Promise((r) => setTimeout(r, 40));
    expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);
    proc.end(137);
    await ticking;
    expect(await p.exit).toMatchObject({ code: 137, reason: "suspended" });
  });

  it("reports an eviction by its cause, once for the pod, and leaves an out-of-memory kill an error", async () => {
    const t = setup({ recovery: { interruptedExit: true } });
    const h = handle();
    t.runtime.attachHandle(h);
    const a = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    const b = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.pods = [{ uid: "uid-1", ready: false, terminating: false, evicted: true }];
    t.kube.procs[0]!.end(137);
    t.kube.procs[1]!.end(137);
    expect(await a.exit).toMatchObject({ reason: "interrupted" });
    expect(await b.exit).toMatchObject({ reason: "interrupted" });
    expect(h.calls.filter((c) => c.startsWith("suspended:wks_1:quota-eviction:"))).toHaveLength(1);

    const oom = setup();
    const o = handle();
    oom.runtime.attachHandle(o);
    const p = await oom.reg.exec({ ...oom.base, purpose: "session", argv: ["claude"], env: {} } as never, oom.ctx);
    oom.kube.pods = [{ uid: "uid-1", ready: true, terminating: false, oomKilled: true }];
    oom.kube.procs[0]!.end(137);
    expect(await p.exit).toMatchObject({ reason: "exited", code: 137 });
    expect(o.calls.filter((c) => c.startsWith("suspended"))).toEqual([]);
  });
});

describe("stopping the plugin", () => {
  it("ends the provider processes itself and reports each as a planned stop, so idle agents drop them quietly", async () => {
    const t = setup();
    const a = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    const b = await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    const stopping = t.runtime.stop();
    expect(t.kube.procs.map((p) => p.killed)).toEqual([["SIGTERM"], ["SIGTERM"]]);
    t.kube.procs[0]!.end(null, "SIGTERM");
    t.kube.procs[1]!.end(null, "SIGTERM");
    await stopping;
    expect(await a.exit).toMatchObject({ reason: "suspended", message: expect.stringContaining("plugin restarted") });
    expect(await b.exit).toMatchObject({ reason: "suspended" });
  });

  it("does not hang the shutdown on a process that will not die", async () => {
    const t = setup();
    t.kube.killEnds = false;
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    const started = Date.now();
    await t.runtime.stop(); // the fake process never ends: the wait is bounded
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("describeWorkspace for the sidebar badge", () => {
  it("answers without touching the cluster: no pod yet, then image/pod/state, following suspension", async () => {
    const t = setup({ image: "ghcr.io/lerenn/paseo-kubernetes-runtime-default@sha256:f4aedb1145658527f3e43dd1ae6d95a917b39e94799491eae6f9c400ccd8e3b5", podIdleMinutes: 30 });
    const describe = () => t.reg.describeWorkspace!({ ...t.base } as never);
    expect(await describe()).toMatchObject({ detail: "Kubernetes pod · not started yet" });
    expect((await describe())!.label).toBeUndefined();
    await t.prepare();
    const calls = t.kube.calls.length;
    const running = await describe();
    expect(t.kube.calls).toHaveLength(calls); // nothing read or started
    expect(running!.label).toBeUndefined(); // icon only in the sidebar
    expect(running!.hostIcon).toBe("ship-wheel");
    expect(running!.tooltip).toContain("Image name: paseo-kubernetes-runtime-default");
    expect(running!.tooltip).toContain("State: running");
    expect(running!.tooltip).toMatch(/Pod pka-/);
    expect(running!.tooltip).toContain("Image: ghcr.io/lerenn/paseo-kubernetes-runtime-default@sha256:f4aedb11");
    expect(running!.detail).toMatch(/^paseo-kubernetes-runtime-default · pka-.* · running$/);
    t.advance(31 * MIN);
    await t.tick();
    expect((await describe())!.detail).toMatch(/· suspended$/);
    expect(t.notices.map((n) => n[0])).toContain("The pod is suspended."); // makes Paseo ask again
  });
});

describe("the pod actions of the screen", () => {
  async function running(extra: object = {}) {
    const archived: string[] = [];
    const t = setup({ podIdleMinutes: 30 }, { workspaceBusy: async () => false, archiveWorkspace: async (id: string) => void archived.push(id), ...extra });
    await t.prepare();
    t.kube.execResult = { code: 0, stdout: " 6433     0 Ssl  claude --output-format stream-json", stderr: "" }; // no background work
    return { t, archived };
  }

  it("suspends a quiet pod and resumes it", async () => {
    const { t } = await running();
    expect(await t.runtime.podAction("wks_1", "suspend")).toEqual({ ok: true });
    expect(t.registry.list()[0]!.state).toBe("suspended");
    expect(await t.runtime.podAction("wks_1", "resume")).toEqual({ ok: true });
    expect(t.registry.list()[0]!.state).toBe("running");
    expect(await t.runtime.podAction("wks_1", "resume")).toMatchObject({ ok: true, message: expect.stringContaining("already") });
  });

  it("refuses to touch a pod with a running agent or background work unless forced, and says why", async () => {
    let busy: boolean | null = true;
    const { t } = await running({ workspaceBusy: async () => busy });
    expect(await t.runtime.podAction("wks_1", "suspend")).toMatchObject({ ok: false, busy: expect.stringContaining("agent is running") });
    expect(await t.runtime.podAction("wks_1", "delete")).toMatchObject({ ok: false, busy: expect.stringContaining("agent is running") });
    busy = null;
    expect(await t.runtime.podAction("wks_1", "restart")).toMatchObject({ ok: false, busy: expect.stringContaining("could not say") });
    busy = false;
    t.kube.execResult = { code: 0, stdout: " 6433     0 Ssl  claude --output-format stream-json\n15483  6433 S    sleep 240", stderr: "" };
    expect(await t.runtime.podAction("wks_1", "suspend")).toMatchObject({ ok: false, busy: expect.stringContaining("background command") });
    expect(t.registry.list()[0]!.state).toBe("running");
    expect(await t.runtime.podAction("wks_1", "suspend", { force: true })).toEqual({ ok: true });
    expect(t.registry.list()[0]!.state).toBe("suspended");
  });

  it("restarts a quiet pod (suspend then resume on the same volume)", async () => {
    const { t } = await running();
    expect(await t.runtime.podAction("wks_1", "restart")).toEqual({ ok: true });
    expect(t.registry.list()[0]!.state).toBe("running");
    const modes = t.kube.patches2.map((p) => p.patch.spec?.operatingMode).filter(Boolean);
    expect(modes).toEqual(["Suspended", "Running"]);
  });

  it("deletes the Sandbox and volume, optionally archiving the workspace", async () => {
    const { t, archived } = await running();
    expect(await t.runtime.podAction("wks_1", "delete", { archive: true })).toEqual({ ok: true });
    expect(t.kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([expect.stringMatching(/^delete:sandbox\/pka-/), expect.stringMatching(/^delete:pvc\/workspace-pka-/)]);
    expect(archived).toEqual(["wks_1"]);
    expect(await t.runtime.podAction("wks_1", "suspend")).toMatchObject({ ok: false, message: expect.stringContaining("no pod") });
  });
});

describe("the tunnels survive a plugin restart", () => {
  it("restarts the bridge of a running pod when the plugin starts, with the ports its processes still use", async () => {
    const t = setup();
    t.kube.sandboxes = [{ name: "pka-running", labels: { "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": "wks_1" }, annotations: { "paseo.sh/cwd": CWD }, operatingMode: "Running" as const, createdAt: new Date(0).toISOString() }];
    t.kube.execResult = { code: 0, stdout: "8123\n9000\nnot-a-port\n", stderr: "" };
    await t.runtime.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.kube.streams).toHaveLength(1);
    expect(t.kube.streams[0]!.argv.at(-1)).toBe("8123,9000");
  });

  it("does not start a bridge for a suspended pod", async () => {
    const t = setup();
    t.kube.sandboxes = [{ name: "pka-s", labels: { "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": "wks_1" }, annotations: { "paseo.sh/cwd": CWD }, operatingMode: "Suspended" as const, createdAt: new Date(0).toISOString() }];
    await t.runtime.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.kube.streams).toHaveLength(0);
  });
});

describe("the bridge is kept alive", () => {
  const SANDBOX = { name: "pka-running", labels: { "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": "wks_1" }, annotations: { "paseo.sh/cwd": CWD }, operatingMode: "Running" as const, createdAt: new Date(0).toISOString() };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  async function started(extra: object = {}) {
    const logs: string[] = [];
    const t = setup({}, { log: (l: string) => void logs.push(l), ...extra });
    t.kube.sandboxes = [{ ...SANDBOX }];
    await t.runtime.start();
    await settle();
    expect(t.kube.streams).toHaveLength(1);
    return { t, logs };
  }

  it("logs the end of the channel and restores the bridge", async () => {
    const { t, logs } = await started();
    t.kube.streams[0]!.end();
    await settle();
    expect(t.kube.streams).toHaveLength(2);
    expect(logs.some((l) => l.includes("channel ended"))).toBe(true);
    expect(logs.some((l) => l.includes("restored after its channel ended"))).toBe(true);
  });

  it("retries a failed restore 5 times with backoff, logs each failure and surfaces a notice", async () => {
    const sleeps: number[] = [];
    const { t, logs } = await started({ sleep: async (ms: number) => void sleeps.push(ms) });
    const notices: string[] = [];
    (t.runtime as any).states.get("wks_1").notice = (m: string) => void notices.push(m);
    t.kube.podInfo = async () => {
      throw new Error("boom");
    };
    t.kube.pods = [{ uid: "uid-1", ready: false, terminating: false }];
    t.kube.streams[0]!.end();
    await settle();
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(logs.filter((l) => l.includes("restore attempt"))).toHaveLength(5);
    expect(notices.some((m) => m.includes("bridge is down"))).toBe(true);
    expect(t.kube.streams).toHaveLength(1);
  });

  it("restores a dead bridge on a liveness tick", async () => {
    const { t } = await started();
    const ws = (t.runtime as any).states.get("wks_1");
    ws.bridge = undefined; // the channel is gone and nothing is retrying
    t.runtime.checkBridges();
    await settle();
    expect(t.kube.streams).toHaveLength(2);
  });

  it("removes the stale socket when the pod was replaced", async () => {
    const { t } = await started();
    t.kube.pods = [{ uid: "uid-2", ready: true, terminating: false }];
    t.kube.streams[0]!.end();
    await settle();
    expect(t.kube.streams).toHaveLength(2);
    expect(t.kube.execs.some((e) => e.argv.join(" ").includes("rm -f") && e.argv.join(" ").includes("bridge.sock"))).toBe(true);
  });

  it("probes an open channel and restores the bridge when it does not answer", async () => {
    const { t, logs } = await started();
    const probes = () => t.kube.execs.filter((e) => e.argv[0] === "node" && e.argv[1] === "-e").length;
    t.runtime.checkBridges();
    await settle();
    expect(probes()).toBe(1);
    expect(t.kube.streams).toHaveLength(1); // answers (exit 0): left alone
    t.runtime.checkBridges();
    await settle();
    expect(probes()).toBe(1); // rate limited
    t.advance(60_000);
    t.kube.execResult = { code: 7, stdout: "", stderr: "" }; // connection refused: serve is gone
    t.runtime.checkBridges();
    await settle();
    expect(probes()).toBe(2);
    expect(t.kube.streams).toHaveLength(2);
    expect(logs.some((l) => l.includes("does not answer"))).toBe(true);
  });

  it("leaves the bridge alone when the probe itself cannot run", async () => {
    const { t } = await started();
    t.kube.execResult = { code: 1, stdout: "", stderr: "exec failed" };
    t.runtime.checkBridges();
    await settle();
    expect(t.kube.streams).toHaveLength(1);
  });

  it("does not restore for a suspended workspace", async () => {
    const { t } = await started();
    const ws = (t.runtime as any).states.get("wks_1");
    ws.bridge = undefined;
    ws.phase = "suspended";
    t.runtime.checkBridges();
    await settle();
    expect(t.kube.streams).toHaveLength(1);
  });
});

describe("the 30 second limit on prepare", () => {
  it("returns from prepare when the window ends while the pod is still starting, and exec waits for the rest", async () => {
    const t = setup({}, { startWindowMs: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const exec = t.kube.exec.bind(t.kube);
    t.kube.exec = async (pod: string, argv: string[]) => {
      if (argv[2]?.includes("git init")) await gate; // seeding is slow
      return exec(pod, argv);
    };
    await t.prepare(); // returns without error although seeding has not finished
    expect(t.kube.execs.some((e) => e.argv[2]?.includes("git init"))).toBe(false);
    const started = t.reg.exec!({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, { ...t.ctx });
    release();
    await started;
    expect(t.kube.execs.some((e) => e.argv[2]?.includes("git init"))).toBe(true);
    expect(t.registry.list()[0]!.state).toBe("running");
  });

  it("still reports a failure that happens inside the window", async () => {
    const t = setup({ readyTimeoutSeconds: 1 });
    t.kube.pods = [{ uid: "u", ready: false, terminating: false, problem: "Pod cannot be scheduled: no capacity" }];
    await expect(t.prepare()).rejects.toThrow(/could not start the pod/);
  });
});

describe("workspaceCwd, reconcile with the workspace list, and checkCommand", () => {
  it("takes the workspace directory from workspaceCwd on any call, not from the (possibly inherited) options", async () => {
    const t = setup();
    const inherited = { cwd: "/caller/dir", slug: "caller", ref: null };
    await t.reg.prepare!({ workspaceId: "wks_i", options: inherited, workspaceCwd: "/home/me/.paseo/worktrees/x/own", purpose: "session", argv: ["claude"], env: {}, mcpServers: {} } as never, t.ctx);
    expect((t.kube.applied[0] as any).metadata.annotations["paseo.sh/cwd"]).toBe("/home/me/.paseo/worktrees/x/own");
  });

  it("reconcile deletes the Sandbox of a workspace the list no longer has, keeps listed and young ones", async () => {
    const t = setup();
    const old = new Date(0).toISOString(); // the test clock starts at 1,000,000 ms
    const sb = (name: string, id: string, createdAt: string) => ({ name, labels: { "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": id }, annotations: { "paseo.sh/cwd": CWD }, operatingMode: "Running" as const, createdAt });
    t.kube.sandboxes = [sb("gone", "wks_gone", old), sb("kept", "wks_kept", old), sb("young", "wks_young", new Date(999_000).toISOString())];
    await t.reg.reconcile!({ workspaces: [{ workspaceId: "wks_kept", options: t.options, cwd: CWD }] }, t.ctx);
    expect(t.kube.calls.filter((c) => c.startsWith("delete:sandbox"))).toEqual(["delete:sandbox/gone"]);
  });

  it("checkCommand: claude and codex are installed on demand; other commands are looked up in a running pod", async () => {
    const t = setup();
    const ask = (command: string) => t.reg.checkCommand!({ ...t.base, command } as never);
    expect(await ask("claude")).toBe(true);
    expect(await ask("/usr/local/bin/codex")).toBe(true);
    expect(await ask("some-mcp")).toBe(true); // no pod yet: nothing to ask
    await t.prepare();
    t.kube.execResult = { code: 1, stdout: "", stderr: "" };
    expect(await ask("some-mcp")).toBe(false);
  });
});

describe("labels for people", () => {
  it("labels with the agent that ran, follows suspension and renames, and patches the pod and claim too", async () => {
    const t = setup({ podIdleMinutes: 30 });
    await t.prepare({ env: { PASEO_AGENT_ID: "0c0f7a18-aaaa-bbbb" } });
    expect((t.kube.applied[0] as any).metadata.labels).toMatchObject({ "paseo.sh/agent": "0c0f7a18", "paseo.sh/state": "running" });
    const last = () => t.kube.patches2.filter((p) => p.patch.metadata?.labels).at(-1)!.patch.metadata.labels;

    // another agent starts in the same workspace: the labels follow it
    await t.prepare({ env: { PASEO_AGENT_ID: "99999999-aaaa" } });
    expect(last()).toMatchObject({ "paseo.sh/agent": "99999999", "paseo.sh/state": "running", "paseo.sh/workspace": "brave-otter-12" });
    expect(t.kube.labelled.some((l) => l.kind === "pod" && l.labels["paseo.sh/agent"] === "99999999")).toBe(true);
    expect(t.kube.labelled.some((l) => l.kind === "pvc")).toBe(true);

    await t.runtime.syncNames(new Map([["wks_1", "Fix the login"]]));
    expect(last()).toMatchObject({ "paseo.sh/workspace": "Fix-the-login" });

    t.advance(31 * MIN);
    await t.tick();
    expect(last()).toMatchObject({ "paseo.sh/state": "suspended" });
    expect(t.kube.labelled.at(-1)).toMatchObject({ kind: "pvc", labels: { "paseo.sh/state": "suspended" } });
  });
});

describe("suspend, resume and destroy", () => {
  it("suspends a workspace whose agents have all been idle, keeping the volume and giving it no expiry", async () => {
    const t = setup({ podIdleMinutes: 30 });
    await t.prepare();
    t.advance(29 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
    t.advance(2 * MIN);
    await t.tick();
    expect(t.kube.patches2.at(-1)!.patch).toEqual({ spec: { operatingMode: "Suspended" } });
    expect(t.registry.list()[0]!.state).toBe("suspended");
    expect(t.kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
  });

  it("does not suspend while any agent has a turn running or a permission pending, or when disabled", async () => {
    const t = setup({ podIdleMinutes: 30 });
    await t.prepare();
    t.activity("turn_started");
    t.advance(2 * 60 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
    t.activity("turn_ended");
    t.activity("permission_requested", "a2");
    t.advance(2 * 60 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
    t.activity("permission_resolved", "a2");
    t.advance(31 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("suspended");
    for (const settings of [{ podIdleMinutes: 0 }, { storage: { mode: "ephemeral", size: "10Gi" } }]) {
      const off = setup(settings);
      await off.prepare();
      off.advance(24 * 60 * MIN);
      await off.tick();
      expect(off.registry.list()[0]!.state).toBe("running");
    }
  });

  it("input counts as activity", async () => {
    const t = setup({ podIdleMinutes: 30 });
    await t.prepare();
    t.advance(25 * MIN);
    t.activity("input");
    t.advance(25 * MIN);
    await t.tick();
    expect(t.registry.list()[0]!.state).toBe("running");
  });

  it("beforeInput resumes a suspended workspace on the same volume, with the current image, without reseeding", async () => {
    const t = setup({ podIdleMinutes: 30, image: "node:23" });
    await t.prepare();
    t.advance(31 * MIN);
    await t.tick();
    const seeds = () => t.kube.execs.filter((e) => e.argv[2]?.includes('git init -q "$dir"')).length;
    const before = seeds();
    t.kube.hasClone = true;
    await t.reg.beforeInput!({ ...t.base, agentId: "a1" }, t.ctx);
    const resume = t.kube.patches2.filter((p) => p.patch.spec?.operatingMode === "Running").at(-1)!.patch;
    expect(resume.spec.podTemplate.spec.containers[0].image).toBe("node:23");
    expect(seeds()).toBe(before);
    expect(t.registry.list()[0]!.state).toBe("running");
    expect(t.notices.map((n) => n[0])).toContain("Resuming the pod...");
  });

  it("treats a Running sandbox whose pod Kubernetes rejected as one to rebuild, and nothing else", () => {
    expect(specRejected({ operatingMode: "Running", ready: { status: "False", reason: "InvalidConfiguration", message: "requests above the memory limit" } })).toBe(true);
    expect(specRejected({ operatingMode: "Suspended", ready: { status: "False", reason: "InvalidConfiguration", message: "x" } })).toBe(false);
    expect(specRejected({ operatingMode: "Running", ready: { status: "False", reason: "ReconcilerError", message: "exceeded quota" } })).toBe(false);
    expect(specRejected({ operatingMode: "Running" })).toBe(false);
  });

  it("beforeInput on a running workspace changes nothing", async () => {
    const t = setup();
    await t.prepare();
    const calls = t.kube.calls.length;
    await t.reg.beforeInput!({ ...t.base, agentId: "a1" }, t.ctx);
    expect(t.kube.calls.length).toBe(calls);
  });

  it("queues inputs that arrive during a resume behind it, with one resume", async () => {
    const t = setup({ podIdleMinutes: 30 });
    await t.prepare();
    t.advance(31 * MIN);
    await t.tick();
    await Promise.all([1, 2, 3].map(() => t.reg.beforeInput!({ ...t.base, agentId: "a1" }, t.ctx)));
    expect(t.kube.patches2.filter((p) => p.patch.spec?.operatingMode === "Running")).toHaveLength(1);
  });

  it("destroy removes this workspace's sandbox and volume claim, and only that", async () => {
    const t = setup();
    await t.prepare();
    await t.reg.prepare!({ workspaceId: "wks_2", options: { cwd: "/home/me/other" }, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    const first = (t.kube.applied[0] as any).metadata.name;
    await t.reg.destroy!(t.base, t.ctx);
    expect(t.kube.calls.filter((c) => c.startsWith("delete:"))).toEqual([`delete:sandbox/${first}`, `delete:pvc/workspace-${first}`]);
    expect(t.registry.list().map((p) => p.workspaceId)).toEqual(["wks_2"]);
    await expect(t.reg.destroy!({ workspaceId: "wks_unknown", options: { cwd: CWD } }, t.ctx)).resolves.toBeUndefined();
  });

  it("reconcile forgets what was set up in a lost pod, so the next launch sets up the replacement", async () => {
    const t = setup();
    await t.prepare();
    const installs = () => t.kube.inputs.filter((i) => i.argv[4] === "bridge.mjs").length;
    expect(installs()).toBe(1);
    await t.reg.reconcile!({ workspaces: [{ workspaceId: "wks_1", options: t.options, cwd: CWD }] }, t.ctx);
    t.kube.pods = [{ uid: "replacement", ready: true, terminating: false }];
    await t.prepare();
    expect(installs()).toBe(2);
    expect(t.kube.streams).toHaveLength(2); // a new bridge
  });

  it("picks up the workspaces a previous plugin run left, so idle ones are suspended after a restart", async () => {
    const kube = new FakeKube();
    kube.sandboxes = [
      { name: "pka-old-1", labels: { "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace": "wks_old" }, annotations: { "paseo.sh/cwd": "/home/me/old" }, operatingMode: "Running" },
      { name: "pka-other", labels: { "paseo.sh/daemon": "srv_OTHER", "paseo.sh/workspace": "wks_x" }, annotations: { "paseo.sh/cwd": "/x" }, operatingMode: "Running" },
    ];
    const t = setup({ podIdleMinutes: 30 }, {}, kube);
    await t.runtime.start();
    expect(t.registry.list().map((p) => p.workspaceId)).toEqual(["wks_old"]); // never another daemon's
    t.advance(31 * MIN);
    await t.tick();
    expect(kube.patches2.at(-1)).toMatchObject({ name: "pka-old-1", patch: { spec: { operatingMode: "Suspended" } } });
  });

  it("inspect reports absent, running, resuming and suspended", async () => {
    const t = setup({ podIdleMinutes: 30 });
    expect(await t.reg.inspect!(t.base, t.ctx)).toEqual({ state: "absent" });
    await t.prepare();
    expect(await t.reg.inspect!(t.base, t.ctx)).toEqual({ state: "running" });
    t.kube.pods = [{ uid: "u", ready: false, terminating: false, problem: "Pod cannot be scheduled: no capacity" }];
    expect(await t.reg.inspect!(t.base, t.ctx)).toEqual({ state: "resuming", message: "Pod cannot be scheduled: no capacity" });
    t.kube.pods = [{ uid: "u", ready: true, terminating: false }];
    t.advance(31 * MIN);
    await t.tick();
    expect(await t.reg.inspect!(t.base, t.ctx)).toEqual({ state: "suspended" });
  });
});

describe("turn-scoped annotations", () => {
  const KEY = "karpenter.sh/do-not-disrupt";
  const running = async (extra: object = {}, settings: object = {}) => {
    const t = setup(settings, extra);
    await t.prepare();
    t.kube.annotated.length = 0;
    return t;
  };

  it("puts them on when a turn opens, once, and takes them off 30 s after the last turn ended", async () => {
    const t = await running();
    t.activity("turn_started", "a1");
    await new Promise((r) => setTimeout(r, 0));
    expect(t.kube.annotated).toEqual([{ name: expect.any(String), set: { [KEY]: "true" }, remove: [] }]);
    t.activity("turn_started", "a2");
    await t.runtime.checkTurnAnnotations();
    expect(t.kube.annotated).toHaveLength(1); // idempotent
    t.activity("turn_ended", "a1");
    t.advance(60_000);
    await t.runtime.checkTurnAnnotations();
    expect(t.kube.annotated).toHaveLength(1); // a2 still has a turn open
    t.activity("turn_ended", "a2");
    t.advance(10_000);
    await t.runtime.checkTurnAnnotations();
    expect(t.kube.annotated).toHaveLength(1); // debounce
    t.advance(25_000);
    await t.runtime.checkTurnAnnotations();
    expect(t.kube.annotated[1]).toMatchObject({ set: {}, remove: [KEY] });
    await t.runtime.checkTurnAnnotations();
    expect(t.kube.annotated).toHaveLength(2);
  });

  it("a turn that starts within the debounce keeps the annotation", async () => {
    const t = await running();
    t.activity("turn_started");
    await new Promise((r) => setTimeout(r, 0));
    t.activity("turn_ended");
    t.advance(10_000);
    t.activity("turn_started");
    t.advance(60_000);
    await t.runtime.checkTurnAnnotations();
    expect(t.kube.annotated.filter((a) => a.remove.length)).toHaveLength(0);
  });

  it("puts them on a replaced pod again, and leaves a key that podAnnotations also sets", async () => {
    const t = await running({}, { podAnnotations: { [KEY]: "true" } });
    t.activity("turn_started");
    await new Promise((r) => setTimeout(r, 0));
    t.kube.pods = [{ uid: "uid-2", ready: true, terminating: false }];
    await t.runtime.checkTurnAnnotations();
    expect(t.kube.annotated).toHaveLength(2);
    t.activity("turn_ended");
    t.advance(31_000);
    await t.runtime.checkTurnAnnotations();
    expect(t.kube.annotated).toHaveLength(2); // nothing to remove: podAnnotations owns the key
  });

  it("after a plugin restart reconciles from the agent list: stays on for an open turn, comes off when none", async () => {
    let busy: boolean | null = true;
    const kube = new FakeKube();
    const first = setup({}, {}, kube);
    await first.prepare();
    kube.annotated.length = 0;
    // a new plugin process: no turn state, the pod is already running
    const second = setup({}, { agentsBusy: async () => busy }, kube);
    await (second.runtime as any).adopt();
    await second.runtime.checkTurnAnnotations();
    expect(kube.annotated).toEqual([{ name: expect.any(String), set: { [KEY]: "true" }, remove: [] }]);
    busy = null;
    const third = setup({}, { agentsBusy: async () => busy }, kube);
    await (third.runtime as any).adopt();
    kube.annotated.length = 0;
    third.advance(60_000);
    await third.runtime.checkTurnAnnotations();
    expect(kube.annotated).toEqual([]); // cannot tell: untouched
    busy = false;
    await third.runtime.checkTurnAnnotations(); // starts the debounce
    third.advance(31_000);
    await third.runtime.checkTurnAnnotations();
    expect(kube.annotated).toEqual([{ name: expect.any(String), set: {}, remove: [KEY] }]);
  });

  it("does nothing when turnAnnotations is empty", async () => {
    const t = await running({}, { turnAnnotations: {} });
    t.activity("turn_started");
    await new Promise((r) => setTimeout(r, 0));
    expect(t.kube.annotated).toEqual([]);
  });
});

describe("OOM counters", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oom-"));
  const sent: { agentId: string; text: string }[] = [];
  const messenger = { send: async (agentId: string, text: string) => void sent.push({ agentId, text }) };
  const flush = () => new Promise((r) => setTimeout(r, 5));
  const oomPod = { uid: "uid-1", ready: true, terminating: false, oomKilled: true, oomAt: "2026-10-27T10:00:00Z", memoryLimit: "3Gi" };

  it("counts per workspace and agent, logs, persists, shows in the status row, and resumes ONCE through the guard", async () => {
    sent.length = 0;
    const logs: string[] = [];
    const file = path.join(dir, "oom.json");
    const t = setup({}, { messenger, oomStateFile: file, recoveryStateFile: path.join(dir, "rec.json"), log: (l: string) => void logs.push(l) });
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "agent-1");
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.pods = [oomPod];
    t.kube.procs[0]!.end(137);
    t.kube.procs[1]!.end(137);
    await flush();
    expect(logs).toContain("[kubernetes-runtime] OOM: wks_1 agent agent-1 limit 3Gi");
    expect(logs.filter((l) => l.includes("OOM: wks_1"))).toHaveLength(1); // one kill, two reporting processes
    expect(sent).toHaveLength(1);
    expect(t.runtime.oomStats().get("wks_1")).toMatchObject({ count: 1, limit: "3Gi", agents: { "agent-1": { count: 1 } } });
    // persisted: a new ledger on the same file has it
    const again = new OomLedger(file, 0);
    expect(again.get("wks_1")).toMatchObject({ count: 1, agents: { "agent-1": { count: 1 } } });
    // a second kill soon after: counted, but the guard allows no second resume within ten minutes
    t.activity("turn_started", "agent-1");
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.pods = [{ ...oomPod, oomAt: "2026-10-27T10:02:00Z" }];
    t.kube.procs[2]!.end(137);
    await flush();
    expect(sent).toHaveLength(1);
    expect(t.runtime.oomStats().get("wks_1")!.count).toBe(2);
    const row = buildPodRows({ sandboxes: t.kube.sandboxes, claims: [], pods: new Map(), entries: [], titles: null, agents: [], oom: t.runtime.oomStats() })[0]!;
    expect(row.oom).toMatchObject({ limit: "3Gi" });
  });

  it("mails one error per agent and reason, with the last log lines, when the pod runs out of memory", async () => {
    const mails: { to: string; subject: string; body: string }[] = [];
    const mail = async (to: string, subject: string, body: string) => (mails.push({ to, subject, body }), true);
    const t = setup({}, { messenger, mail, recoveryStateFile: path.join(dir, "rec-mail.json") });
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "agent-1");
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.pods = [oomPod];
    t.kube.procs[0]!.end(137);
    await flush();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "@assistant" });
    expect(mails[0]!.subject).toContain("ran out of memory");
    expect(mails[0]!.body).toContain("Workspace: wks_1");
    // a second kill within 30 minutes: no second mail
    t.activity("turn_started", "agent-1");
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.pods = [{ ...oomPod, oomAt: "2026-10-27T10:05:00Z" }];
    t.kube.procs[1]!.end(137);
    await flush();
    expect(mails).toHaveLength(1);
  });

  it("mails one out-of-memory error for three kills 11 minutes apart (within the 30-minute window)", async () => {
    const mails: string[] = [];
    const t = setup({}, { messenger, mail: async (_t: string, s: string) => (mails.push(s), true), recoveryStateFile: path.join(dir, "rec-giveup.json") });
    await t.reg.create!(t.base, t.ctx);
    for (let i = 0; i < 3; i++) {
      t.activity("turn_started", "agent-1");
      await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
      t.kube.pods = [{ ...oomPod, oomAt: `2026-10-27T10:0${i}:00Z` }];
      t.kube.procs[i]!.end(137);
      await flush();
      t.advance(11 * 60_000);
    }
    expect(mails.filter((s) => s.includes("ran out of memory"))).toHaveLength(1);
  });

  it("sends no error mail when the setting is off", async () => {
    const mails: string[] = [];
    const t = setup({ errorMail: { enabled: false } }, { messenger, mail: async (_t: string, s: string) => (mails.push(s), true) });
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "agent-1");
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.pods = [oomPod];
    t.kube.procs[0]!.end(137);
    await flush();
    expect(mails).toEqual([]);
  });

  it("does not resume when autoResume is off, and an idle agent is never resumed", async () => {
    sent.length = 0;
    const t = setup({ recovery: { autoResume: false } }, { messenger });
    await t.reg.create!(t.base, t.ctx);
    t.activity("turn_started", "agent-1");
    await t.reg.exec({ ...t.base, purpose: "session", argv: ["claude"], env: {} } as never, t.ctx);
    t.kube.pods = [oomPod];
    t.kube.procs[0]!.end(137);
    await flush();
    expect(sent).toHaveLength(0);
    expect(t.runtime.oomStats().get("wks_1")!.count).toBe(1);
  });

  it("summarizes once a day, only when there were kills", () => {
    const l = new OomLedger(null, 0);
    expect(l.dueSummary(SUMMARY_EVERY_MS)).toBeNull(); // nothing to say
    l.record("wks_1", ["a"], SUMMARY_EVERY_MS + 1, { limit: "3Gi" });
    expect(l.dueSummary(SUMMARY_EVERY_MS + 10)).toBeNull(); // not a day yet
    expect(l.dueSummary(2 * SUMMARY_EVERY_MS + 1)).toContain("wks_1: 1 (limit 3Gi)");
    expect(l.dueSummary(3 * SUMMARY_EVERY_MS + 2)).toBeNull();
  });
});
