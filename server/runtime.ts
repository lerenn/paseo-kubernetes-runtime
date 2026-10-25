import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { parseRuntimeOptions, type RuntimeOptions } from "../shared/runtime-options.js";
import { applyFetch, fetchTargets, otherRepoTarget, pushToMirror, type FetchTarget } from "./mirrors.js";
import { applyPush, loopbackPorts, startBridge, type RunningBridge } from "./bridge.js";
import type { KubernetesRuntimeConfig } from "./config.js";
import { type GitRunner, runGit, scrub } from "./git.js";
import type { Kube, SandboxInfo } from "./kube.js";
import { INSTALLABLE_CLIS, LAUNCH_SCRIPT } from "./pod-assets.js";
import { ensureCommand, ensureJq, initSubmodules, installAssets, seedWorkspace, setupMirrors, writeEnvFile } from "./pod-setup.js";
import { waitPodReady } from "./pod-wait.js";
import { paseoWorkspaceBusy } from "./orphans.js";
import { PodRegistry, type PodState } from "./registry.js";
import type {
  WorkspaceRuntimeActivityEvent,
  WorkspaceRuntimeCommandRequest,
  WorkspaceRuntimeReconcileRequest,
  WorkspaceRuntimeContext,
  WorkspaceRuntimeExecRequest,
  WorkspaceRuntimeFileSystem,
  WorkspaceRuntimeFsEntry,
  WorkspaceRuntimeFsRequest,
  WorkspaceRuntimeFsStat,
  WorkspaceRuntimeInputRequest,
  WorkspaceRuntimePrepareRequest,
  WorkspaceRuntimeProcess,
  WorkspaceRuntimeRegistration,
  WorkspaceRuntimeStatus,
  WorkspaceRuntimeWorkspaceRequest,
} from "./runtime-types.js";
import {
  CWD_ANNOTATION,
  DAEMON_LABEL,
  HOME_DIR,
  REPO_LABEL,
  WORKSPACE_ID_LABEL,
  WORKSPACE_LABEL,
  buildSandbox,
  metaPatch,
  type PodMeta,
  type PodState as MetaState,
  resumePatch,
  sandboxName,
  suspendPatch,
  workspaceClaimName,
} from "./sandbox.js";
import { createSeed, releaseSeed, seedBundle, type Seed } from "./seed.js";
import { clonePlan, detectRepo, repoName, type ClonePlan, type RepoRef } from "./workspace.js";

export interface SeedBundle {
  seed: Seed;
  bundle: Readable;
  /** Resolves when the bundle has been fully produced. */
  done: Promise<void>;
  release(): Promise<void>;
}

export interface RuntimeDeps {
  getConfig(): Promise<KubernetesRuntimeConfig>;
  kubeFor(config: KubernetesRuntimeConfig): Kube;
  /** This daemon's id, written on every sandbox and volume claim so the reaper only ever considers its own. */
  daemonId?: string;
  /** Where workspace states are published for the Kubernetes Runtime screen. */
  registry?: PodRegistry;
  /** Git on the daemon, with the daemon's own credentials (injected for tests). */
  git?: GitRunner;
  /** Builds the seed bundle from the daemon's checkout (injected for tests). */
  seeder?: (cwd: string, plan: ClonePlan | null, currentBranch: string) => Promise<SeedBundle>;
  detectRepo?: (cwd: string) => Promise<RepoRef>;
  /** Pod port to daemon port for loopback tunnels (identity in production; tests share one host). */
  mapTunnelPort?: (port: number) => number;
  /** Calls `fn` every `ms` until the returned stop function runs (injected for tests). */
  ticker?: (fn: () => void, ms: number) => () => void;
  sleep?: (ms: number) => Promise<void>;
  /** Whether Paseo has an agent running a turn in this workspace directory; null when it cannot tell (injected for tests). */
  workspaceBusy?: (cwd: string) => Promise<boolean | null>;
  /** How long `prepare` and `beforeInput` wait for the pod before returning and letting `exec` wait (Paseo gives them 15 minutes). */
  startWindowMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface AgentActivity {
  turn: boolean;
  pendingPermissions: number;
}

interface WorkspaceState {
  id: string;
  options: RuntimeOptions;
  sandbox?: string;
  phase: PodState | "none";
  bridge?: RunningBridge;
  ports: Set<number>;
  /** Loopback ports every launch so far asked for; kept so a later `exec` starts the same bridge `prepare` asked for. */
  wantPorts: Set<number>;
  /** The latest call's notice channel, used by work that outlives the call that started it. */
  notice?: WorkspaceRuntimeContext["notice"];
  /** Remotes the pod may fetch from (the project's origin and its submodules), served through the bridge. */
  targets: FetchTarget[];
  /** The directory came from the workspace itself (`create`'s cwd or the Sandbox), not from options an inherited runtime copied. */
  cwdFixed?: boolean;
  /** What the Sandbox, pod and claim were last labelled with, so they are only patched when it changes. */
  repo?: string;
  repoUrl?: string;
  agent?: string;
  labelled?: string;
  /** When labelling the pod or claim last failed (missing `patch` in the Role); retried after a while. */
  labelFailedAt?: number;
  /** The pod the pod-side setup was last verified for; a replacement pod has another uid and is set up again. */
  readyUid?: string;
  commands: Set<string>;
  agents: Map<string, AgentActivity>;
  lastActivity: number;
  /** Everything that changes the pod (create, resume, suspend, destroy, prepare) runs one at a time. */
  chain: Promise<unknown>;
}

export const RUNTIME_LABEL = "Kubernetes Runtime";

/**
 * A workspace runtime that runs a workspace's provider processes (real claude, codex, ...) in a pod of its
 * own. The pod is created when the first process is about to start, seeded from a git bundle of the daemon's
 * checkout, which the pod shows at the daemon's own absolute path; it is suspended when every agent has been
 * idle for a while, resumed by the next input, and deleted when the workspace is archived.
 */
export class KubernetesRuntime {
  private readonly states = new Map<string, WorkspaceState>();
  private stopTicker: () => void = () => undefined;
  private readonly git: GitRunner;
  private readonly now: () => number;

