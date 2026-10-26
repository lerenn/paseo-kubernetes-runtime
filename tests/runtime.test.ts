import { describe, expect, it } from "vitest";
import { KubernetesRuntime, liveProviderChildren } from "../server/runtime.js";
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
    expect(await describe()).toMatchObject({ label: "no pod yet" });
    await t.prepare();
    const calls = t.kube.calls.length;
    const running = await describe();
    expect(t.kube.calls).toHaveLength(calls); // nothing read or started
    expect(running).toMatchObject({ label: "paseo-kubernetes-runtime-default" });
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
    const last = () => t.kube.patches2.filter((p) => p.patch.metadata).at(-1)!.patch.metadata.labels;

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
