import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { parseRuntimeOptions, type RuntimeOptions } from "../shared/runtime-options.js";
import { applyFetch, fetchTargets, otherRepoTarget, pushToMirror, type FetchTarget } from "./mirrors.js";
import { applyPush, loopbackPorts, startBridge, type RunningBridge } from "./bridge.js";
import type { KubernetesRuntimeConfig } from "./config.js";
import { type GitRunner, runGit, scrub } from "./git.js";
import type { Kube, PodProcess, SandboxInfo } from "./kube.js";
import { INSTALLABLE_CLIS, LAUNCH_SCRIPT } from "./pod-assets.js";
import { ensureCommand, ensureJq, initSubmodules, installAssets, seedWorkspace, setupMirrors, submodulesPending, writeEnvFile } from "./pod-setup.js";
import { waitPodReady } from "./pod-wait.js";
import { paseoWorkspaceBusy } from "./orphans.js";
import { WARM_PREFIX, shortImage } from "./status.js";
import { PodRegistry, type PodState } from "./registry.js";
import type {
  WorkspaceRuntimeActivityEvent,
  WorkspaceRuntimeCommandRequest,
  WorkspaceRuntimeDisplay,
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
  LAYOUT_ANNOTATION,
  MAPPED_CHECKOUT,
  STATE_LABEL,
  WARM_STATE,
  claimPatch,
  warmSandboxName,
  HOME_DIR,
  REPO_LABEL,
  WORKSPACE_ID_LABEL,
  WORKSPACE_LABEL,
  buildSandbox,
  metaPatch,
  type PodMeta,
  type PodState as MetaState,
  resumePatch,
  serviceAccountFor,
  SERVICE_ACCOUNT_LABEL,
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
  /** Archives a workspace in Paseo (the delete action's option); injected for tests. */
  archiveWorkspace?: (workspaceId: string) => Promise<void>;
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
  /** Where the checkout is in the pod: at the daemon's own path (legacy) or at MAPPED_CHECKOUT, with Paseo rewriting paths (mapCwd). Fixed when the pod is created. */
  layout?: "legacy" | "mapped";
  /** The directory came from the workspace itself (`create`'s cwd or the Sandbox), not from options an inherited runtime copied. */
  cwdFixed?: boolean;
  /** What the Sandbox, pod and claim were last labelled with, so they are only patched when it changes. */
  repo?: string;
  repoUrl?: string;
  agent?: string;
  labelled?: string;
  /** When labelling the pod or claim last failed (missing `patch` in the Role); retried after a while. */
  labelFailedAt?: number;
  /** The image the pod was started with, for the sidebar badge; known once the Sandbox has been read or created. */
  image?: string;
  /** The submodule checkout running in the background, if any. */
  submodulesJob?: Promise<void>;
  /** Consecutive reconnects of the bridge channel, for backoff. */
  bridgeRetries: number;
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
  private stopped = false;
  /** Provider processes started in pods and not yet finished. */
  private readonly execs = new Set<{ ws: WorkspaceState; proc: PodProcess; exited: Promise<unknown>; /** Ended on purpose by a suspend: reported as the planned `suspended` exit, whatever happens to the workspace afterwards. */ planned: boolean }>();
  private readonly states = new Map<string, WorkspaceState>();
  private stopTicker: () => void = () => undefined;
  private readonly git: GitRunner;
  private readonly now: () => number;

  constructor(private readonly deps: RuntimeDeps) {
    this.git = deps.git ?? runGit;
    this.now = deps.now ?? Date.now;
    this.lastDemand = this.now();
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  /** Starts the idle timer and picks up the pods a previous plugin run left running. */
  async start(): Promise<void> {
    const tick = () => {
      void this.checkIdle().catch(() => undefined);
      void this.maintainPool().catch(() => undefined);
    };
    this.stopTicker = (this.deps.ticker ?? ((fn, ms) => {
      const timer = setInterval(fn, ms) as unknown as NodeJS.Timeout;
      timer.unref?.();
      return () => clearInterval(timer);
    }))(tick, 30_000);
    await this.adopt().catch(() => undefined);
    void this.maintainPool().catch(() => undefined);
  }

  /**
   * The plugin is stopping (an update, a reload, the daemon going down). The provider processes die with it; end them
   * here so each reports the planned `suspended` exit before the channel to Paseo closes, which lets an idle agent drop
   * the process quietly instead of showing "Claude stopped unexpectedly". A turn running at that moment still fails.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopTicker();
    const running = [...this.execs];
    for (const e of running) e.proc.kill("SIGTERM");
    await Promise.race([Promise.allSettled(running.map((e) => e.exited)), new Promise((r) => setTimeout(r, 3_000).unref?.())]);
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
      ws.image = sandbox.image;
      ws.layout = sandbox.annotations[LAYOUT_ANNOTATION] === "mapped" ? "mapped" : "legacy";
      ws.cwdFixed = true;
      this.setPhase(ws, sandbox.operatingMode === "Suspended" ? "suspended" : "running");
      // A pod that runs when the plugin starts had its bridge (and with it the loopback tunnels its agents' MCP
      // servers use) die with the previous plugin process: bring it back without waiting for the next launch.
      if (sandbox.operatingMode !== "Suspended") void this.restoreBridge(kube, ws).catch(() => undefined);
    }
  }

  /** Ports the pod's processes still point at (`http://127.0.0.1:<port>` in their arguments or environment). */
  private async tunnelPortsInUse(kube: Kube, pod: string): Promise<number[]> {
    const r = await kube.exec(pod, [
      "sh",
      "-c",
      `for f in /proc/[0-9]*/cmdline /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$f" 2>/dev/null; done | grep -o 'http://127\\.0\\.0\\.1:[0-9]*' | sed 's/.*://' | sort -u`,
    ]);
    return r.code === 0 ? r.stdout.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536) : [];
  }

  private async restoreBridge(kube: Kube, ws: WorkspaceState): Promise<void> {
    const pod = ws.sandbox;
    if (!pod || ws.bridge) return;
    const info = await kube.podInfo(pod).catch(() => null);
    if (!info?.ready || info.terminating) return;
    await this.serial(ws, async () => {
      if (ws.bridge || ws.phase !== "running") return;
      for (const port of await this.tunnelPortsInUse(kube, pod)) ws.wantPorts.add(port);
      ws.readyUid = info.uid;
      this.startBridge(kube, ws, new Set([...ws.ports, ...ws.wantPorts]));
      await this.refreshTargets(kube, ws, pod).catch(() => undefined);
    });
  }

  private newState(id: string, options: RuntimeOptions): WorkspaceState {
    const ws: WorkspaceState = {
      id,
      options,
      phase: "none",
      ports: new Set(),
      wantPorts: new Set(),
      bridgeRetries: 0,
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
    const before = ws.phase;
    ws.phase = phase;
    // Paseo asks `describeWorkspace` again after a notice for the workspace: this keeps the badge's state current
    if (before !== "none" && before !== phase && (phase === "running" || phase === "suspended")) this.stateChanged(ws, `The pod is ${phase}.`);
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
    const { cwd } = ws.options; // on the daemon
    const root = this.podRoot(ws); // in the pod
    const present = await kube.exec(pod, ["test", "-d", `${root}/.git`]);
    if (present.code === 0) return;
    ctx.notice("Copying the project into the pod...");
    const repo = await (this.deps.detectRepo ?? detectRepo)(cwd);
    const plan = clonePlan(ws.options);
    const made = await (this.deps.seeder ?? this.defaultSeeder)(cwd, plan, repo.branch);
    try {
      await this.refreshTargets(kube, ws, pod, [made.seed.sha]);
      await seedWorkspace(kube, pod, made.seed, made.bundle, {
        dir: root,
        originUrl: repo.url,
        identity: await this.identity(cwd),
        newBranch: plan?.action === "branch-off" && plan.slug ? plan.slug : undefined,
      });
      await made.done;
      // origin/<branch> exists from the start (no "gone" upstream in git status); best effort
      await kube.exec(pod, ["git", "-C", root, "fetch", "-q", "origin"]).catch(() => undefined);
    } finally {
      await made.release().catch(() => undefined);
    }
  }

  /**
   * Checks out the submodules in the background so the agent can start at once (a project with many submodules took
   * over half a minute). Also resumes an interrupted checkout after a suspend; only one runs at a time.
   */
  private startSubmodules(kube: Kube, ws: WorkspaceState, pod: string): void {
    if (ws.submodulesJob) return;
    const cwd = this.podRoot(ws);
    const notice = (message: string, level?: "info" | "warning" | "error") => ws.notice?.(message, level);
    ws.submodulesJob = (async () => {
      if (!(await submodulesPending(kube, pod, cwd))) return;
      notice("Fetching the submodules in the background...");
      const r = await initSubmodules(kube, pod, cwd, ws.targets);
      if (r.ok) notice("Submodules are ready.");
      else notice(`Could not fetch the submodules (run \`git submodule update --init\` in the pod to retry): ${r.message}`, "warning");
    })()
      .catch(() => undefined)
      .finally(() => {
        ws.submodulesJob = undefined;
      });
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
    await setupMirrors(kube, pod, this.podRoot(ws), await this.identity(cwd), ws.targets, access.enabled ? access.hosts : []);
  }

  private defaultSeeder = async (cwd: string, plan: ClonePlan | null, currentBranch: string): Promise<SeedBundle> => {
    const seed = await createSeed(this.git, cwd, plan, currentBranch);
    const { stream, done } = seedBundle(cwd, seed);
    return { seed, bundle: stream, done, release: () => releaseSeed(this.git, cwd, seed) };
  };

  private startBridge(kube: Kube, ws: WorkspaceState, ports: Set<number>): void {
    ws.bridge?.close();
    ws.ports = ports;
    const startedAt = this.now();
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
      {
        mapPort: this.deps.mapTunnelPort,
        onEnd: () => {
          // the channel to the pod's bridge ended (a network blip, a restarted API server): bring it back while the pod runs
          if (ws.bridge !== bridge || ws.phase !== "running" || this.stopped) return;
          ws.bridge = undefined;
          // one that lived a while was healthy: start the backoff over
          if (this.now() - startedAt > 60_000) ws.bridgeRetries = 0;
          const attempt = ws.bridgeRetries++;
          const delay = Math.min(30_000, 2_000 * 2 ** attempt);
          const timer = setTimeout(() => void this.restoreBridge(kube, ws).catch(() => undefined), delay);
          (timer as { unref?: () => void }).unref?.();
        },
      },
    );
    const bridge = ws.bridge;
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
    for (const port of loopbackPorts((need.mcpServers ?? {}) as Record<string, { type: string; url?: string }>)) ws.wantPorts.add(port);
    const wanted = new Set([...ws.ports, ...ws.wantPorts]);
    const grows = [...wanted].some((p) => !ws.ports.has(p));

    this.lastDemand = this.now();
    if (config.warmPool.enabled && config.warmPool.idleMinutes > 0) void this.maintainPool().catch(() => undefined); // somebody needs a pod: bring the pool back if it had idled out
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
      const layout = await this.layoutFor(ws);
      const repo = await (this.deps.detectRepo ?? detectRepo)(cwd);
      ws.repo = repoName(repo.url);
      ws.repoUrl = repo.url;
      const serviceAccount = serviceAccountFor(config, this.agentLabels(ws));
      // a running pod cannot change ServiceAccount, so only a pod without one is taken from the warm pool
      const warm = layout === "mapped" && !serviceAccount ? await this.claimWarm(kube, config, ws) : undefined;
      if (warm) {
        ctx.notice("Using a pod that was already running...");
        ws.sandbox = warm.name;
        ws.image = warm.image ?? config.image;
        ws.labelled = this.metaKey(this.meta(ws, "running"));
        void this.maintainPool().catch(() => undefined); // start the next one
      } else {
        ctx.notice("Starting the pod...");
        const name = sandboxName(ws.id, repoName(repo.url), ws.options.slug);
        await kube.apply(buildSandbox({ name, workspaceId: ws.id, cwd, layout, config, daemonId: this.deps.daemonId, meta: this.meta(ws, "running"), serviceAccount }));
        ws.labelled = this.metaKey(this.meta(ws, "running"));
        ws.sandbox = name;
        ws.image = config.image;
      }
    } else {
      ws.sandbox = sandbox.name;
      ws.image = sandbox.image ?? ws.image;
      ws.layout = sandbox.annotations[LAYOUT_ANNOTATION] === "mapped" ? "mapped" : "legacy";
      ws.repo ??= sandbox.labels[REPO_LABEL];
      if (sandbox.operatingMode === "Suspended") {
        ctx.notice("Resuming the pod...");
        this.setPhase(ws, "resuming");
        await kube.patchSandbox(sandbox.name, resumePatch(config, ws.layout === "mapped" ? undefined : cwd, this.resumeServiceAccount(config, ws, sandbox)));
        ws.image = config.image; // a resumed pod starts with the current image
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
      this.startSubmodules(kube, ws, pod);
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
      const payload = Buffer.from(JSON.stringify({ op, root: this.podRoot(ws), path: request.path, ...extra }));
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
    this.setPhase(ws, "suspended");
    // End the provider processes ourselves first and wait for their exits to be reported as the planned stop. Left
    // to the pod's deletion they die 30 s later, and by then a Git poll may already have resumed the workspace, so
    // the exit would read as a lost pod and the agent would show an error.
    const mine = [...this.execs].filter((e) => e.ws === ws);
    for (const e of mine) {
      e.planned = true;
      e.proc.kill("SIGTERM");
    }
    await Promise.race([Promise.allSettled(mine.map((e) => e.exited)), new Promise((r) => setTimeout(r, 5_000).unref?.())]);
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
        // An agent between turns can still be waiting on a background shell, a timer or a watch inside its process
        // (it shows as idle); suspending would kill that work. Live children of a claude/codex process mean busy.
        const background = running === false ? await this.hasBackgroundWork(ws).catch(() => true) : false;
        if (running !== false || background) {
          ws.lastActivity = this.now();
          continue;
        }
        await this.serial(ws, () => this.suspend(ws)).catch(() => undefined);
      }
    }
  }

  /**
   * What the sidebar shows beside the runtime icon: the image's short name, with the pod and its state in the tooltip
   * and the header. Answered from what is already known: it never starts or reads the pod.
   */
  describeWorkspace(request: WorkspaceRuntimeWorkspaceRequest): WorkspaceRuntimeDisplay | null {
    const ws = this.states.get(request.workspaceId);
    if (!ws?.sandbox) return { label: "no pod yet", detail: "Kubernetes pod · not started yet" };
    const short = shortImage(ws.image);
    const name = short?.split("@")[0]?.split(":")[0];
    const state = ws.phase === "resuming" ? "starting" : ws.phase === "none" ? "unknown" : ws.phase;
    return {
      label: name ?? "pod",
      tooltip: [
        `Pod ${ws.sandbox}`,
        `State: ${state}`,
        ...(ws.image ? [`Image: ${ws.image}`] : []),
        ...(ws.repo ? [`Repository: ${ws.repo}`] : []),
      ].join("\n"),
      detail: [name ?? "pod", ws.sandbox, state].join(" · "),
    };
  }

  /** Tells Paseo to ask `describeWorkspace` again: the pod changed state. */
  private stateChanged(ws: WorkspaceState, message: string): void {
    ws.notice?.(message);
  }

  /** Whether a provider process in the pod has live child processes (background shells and timers of an idle agent). */
  private async hasBackgroundWork(ws: WorkspaceState): Promise<boolean> {
    if (!ws.sandbox) return false;
    const config = await this.deps.getConfig();
    const r = await this.deps.kubeFor(config).exec(ws.sandbox, ["ps", "-eo", "pid=,ppid=,stat=,args="]);
    if (r.code !== 0) return true; // cannot tell: keep the pod
    return liveProviderChildren(r.stdout);
  }

  /** Pods that run ahead of any workspace, oldest first. */
  private async warmPods(kube: Kube, config: KubernetesRuntimeConfig): Promise<SandboxInfo[]> {
    if (!this.deps.daemonId) return [];
    const all = await kube.listSandboxes(`${DAEMON_LABEL}=${this.deps.daemonId},${STATE_LABEL}=${WARM_STATE}`);
    return all.sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
  }

  /**
   * Gives a new workspace a pod that is already running: relabels the Sandbox (and its volume claim) for the
   * workspace. Only one claim at a time; a warm pod with another image than today's is not used.
   */
  private async claimWarm(kube: Kube, config: KubernetesRuntimeConfig, ws: WorkspaceState): Promise<SandboxInfo | undefined> {
    if (!config.warmPool.enabled) return undefined;
    const run = this.claims.then(async () => {
      for (const warm of await this.warmPods(kube, config)) {
        if (warm.image !== config.image || warm.operatingMode !== "Running") continue;
        const info = await kube.podInfo(warm.name).catch(() => null);
        if (!info?.ready || info.terminating) continue;
        const meta = this.meta(ws, "running");
        await kube.patchSandbox(warm.name, claimPatch(ws.id, ws.options.cwd, meta, config));
        const { labels, annotations } = claimPatch(ws.id, ws.options.cwd, meta, config).metadata as { labels: Record<string, string>; annotations: Record<string, string> };
        await kube.label("pvc", workspaceClaimName(warm.name), labels, annotations).catch(() => undefined);
        return warm;
      }
      return undefined;
    });
    this.claims = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  /** Labels of the first agent seen in each workspace, recorded before its session opens (see `noteAgent`). */
  private readonly firstAgentLabels = new Map<string, Record<string, string>>();

  /** Called before an agent's session opens: the first agent of a workspace decides its pod's ServiceAccount. */
  noteAgent(workspaceId: string, labels: Record<string, string> | undefined): void {
    if (labels && !this.firstAgentLabels.has(workspaceId)) this.firstAgentLabels.set(workspaceId, labels);
  }

  private agentLabels(ws: WorkspaceState): Record<string, string> | undefined {
    return ws.options.labels ?? this.firstAgentLabels.get(ws.id);
  }

  /** On resume the pod keeps its ServiceAccount unless the labels are known and say otherwise (after a daemon restart they are not). */
  private resumeServiceAccount(config: KubernetesRuntimeConfig, ws: WorkspaceState, sandbox: SandboxInfo): string | undefined {
    const labels = this.agentLabels(ws);
    return labels ? serviceAccountFor(config, labels) : sandbox.labels[SERVICE_ACCOUNT_LABEL];
  }

  private claims: Promise<unknown> = Promise.resolve();
  /** When a workspace or an agent last needed a pod (ms): the warm pool's idle timeout counts from here. */
  private lastDemand = 0;

  /** Keeps `warmPool.size` pods running ahead of workspaces (and removes them all, or stale ones, when the pool is off or the image changed). */
  async maintainPool(): Promise<void> {
    if (!this.deps.daemonId || this.stopped) return;
    const config = await this.deps.getConfig();
    const kube = this.deps.kubeFor(config);
    const warm = await this.warmPods(kube, config);
    const keep: SandboxInfo[] = [];
    for (const pod of warm) {
      const stale = !config.warmPool.enabled || pod.image !== config.image || keep.length >= config.warmPool.size;
      if (stale) {
        this.log(`[kubernetes-runtime] removing warm pod ${pod.name} (${config.warmPool.enabled ? "stale or surplus" : "pool is off"})`);
        await kube.delete("sandbox", pod.name).catch(() => undefined);
        await kube.delete("pvc", workspaceClaimName(pod.name)).catch(() => undefined);
      } else keep.push(pod);
    }
    if (!config.warmPool.enabled) return;
    // Nobody started a workspace or an agent for a while: let the warm pod go and do not replace it until someone does
    const { idleMinutes } = config.warmPool;
    if (idleMinutes > 0 && this.now() - this.lastDemand > idleMinutes * 60_000) {
      for (const pod of keep) {
        this.log(`[kubernetes-runtime] removing warm pod ${pod.name} (idle for ${idleMinutes} min)`);
        await kube.delete("sandbox", pod.name).catch(() => undefined);
        await kube.delete("pvc", workspaceClaimName(pod.name)).catch(() => undefined);
      }
      return;
    }
    for (let i = keep.length; i < config.warmPool.size; i++) {
      const name = warmSandboxName();
      this.log(`[kubernetes-runtime] starting warm pod ${name}`);
      await kube.apply(buildSandbox({ name, config, daemonId: this.deps.daemonId, warm: true }));
    }
  }

  /** The workspace's directory as the pod sees it. */
  private podRoot(ws: WorkspaceState): string {
    return ws.layout === "mapped" ? MAPPED_CHECKOUT : ws.options.cwd;
  }

  /** New pods are mapped when the warm pool is on (so they can be started ahead of their workspace), legacy otherwise. */
  private async layoutFor(ws: WorkspaceState): Promise<"legacy" | "mapped"> {
    ws.layout ??= (await this.deps.getConfig()).warmPool.enabled ? "mapped" : "legacy";
    return ws.layout;
  }

  /** The registration Paseo's fork takes. */
  registration(): WorkspaceRuntimeRegistration {
    return {
      id: "kubernetes",
      label: RUNTIME_LABEL,
      icon: "icons/ship-wheel.svg", // the Lucide ship wheel, shown beside the workspace's host in the sidebar
      describe: () => ({ protocolVersion: 1, capabilities: { pipes: true, pty: false } }),
      create: async (request) => {
        this.workspace(request); // validates the options; nothing exists in the cluster until a process is about to start
      },
      inspect: (request) => this.inspect(request),
      describeWorkspace: (request) => this.describeWorkspace(request),
      mapCwd: async (request) => {
        const ws = this.workspace(request);
        return (await this.layoutFor(ws)) === "mapped" ? MAPPED_CHECKOUT : ws.options.cwd;
      },
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
    await this.destroyWorkspace(this.workspace(request));
  }

  /** Why this workspace's pod must not be taken down right now, or null: an agent is running, or one waits on background work. */
  async busyReason(ws: WorkspaceState): Promise<string | null> {
    const running = await (this.deps.workspaceBusy ?? paseoWorkspaceBusy)(ws.options.cwd).catch(() => null);
    if (running === true) return "an agent is running in this workspace";
    if (running === null) return "Paseo could not say whether an agent is running in this workspace";
    if (ws.phase === "running" && (await this.hasBackgroundWork(ws).catch(() => true))) return "an agent has a background command running in the pod";
    return null;
  }

  /**
   * The screen's per-pod actions. A pod with a running agent (or background work) is only touched with `force`;
   * without it the answer says what is running so the screen can ask first.
   */
  async podAction(
    workspaceId: string,
    action: "suspend" | "resume" | "restart" | "delete",
    options: { force?: boolean; archive?: boolean } = {},
  ): Promise<{ ok: boolean; busy?: string; message?: string }> {
    if (workspaceId.startsWith(WARM_PREFIX)) {
      // a warm pod belongs to no workspace: the only action is to remove it (the pool starts another if it is still on)
      if (action !== "delete") return { ok: false, message: "A warm pod can only be deleted." };
      const name = workspaceId.slice(WARM_PREFIX.length);
      const config = await this.deps.getConfig();
      const kube = this.deps.kubeFor(config);
      await kube.delete("sandbox", name);
      await kube.delete("pvc", workspaceClaimName(name)).catch(() => undefined);
      return { ok: true };
    }
    if (!this.states.has(workspaceId)) await this.adopt().catch(() => undefined);
    const ws = this.states.get(workspaceId);
    if (!ws?.sandbox) return { ok: false, message: "This workspace has no pod." };
    const quiet = { notice: () => undefined, signal: new AbortController().signal };
    const guard = async (): Promise<{ ok: false; busy: string } | null> => {
      if (options.force) return null;
      const busy = await this.busyReason(ws);
      return busy ? { ok: false, busy } : null;
    };
    if (action === "resume") {
      if (ws.phase === "running") return { ok: true, message: "The pod is already running." };
      await this.serial(ws, () => this.ensureReady(ws, this.detached(ws, quiet), {}));
      return { ok: true };
    }
    if (action === "suspend" || action === "restart") {
      if (ws.phase === "running") {
        const busy = await guard();
        if (busy) return busy;
        await this.serial(ws, () => this.suspend(ws));
      } else if (action === "suspend") {
        return { ok: true, message: "The pod is not running." };
      }
      if (action === "restart") await this.serial(ws, () => this.ensureReady(ws, this.detached(ws, quiet), {}));
      return { ok: true };
    }
    // delete
    if (ws.phase === "running") {
      const busy = await guard();
      if (busy) return busy;
    }
    await this.destroyWorkspace(ws);
    if (options.archive) await (this.deps.archiveWorkspace ?? paseoArchiveWorkspace)(workspaceId).catch(() => undefined);
    return { ok: true };
  }

  private async destroyWorkspace(ws: WorkspaceState): Promise<void> {
    this.firstAgentLabels.delete(ws.id);
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
    const cwd = request.cwd ?? this.podRoot(ws); // already the pod's path: Paseo maps it with mapCwd
    const proc = kube.spawnExec(pod, ["sh", "-c", LAUNCH_SCRIPT, "sh", envPath, cwd, ...request.argv]);
    const abort = () => proc.kill();
    ctx.signal.addEventListener("abort", abort, { once: true });
    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1500);
    });
    const tracked = { ws, proc, exited: undefined as unknown as Promise<unknown>, planned: false };
    const exit = proc.exit.then(async ({ code, signal }) => {
        ctx.signal.removeEventListener("abort", abort);
        // Ended by us on purpose (the plugin stopping, or an idle suspend): a planned stop, answered at once, no cluster calls
        if ((this.stopped || tracked.planned) && code !== 0) return { code, signal, reason: "suspended" as const, message: this.stopped ? "The Kubernetes Runtime plugin restarted; the next message brings the agent back" : "The idle pod was suspended; the next message brings it back" };
        // An exec that ends because the pod went away is the runtime's doing, not the process finishing.
        const info = await kube.podInfo(pod).catch(() => null);
        const lost = ws.phase === "suspended" || !info || !info.ready || info.terminating;
        if (code !== 0) {
          this.log(`[kubernetes-runtime] ${request.argv[0]} in ${pod} exited with ${code ?? signal}${lost ? " (pod lost or suspended)" : ""}${stderrTail.trim() ? `: ${scrub(stderrTail.trim())}` : ""}`);
        }
        if (lost && code !== 0) {
          if (ws.phase === "suspended") return { code, signal, reason: "suspended" as const, message: "The idle pod was suspended; the next message brings it back" };
          return { code, signal, reason: "runtime-lost" as const, message: "The pod was lost; the next message brings it back" };
        }
        return { code, signal, reason: "exited" as const };
    });
    tracked.exited = exit;
    this.execs.add(tracked);
    void exit.finally(() => this.execs.delete(tracked));
    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      signal: (signal) => proc.kill(signal),
      exit,
    };
  }
}

/** A workspace slug from a directory name (for labelling and pod names of workspaces that inherited a runtime). */
function slugFor(cwd: string): string {
  const base = cwd.split("/").filter(Boolean).pop() ?? "workspace";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 63) || "workspace";
}

/**
 * True when a `claude` or `codex` process listed by `ps -eo pid=,ppid=,stat=,args=` has a living (not zombie)
 * descendant: its agent is running background work even if Paseo shows it idle.
 */
export function liveProviderChildren(psOutput: string): boolean {
  const rows = psOutput
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3]!, args: m[4]! }));
  const provider = new Set(rows.filter((r) => /^(claude|codex)(\s|$)/.test(r.args)).map((r) => r.pid));
  if (provider.size === 0) return false;
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  return rows.some((r) => {
    if (r.stat.startsWith("Z") || provider.has(r.pid)) return false;
    for (let at = byPid.get(r.ppid), hops = 0; at && hops < 20; at = byPid.get(at.ppid), hops++) {
      if (provider.has(at.pid)) return true;
    }
    return false;
  });
}

async function paseoArchiveWorkspace(workspaceId: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => execFile("paseo", ["workspace", "archive", workspaceId], { timeout: 30_000 }, (e) => (e ? reject(e) : resolve())));
}