  constructor(private readonly deps: RuntimeDeps) {
    this.git = deps.git ?? runGit;
    this.now = deps.now ?? Date.now;
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  /** Starts the idle timer and picks up the pods a previous plugin run left running. */
  async start(): Promise<void> {
    const tick = () => void this.checkIdle().catch(() => undefined);
    this.stopTicker = (this.deps.ticker ?? ((fn, ms) => {
      const timer = setInterval(fn, ms) as unknown as NodeJS.Timeout;
      timer.unref?.();
      return () => clearInterval(timer);
    }))(tick, 30_000);
    await this.adopt().catch(() => undefined);
  }

  stop(): void {
    this.stopTicker();
    for (const ws of this.states.values()) ws.bridge?.close();
  }

  /** Re-reads the cluster: the workspaces this daemon has sandboxes for, so idle ones are suspended after a restart. */
  private async adopt(): Promise<void> {
    if (!this.deps.daemonId) return;
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    for (const sandbox of await kube.listSandboxes(`${DAEMON_LABEL}=${this.deps.daemonId}`)) {
      const id = sandbox.labels[WORKSPACE_ID_LABEL] ?? (sandbox.labels[WORKSPACE_LABEL]?.startsWith("wks_") ? sandbox.labels[WORKSPACE_LABEL] : undefined);
      const cwd = sandbox.annotations[CWD_ANNOTATION];
      if (!id || !cwd || this.states.has(id)) continue;
      const ws = this.newState(id, { cwd });
      ws.sandbox = sandbox.name;
      ws.cwdFixed = true;
      this.setPhase(ws, sandbox.operatingMode === "Suspended" ? "suspended" : "running");
    }
  }

  private newState(id: string, options: RuntimeOptions): WorkspaceState {
    const ws: WorkspaceState = {
      id,
      options,
      phase: "none",
      ports: new Set(),
      wantPorts: new Set(),
      targets: [],
      commands: new Set(),
      agents: new Map(),
      lastActivity: this.now(),
      chain: Promise.resolve(),
    };
    this.states.set(id, ws);
    return ws;
  }

  private workspace(request: WorkspaceRuntimeWorkspaceRequest): WorkspaceState {
    let ws = this.states.get(request.workspaceId);
    // A workspace created with just `--runtime kubernetes` has no options: its directory is all there is.
    const dir = request.workspaceCwd ?? request.cwd;
    const given: RuntimeOptions = request.options
      ? parseRuntimeOptions(request.options)
      : parseRuntimeOptions({ cwd: ws?.options.cwd ?? dir, slug: ws?.options.slug ?? (dir ? slugFor(dir) : undefined), ref: null });
    // A workspace that inherited its runtime from the caller comes with the caller's options; its own directory is
    // what `create` was told, so that wins, and the caller's branch choice and name do not apply to it.
    const cwd = request.workspaceCwd ?? request.cwd;
    if (cwd && cwd !== given.cwd && !ws?.cwdFixed) {
      const options: RuntimeOptions = { cwd, slug: slugFor(cwd), ref: null };
      ws ??= this.newState(request.workspaceId, options);
      ws.options = options;
      ws.cwdFixed = true;
      return ws;
    }
    ws ??= this.newState(request.workspaceId, given);
    if (cwd) ws.cwdFixed = true;
    ws.options = ws.cwdFixed ? { ...given, cwd: ws.options.cwd, slug: ws.options.slug, ref: ws.options.ref, title: ws.options.title ?? given.title } : given;
    return ws;
  }

  private setPhase(ws: WorkspaceState, phase: PodState): void {
    ws.phase = phase;
    if (ws.sandbox) this.deps.registry?.set(ws.id, ws.sandbox, phase, this.now());
  }

  private serial<T>(ws: WorkspaceState, fn: () => Promise<T>): Promise<T> {
    const run = ws.chain.then(fn);
    ws.chain = run.catch(() => undefined);
    return run;
  }

  private identity = async (cwd: string) => {
    const read = async (key: string, fallback: string) => {
      const r = await this.git(["config", key], { cwd }).catch(() => null);
      return r && r.code === 0 && r.stdout.trim() ? r.stdout.trim() : fallback;
    };
    return { name: await read("user.name", "Paseo Agent"), email: await read("user.email", "agent@paseo.invalid") };
  };

  private async seedIfEmpty(kube: Kube, ws: WorkspaceState, pod: string, ctx: WorkspaceRuntimeContext): Promise<void> {
    const { cwd } = ws.options;
    const present = await kube.exec(pod, ["test", "-d", `${cwd}/.git`]);
    if (present.code === 0) return;
    ctx.notice("Copying the project into the pod...");
    const repo = await (this.deps.detectRepo ?? detectRepo)(cwd);
    const plan = clonePlan(ws.options);
    const made = await (this.deps.seeder ?? this.defaultSeeder)(cwd, plan, repo.branch);
    try {
      await this.refreshTargets(kube, ws, pod, [made.seed.sha]);
      await seedWorkspace(kube, pod, made.seed, made.bundle, {
        dir: cwd,
        originUrl: repo.url,
        identity: await this.identity(cwd),
        newBranch: plan?.action === "branch-off" && plan.slug ? plan.slug : undefined,
      });
      await made.done;
      // origin/<branch> exists from the start (no "gone" upstream in git status); best effort
      await kube.exec(pod, ["git", "-C", cwd, "fetch", "-q", "origin"]).catch(() => undefined);
      const subs = await initSubmodules(kube, pod, cwd, ws.targets);
      if (!subs.ok) ctx.notice(`Could not fetch the submodules (run \`git submodule update --init\` in the pod to retry): ${subs.message}`, "warning");
    } finally {
      await made.release().catch(() => undefined);
    }
  }

  /** Tells git in the pod which remotes it may fetch from (origin and the submodules at HEAD and at the seed commit). */
  private async refreshTargets(kube: Kube, ws: WorkspaceState, pod: string, shas: string[] = []): Promise<void> {
    const { cwd } = ws.options;
    const head = await this.git(["rev-parse", "HEAD"], { cwd }).catch(() => null);
    const all = [...shas];
    if (head?.code === 0) all.push(head.stdout.trim());
    const seeded = shas.length ? null : await kube.exec(pod, ["cat", `${HOME_DIR}/seed.sha`]).catch(() => null);
    if (seeded?.code === 0 && seeded.stdout.trim()) all.push(seeded.stdout.trim());
    // the project's own remote URL, not the https form the pod is told about: the daemon fetches with its own credentials
    const raw = await this.git(["remote", "get-url", "origin"], { cwd }).catch(() => null);
    const originUrl = raw?.code === 0 && raw.stdout.trim() ? raw.stdout.trim() : (await (this.deps.detectRepo ?? detectRepo)(cwd)).url;
    ws.targets = await fetchTargets(this.git, cwd, originUrl, all);
    const access = (await this.deps.getConfig()).otherRepos;
    await setupMirrors(kube, pod, cwd, await this.identity(cwd), ws.targets, access.enabled ? access.hosts : []);
  }

  private defaultSeeder = async (cwd: string, plan: ClonePlan | null, currentBranch: string): Promise<SeedBundle> => {
    const seed = await createSeed(this.git, cwd, plan, currentBranch);
    const { stream, done } = seedBundle(cwd, seed);
    return { seed, bundle: stream, done, release: () => releaseSeed(this.git, cwd, seed) };
  };

  private startBridge(kube: Kube, ws: WorkspaceState, ports: Set<number>): void {
    ws.bridge?.close();
    ws.ports = ports;
    ws.bridge = startBridge(
      kube,
      ws.sandbox!,
      [...ports],
      {
        handle: async (request) => {
          if (request.op === "push" && !request.mirror) return applyPush(this.git, ws.options.cwd, request);
          // a repository a pod asked for by name is checked against the "Other repositories" setting
          const mirror = request.mirror;
          let targets = ws.targets;
          if (mirror?.startsWith("x:")) {
            const target = otherRepoTarget(mirror, (await this.deps.getConfig()).otherRepos);
            if ("refused" in target) return { ok: false, message: `kube-agents: ${target.refused}` };
            targets = [target];
          }
          return request.op === "fetch"
            ? applyFetch(this.git, ws.options.cwd, request, targets)
            : pushToMirror(this.git, ws.options.cwd, request, targets);
        },
      },
      { mapPort: this.deps.mapTunnelPort },
    );
  }

  /** Brings the workspace's pod to a state where a provider process can start; cheap once it already is. */
  private async ensureReady(
    ws: WorkspaceState,
    ctx: WorkspaceRuntimeContext,
    need: { command?: string; mcpServers?: Record<string, unknown>; env?: Record<string, string> } = {},
  ): Promise<void> {
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    const { cwd } = ws.options;
    for (const port of loopbackPorts((need.mcpServers ?? {}) as Record<string, { type: string; url?: string }>, [need.env?.PASEO_GITHUB_PROXY_URL])) ws.wantPorts.add(port);
    const wanted = new Set([...ws.ports, ...ws.wantPorts]);
    const grows = [...wanted].some((p) => !ws.ports.has(p));

    // Fast path: the same pod is up and everything this launch needs is already in place.
    if (ws.sandbox && ws.phase === "running" && ws.readyUid && !grows && (!need.command || ws.commands.has(need.command))) {
      const info = await kube.podInfo(ws.sandbox).catch(() => null);
      if (info?.ready && !info.terminating && info.uid === ws.readyUid) {
        await this.syncLabels(kube, ws, "running"); // another agent may have started in this workspace
        return;
      }
    }

    let sandbox: SandboxInfo | undefined;
    if (ws.sandbox) sandbox = (await kube.listSandboxes(`${WORKSPACE_ID_LABEL}=${ws.id}`)).find((s) => s.name === ws.sandbox);
    sandbox ??= (await kube.listSandboxes(`${WORKSPACE_ID_LABEL}=${ws.id}`))[0];

    if (!sandbox) {
      ctx.notice("Starting the pod...");
      const repo = await (this.deps.detectRepo ?? detectRepo)(cwd);
      const name = sandboxName(ws.id, repoName(repo.url), ws.options.slug);
      ws.repo = repoName(repo.url);
      ws.repoUrl = repo.url;
      await kube.apply(buildSandbox({ name, workspaceId: ws.id, cwd, config, daemonId: this.deps.daemonId, meta: this.meta(ws, "running") }));
      ws.labelled = this.metaKey(this.meta(ws, "running"));
      ws.sandbox = name;
    } else {
      ws.sandbox = sandbox.name;
      ws.repo ??= sandbox.labels[REPO_LABEL];
      if (sandbox.operatingMode === "Suspended") {
        ctx.notice("Resuming the pod...");
        this.setPhase(ws, "resuming");
        await kube.patchSandbox(sandbox.name, resumePatch(config, cwd));
      }
    }
    this.setPhase(ws, "resuming");

    try {
      const pod = ws.sandbox;
      const info = await waitPodReady(kube, pod, {
        timeoutSeconds: config.readyTimeoutSeconds,
        sleep: this.deps.sleep,
        now: this.deps.now,
        onProblem: (problem) => ctx.notice(problem, "warning"),
      });
      await installAssets(kube, pod);
      await ensureJq(kube, pod);
      if (!ws.bridge || grows || ws.readyUid !== info.uid) this.startBridge(kube, ws, wanted); // before seeding: submodules are fetched through it
      await this.seedIfEmpty(kube, ws, pod, ctx);
      await this.refreshTargets(kube, ws, pod);
      if (need.command && !ws.commands.has(need.command)) {
        ctx.notice(`Checking ${need.command} in the pod...`);
        await ensureCommand(kube, pod, need.command);
        ws.commands.add(need.command);
      }
      ws.readyUid = info.uid;
      this.setPhase(ws, "running");
      ws.lastActivity = this.now();
      await this.syncLabels(kube, ws, "running");
    } catch (error) {
      ws.readyUid = undefined;
      // Left suspended-looking so the next input retries from a clean state; the volume and the sandbox stay.
      await kube.patchSandbox(ws.sandbox, suspendPatch()).catch(() => undefined);
      ws.bridge?.close();
      ws.bridge = undefined;
      ws.commands.clear();
      this.setPhase(ws, "suspended");
      const message = (error as Error).message;
      ctx.notice(`Could not start the pod: ${message}`, "error");
      throw new Error(`kube: could not start the pod: ${message}`);
    }
  }

  /** The workspace's files, served from the pod. Only while the pod runs: polling must not keep it awake or wake it. */
  private fileSystem(): WorkspaceRuntimeFileSystem {
    const call = async (request: WorkspaceRuntimeFsRequest, op: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
      const ws = this.workspace(request);
      const config = await this.deps.getConfig();
      const kube = this.deps.kubeFor(config);
      const info = ws.sandbox && ws.phase === "running" ? await kube.podInfo(ws.sandbox).catch(() => null) : null;
      if (!ws.sandbox || !info?.ready || info.terminating) {
        throw new Error("EAGAIN: the pod is not running (suspended or not started yet); it starts with the next message to an agent");
      }
      const payload = Buffer.from(JSON.stringify({ op, root: ws.options.cwd, path: request.path, ...extra }));
      const run = () => kube.execInput(ws.sandbox!, ["sh", "-c", 'exec node "$HOME/fs.mjs"'], Readable.from([payload]));
      let r = await run();
      if (r.code !== 0 && /Cannot find module/.test(r.stderr)) {
        await installAssets(kube, ws.sandbox);
        r = await run();
      }
      let out: { ok: boolean; error?: string; result?: unknown };
      try {
        out = JSON.parse(r.stdout);
      } catch {
        throw new Error(`EIO: the pod could not run the file operation: ${scrub(r.stderr.trim()) || "no answer"}`);
      }
      if (!out.ok) throw new Error(out.error ?? "EIO: file operation failed");
      return out.result;
    };
    return {
      stat: async (r) => ((await call(r, "stat")) as WorkspaceRuntimeFsStat | null) ?? null,
      readdir: async (r) => (await call(r, "readdir")) as WorkspaceRuntimeFsEntry[],
      read: async (r) => new Uint8Array(Buffer.from(((await call(r, "read", { offset: r.offset, length: r.length })) as { data: string }).data, "base64")),
      write: async (r) =>
        (await call(r, "write", { data: Buffer.from(r.data).toString("base64"), mode: r.mode, exclusive: r.exclusive, expectedMtimeMs: r.expectedMtimeMs })) as WorkspaceRuntimeFsStat,
      mkdir: async (r) => void (await call(r, "mkdir")),
      rename: async (r) => void (await call(r, "rename", { to: r.to })),
      remove: async (r) => void (await call(r, "remove", { recursive: r.recursive })),
      copy: async (r) => void (await call(r, "copy", { to: r.to })),
    };
  }

  private meta(ws: WorkspaceState, state: MetaState): PodMeta {
    return {
      workspaceName: ws.options.title ?? ws.options.slug ?? ws.id,
      repo: ws.repo ?? "repo",
      ...(ws.repoUrl ? { repoUrl: ws.repoUrl } : {}),
      ...(ws.agent ? { agent: ws.agent } : {}),
      state,
    };
  }

  private metaKey = (meta: PodMeta) => JSON.stringify(meta);

  /**
   * Keeps the human-readable labels (workspace, agent, repo, state) on the Sandbox, its pod and its volume claim
   * current. Best effort: the Sandbox is always patched; the pod and claim need `patch` on them in the daemon's Role.
   */
  private async syncLabels(kube: Kube, ws: WorkspaceState, state: MetaState): Promise<void> {
    if (!ws.sandbox) return;
    const meta = this.meta(ws, state);
    const key = this.metaKey(meta);
    const retry = ws.labelFailedAt !== undefined && this.now() - ws.labelFailedAt > 5 * 60_000;
    if (ws.labelled === key && !retry) return;
    ws.labelled = key;
    ws.labelFailedAt = undefined;
    await kube.patchSandbox(ws.sandbox, metaPatch(meta)).catch(() => undefined);
    const { labels, annotations } = (metaPatch(meta) as { metadata: unknown }).metadata as { labels: Record<string, string>; annotations: Record<string, string> };
    const failed: unknown[] = [];
    if (state === "running") await kube.label("pod", ws.sandbox, labels, annotations).catch((e) => failed.push(e));
    await kube.label("pvc", workspaceClaimName(ws.sandbox), labels, annotations).catch((e) => failed.push(e));
    if (failed.length) ws.labelFailedAt = this.now();
  }

  /** Brings the labels of every workspace in line with its current name in Paseo (renames). */
  async syncNames(names: ReadonlyMap<string, string>): Promise<void> {
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    for (const ws of this.states.values()) {
      const name = names.get(ws.id);
      if (!name || !ws.sandbox || name === (ws.options.title ?? ws.options.slug)) continue;
      ws.options = { ...ws.options, title: name };
      await this.syncLabels(kube, ws, ws.phase === "suspended" ? "suspended" : "running").catch(() => undefined);
    }
  }

  private async suspend(ws: WorkspaceState): Promise<void> {
    if (!ws.sandbox || ws.phase !== "running") return;
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    this.log(`[kubernetes-runtime] suspending idle pod ${ws.sandbox} (workspace ${ws.id})`);
    ws.bridge?.close();
    ws.bridge = undefined;
    ws.readyUid = undefined;
    ws.commands.clear();
    this.setPhase(ws, "suspended"); // before the pod goes: processes that end with it are reported as runtime-lost
    await this.syncLabels(kube, ws, "suspended");
    await kube.patchSandbox(ws.sandbox, suspendPatch());
  }

  /** Suspends every workspace whose agents have all been idle for `podIdleMinutes`. */
  async checkIdle(): Promise<void> {
    const config = await this.deps.getConfig();
    const limit = config.podIdleMinutes * 60_000;
    if (limit <= 0 || config.storage.mode !== "persistent") return;
    for (const ws of this.states.values()) {
      const busy = [...ws.agents.values()].some((a) => a.turn || a.pendingPermissions > 0);
      if (ws.phase === "running" && !busy && this.now() - ws.lastActivity >= limit) {
        // The activity events this plugin saw are not the whole story: after a plugin reload it has seen none, and a
        // turn that started before it keeps running. Ask Paseo; if an agent is running (or it cannot say), wait.
        const running = await (this.deps.workspaceBusy ?? paseoWorkspaceBusy)(ws.options.cwd).catch(() => null);
        if (running !== false) {
          ws.lastActivity = this.now();
          continue;
        }
        await this.serial(ws, () => this.suspend(ws)).catch(() => undefined);
      }
    }
  }

  /** The registration Paseo's fork takes. */
  registration(): WorkspaceRuntimeRegistration {
    return {
      id: "kubernetes",
      label: RUNTIME_LABEL,
      describe: () => ({ protocolVersion: 1, capabilities: { pipes: true, pty: false } }),
      create: async (request) => {
        this.workspace(request); // validates the options; nothing exists in the cluster until a process is about to start
      },
      inspect: (request) => this.inspect(request),
      destroy: (request) => this.destroy(request),
      reconcile: (request) => this.reconcile(request),
      checkCommand: (request) => this.checkCommand(request),
      prepare: (request, ctx) => this.prepare(request, ctx),
      beforeInput: (request, ctx) => this.beforeInput(request, ctx),
      onActivity: (event) => this.onActivity(event),
      exec: (request, ctx) => this.exec(request, ctx),
      fs: this.fileSystem(),
    };
  }

  async prepare(request: WorkspaceRuntimePrepareRequest, ctx: WorkspaceRuntimeContext): Promise<void> {
    const ws = this.workspace(request);
    ws.agent = request.env.PASEO_AGENT_ID?.slice(0, 8) ?? ws.agent;
    await this.withinWindow(ws, ctx, () => this.ensureReady(ws, this.detached(ws, ctx), { command: request.argv[0], mcpServers: request.mcpServers, env: request.env }));
  }

  /** A context whose notices keep reaching the latest call after the call that started the work has returned. */
  private detached(ws: WorkspaceState, ctx: WorkspaceRuntimeContext): WorkspaceRuntimeContext {
    ws.notice = ctx.notice;
    return { ...ctx, notice: (message, level) => ws.notice?.(message, level) };
  }

  /**
   * Paseo gives `prepare` and `beforeInput` 15 minutes. Work runs on the workspace's queue regardless; the call
   * returns when it is done or when the window ends, and `exec`, which has no deadline, waits for the rest.
   */
  private async withinWindow(ws: WorkspaceState, ctx: WorkspaceRuntimeContext, work: () => Promise<void>): Promise<void> {
    ws.notice = ctx.notice;
    const job = this.serial(ws, work);
    const window = this.deps.startWindowMs ?? 14 * 60_000; // Paseo's deadline for these calls is 15 minutes
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      job.then(() => "done" as const),
      new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), window);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    if (waited === "late") {
      ctx.notice("The pod is still starting; the agent starts when it is ready.");
      job.catch(() => undefined); // a failure now is raised again by the launch that follows (exec retries from a clean state)
    }
  }

  async beforeInput(request: WorkspaceRuntimeInputRequest, ctx: WorkspaceRuntimeContext): Promise<void> {
    const ws = this.workspace(request);
    ws.lastActivity = this.now();
    await this.withinWindow(ws, ctx, async () => {
      if (ws.phase === "suspended" || ws.phase === "resuming") await this.ensureReady(ws, this.detached(ws, ctx), {});
    });
  }

  onActivity(event: WorkspaceRuntimeActivityEvent): void {
    const ws = this.states.get(event.workspaceId);
    if (!ws) return;
    const agent = ws.agents.get(event.agentId) ?? { turn: false, pendingPermissions: 0 };
    if (event.activity === "turn_started") agent.turn = true;
    if (event.activity === "turn_ended") agent.turn = false;
    if (event.activity === "permission_requested") agent.pendingPermissions++;
    if (event.activity === "permission_resolved") agent.pendingPermissions = Math.max(0, agent.pendingPermissions - 1);
    ws.agents.set(event.agentId, agent);
    ws.lastActivity = this.now();
  }

  async inspect(request: WorkspaceRuntimeWorkspaceRequest): Promise<WorkspaceRuntimeStatus> {
    const ws = this.workspace(request);
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    const sandbox = (await kube.listSandboxes(`${WORKSPACE_ID_LABEL}=${ws.id}`))[0];
    if (!sandbox) return { state: "absent" };
    if (sandbox.operatingMode === "Suspended") return { state: "suspended" };
    const pod = await kube.podInfo(sandbox.name).catch(() => null);
    if (pod?.ready && !pod.terminating) return { state: "running" };
    return { state: "resuming", ...(pod?.problem ? { message: pod.problem } : {}) };
  }

  /** The workspace was archived: its pod and volume go. */
  async destroy(request: WorkspaceRuntimeWorkspaceRequest): Promise<void> {
    const ws = this.workspace(request);
    await this.serial(ws, async () => {
      const config = await this.deps.getConfig();
      const kube = this.deps.kubeFor(config);
      ws.bridge?.close();
      for (const sandbox of await kube.listSandboxes(`${WORKSPACE_ID_LABEL}=${ws.id}`)) {
        await kube.delete("sandbox", sandbox.name);
        await kube.delete("pvc", workspaceClaimName(sandbox.name)).catch(() => undefined);
      }
      this.deps.registry?.delete(ws.id);
      this.states.delete(ws.id);
    });
  }

  /**
   * After a daemon restart, a plugin reload or a lost pod: forget what was set up in the pods, adopt the workspaces
   * Paseo lists, and delete the Sandbox of any workspace it no longer has (archived while the plugin was away).
   */
  async reconcile(request?: WorkspaceRuntimeReconcileRequest): Promise<void> {
    for (const ws of this.states.values()) {
      ws.bridge?.close();
      ws.bridge = undefined;
      ws.readyUid = undefined;
      ws.commands.clear();
    }
    await this.adopt().catch(() => undefined);
    if (!Array.isArray(request?.workspaces)) return; // an older Paseo calls reconcile without the list
    for (const listed of request.workspaces) {
      const ws = this.states.get(listed.workspaceId);
      if (ws) {
        ws.options = { ...ws.options, cwd: listed.cwd };
        ws.cwdFixed = true;
      } else {
        const options = parseRuntimeOptions({ ...(listed.options ?? {}), cwd: listed.cwd });
        this.newState(listed.workspaceId, { ...options, cwd: listed.cwd }).cwdFixed = true;
      }
    }
    if (!this.deps.daemonId) return;
    const live = new Set(request.workspaces.map((w) => w.workspaceId));
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    for (const sandbox of await kube.listSandboxes(`${DAEMON_LABEL}=${this.deps.daemonId}`).catch(() => [])) {
      const id = sandbox.labels[WORKSPACE_ID_LABEL];
      if (!id || live.has(id) || this.now() - (sandbox.createdAt ? Date.parse(sandbox.createdAt) : 0) < 5 * 60_000) continue;
      this.log(`[kubernetes-runtime] reconcile: deleting sandbox ${sandbox.name} (workspace ${id} no longer exists)`);
      const ws = this.states.get(id);
      ws?.bridge?.close();
      this.states.delete(id);
      this.deps.registry?.delete(id);
      await kube.delete("sandbox", sandbox.name).catch(() => undefined);
      await kube.delete("pvc", workspaceClaimName(sandbox.name)).catch(() => undefined);
    }
  }

  /** Whether a provider or MCP server binary exists in the pod. claude and codex are installed on first use, so they do. */
  async checkCommand(request: WorkspaceRuntimeCommandRequest): Promise<boolean> {
    const name = request.command.split("/").pop() ?? request.command;
    if (name in INSTALLABLE_CLIS) return true;
    const ws = this.workspace(request);
    if (!ws.sandbox || ws.phase !== "running") return true; // no pod to ask yet; the launch finds out
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    const found = await kube.exec(ws.sandbox, ["sh", "-c", 'export PATH="$HOME/bin:$HOME/.npm-global/bin:$PATH"; command -v "$1" >/dev/null 2>&1', "sh", request.command]);
    return found.code === 0;
  }

  async exec(request: WorkspaceRuntimeExecRequest, ctx: WorkspaceRuntimeContext & { signal: AbortSignal }): Promise<WorkspaceRuntimeProcess> {
    const ws = this.workspace(request);
    if (request.purpose === "probe") throw new Error("Probes run on the daemon host; the Kubernetes Runtime does not start them");
    // Git and other short tools Paseo runs for the workspace. A background refresh must not wake a suspended pod.
    if (request.purpose === "command" && request.interactive === false && ws.phase !== "running") {
      throw new Error("The pod is not running; background refreshes do not wake it");
    }
    ws.notice = ctx.notice;
    await this.serial(ws, () => this.ensureReady(ws, this.detached(ws, ctx), { command: request.purpose === "command" ? undefined : request.argv[0], env: request.env }));
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    const pod = ws.sandbox!;
    const envPath = await writeEnvFile(kube, pod, randomBytes(6).toString("hex"), request.env);
    const cwd = request.cwd ?? ws.options.cwd;
    const proc = kube.spawnExec(pod, ["sh", "-c", LAUNCH_SCRIPT, "sh", envPath, cwd, ...request.argv]);
    const abort = () => proc.kill();
    ctx.signal.addEventListener("abort", abort, { once: true });
    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1500);
    });
    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      signal: (signal) => proc.kill(signal),
      exit: proc.exit.then(async ({ code, signal }) => {
        ctx.signal.removeEventListener("abort", abort);
        // An exec that ends because the pod went away is the runtime's doing, not the process finishing.
        const info = await kube.podInfo(pod).catch(() => null);
        const lost = ws.phase === "suspended" || !info || !info.ready || info.terminating;
        if (code !== 0) {
          this.log(`[kubernetes-runtime] ${request.argv[0]} in ${pod} exited with ${code ?? signal}${lost ? " (pod lost or suspended)" : ""}${stderrTail.trim() ? `: ${scrub(stderrTail.trim())}` : ""}`);
        }
        if (lost && code !== 0) {
          // Our own idle suspension is a planned, clean stop (agents drop it quietly); a pod that vanished is not.
          if (ws.phase === "suspended") return { code, signal, reason: "suspended" as const, message: "The idle pod was suspended; the next message brings it back" };
          return { code, signal, reason: "runtime-lost" as const, message: "The pod was lost; the next message brings it back" };
        }
        return { code, signal, reason: "exited" as const };
      }),
    };
  }
}

/** A workspace slug from a directory name (for labelling and pod names of workspaces that inherited a runtime). */
function slugFor(cwd: string): string {
  const base = cwd.split("/").filter(Boolean).pop() ?? "workspace";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 63) || "workspace";
}
