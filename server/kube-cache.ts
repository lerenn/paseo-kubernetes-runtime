import type { AcpStream } from "@getpaseo/plugin/server/acp";
import type { Readable } from "node:stream";
import {
  Kubectl,
  type ClaimInfo,
  type ExecResult,
  type FreshnessOptions,
  type Kube,
  type ListableKind,
  type NamespaceRead,
  type ObjectInfo,
  type PodInfo,
  type PodProcess,
  type SandboxInfo,
} from "./kube.js";

/** A snapshot younger than this answers every pod and Sandbox read; tune it here. */
export const SNAPSHOT_TTL_MS = 5_000;
/** One snapshot call that takes longer is given up on (its callers fail like a failed `kubectl get` would). */
export const SNAPSHOT_TIMEOUT_MS = 30_000;

/** Counters of the kubectl processes the plugin starts, logged once a minute. */
export class KubeCallStats {
  snapshots = 0;
  direct = 0;
  hits = 0;
  totalMs = 0;
  maxMs = 0;
  timed = 0;

  recordSpawn(kind: "snapshot" | "direct", ms?: number): void {
    if (kind === "snapshot") this.snapshots += 1;
    else this.direct += 1;
    if (ms !== undefined) {
      this.timed += 1;
      this.totalMs += ms;
      this.maxMs = Math.max(this.maxMs, ms);
    }
  }

  /** The line for the last minute, resetting the counters; undefined when nothing ran. */
  take(): string | undefined {
    const { snapshots, direct, hits, totalMs, maxMs, timed } = this;
    this.snapshots = this.direct = this.hits = this.totalMs = this.maxMs = this.timed = 0;
    if (!snapshots && !direct && !hits) return undefined;
    return `[kubernetes-runtime] kube calls last minute: ${snapshots + direct} spawns (snapshots ${snapshots}, direct ${direct}), cache hits ${hits}, latency avg ${timed ? Math.round(totalMs / timed) : 0} ms max ${maxMs} ms`;
  }
}

export const kubeCallStats = new KubeCallStats();

/** `a=b,c=d` as pairs; null for any other selector syntax (sets, negation), which the cluster has to evaluate. */
export function parseEqualitySelector(selector: string): [string, string][] | null {
  const pairs: [string, string][] = [];
  for (const part of selector.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^([\w./-]+)==?([\w.-]*)$/.exec(part);
    if (!m) return null;
    pairs.push([m[1]!, m[2]!]);
  }
  return pairs;
}

const matches = (labels: Record<string, string>, pairs: [string, string][]) => pairs.every(([k, v]) => labels[k] === v);

interface Snap {
  at: number;
  read: NamespaceRead;
}

export interface CachedKubeOptions {
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  stats?: KubeCallStats;
}

/**
 * Pod and Sandbox reads of one namespace served from one shared `kubectl get pod,sandbox` instead of a kubectl
 * process per question. Concurrent readers share the call in flight, a snapshot younger than the TTL is reused, and
 * any write this object makes (or one that is in flight) drops it so the next read sees the change. Every other
 * call goes straight to kubectl and is only counted.
 */
export class CachedKube implements Kube {
  private snap: Snap | undefined;
  private inflight: { startedAt: number; generation: number; promise: Promise<Snap> } | undefined;
  /** Bumped by every write: a snapshot started before it cannot answer a read made after it. */
  private generation = 0;
  private snapGeneration = 0;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly stats: KubeCallStats;

  constructor(private readonly inner: Kube & { readNamespace(): Promise<NamespaceRead> }, options: CachedKubeOptions = {}) {
    this.ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.stats = options.stats ?? kubeCallStats;
  }

  get namespace(): string {
    return this.inner.namespace;
  }

  /** Drops the snapshot (and disowns the one in flight): the next read asks the cluster. */
  invalidate(): void {
    this.generation += 1;
    this.snap = undefined;
  }

  private async read(maxAgeMs: number | undefined): Promise<NamespaceRead> {
    const maxAge = maxAgeMs ?? this.ttlMs;
    const now = this.now();
    if (this.snap && this.snapGeneration === this.generation && now - this.snap.at < maxAge) {
      this.stats.hits += 1;
      return this.snap.read;
    }
    const flight = this.inflight;
    if (flight && flight.generation === this.generation && flight.startedAt >= now - maxAge) {
      this.stats.hits += 1;
      return (await flight.promise).read;
    }
    const generation = this.generation;
    const startedAt = now;
    const promise = this.fetch(startedAt);
    const entry = { startedAt, generation, promise };
    this.inflight = entry;
    const done = () => {
      if (this.inflight === entry) this.inflight = undefined;
    };
    promise.then(
      (snap) => {
        done();
        if (generation === this.generation) {
          this.snap = snap;
          this.snapGeneration = generation;
        }
      },
      done,
    );
    return (await promise).read;
  }

  private async fetch(startedAt: number): Promise<Snap> {
    const t0 = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = await Promise.race([
        this.inner.readNamespace(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`kubectl get pod,sandbox took longer than ${this.timeoutMs} ms`)), this.timeoutMs);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      return { at: startedAt, read };
    } finally {
      clearTimeout(timer);
      this.stats.recordSpawn("snapshot", Math.max(0, this.now() - t0));
    }
  }

  private async timed<T>(call: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    try {
      return await call();
    } finally {
      this.stats.recordSpawn("direct", Math.max(0, this.now() - t0));
    }
  }

  private async write<T>(call: () => Promise<T>): Promise<T> {
    this.invalidate(); // a read racing the write must not be served from before it
    try {
      return await this.timed(call);
    } finally {
      this.invalidate();
    }
  }

  async podInfo(name: string, options?: FreshnessOptions): Promise<PodInfo | null> {
    return (await this.read(options?.maxAgeMs)).pods.find((p) => p.name === name)?.pod ?? null;
  }

  async listSandboxes(selector: string, options?: FreshnessOptions): Promise<SandboxInfo[]> {
    const pairs = parseEqualitySelector(selector);
    if (!pairs) return this.timed(() => this.inner.listSandboxes(selector));
    return (await this.read(options?.maxAgeMs)).sandboxes.filter((s) => matches(s.labels, pairs));
  }

  async listObjects(kind: ListableKind, selector: string, options?: FreshnessOptions): Promise<ObjectInfo[]> {
    const pairs = kind === "pod" ? parseEqualitySelector(selector) : null;
    if (!pairs) return this.timed(() => this.inner.listObjects(kind, selector));
    return (await this.read(options?.maxAgeMs)).pods.filter((p) => matches(p.labels, pairs));
  }

  apply(manifest: Record<string, unknown>): Promise<void> {
    return this.write(() => this.inner.apply(manifest));
  }

  patchSandbox(name: string, patch: Record<string, unknown>): Promise<void> {
    return this.write(() => this.inner.patchSandbox(name, patch));
  }

  label(kind: "pod" | "pvc", name: string, labels: Record<string, string>, annotations?: Record<string, string>): Promise<void> {
    return this.write(() => this.inner.label(kind, name, labels, annotations));
  }

  annotatePod(name: string, set: Record<string, string>, remove?: string[]): Promise<void> {
    return this.write(() => this.inner.annotatePod(name, set, remove));
  }

  delete(kind: string, name: string): Promise<void> {
    return this.write(() => this.inner.delete(kind, name));
  }

  applySecretKey(secret: string, key: string, manifest: string): Promise<void> {
    return this.timed(() => this.inner.applySecretKey(secret, key, manifest));
  }

  removeSecretKey(secret: string, key: string): Promise<void> {
    return this.timed(() => this.inner.removeSecretKey(secret, key));
  }

  listClaims(selector?: string): Promise<ClaimInfo[]> {
    return this.timed(() => this.inner.listClaims(selector));
  }

  exec(pod: string, argv: string[]): Promise<ExecResult> {
    return this.timed(() => this.inner.exec(pod, argv));
  }

  execInput(pod: string, argv: string[], input: Readable): Promise<ExecResult> {
    return this.timed(() => this.inner.execInput(pod, argv, input));
  }

  execStream(pod: string, argv: string[]): AcpStream {
    this.stats.recordSpawn("direct");
    return this.inner.execStream(pod, argv);
  }

  spawnExec(pod: string, argv: string[]): PodProcess {
    this.stats.recordSpawn("direct");
    return this.inner.spawnExec(pod, argv);
  }
}

const shared = new Map<string, CachedKube>();

/** The one CachedKube of a context and namespace: the runtime, the status screen and the reaper must share its snapshot and its invalidations. */
export function sharedKube(c: { context?: string; namespace: string }): CachedKube {
  const key = `${c.context ?? ""}\u0000${c.namespace}`;
  let kube = shared.get(key);
  if (!kube) {
    kube = new CachedKube(new Kubectl({ context: c.context, namespace: c.namespace }));
    shared.set(key, kube);
  }
  return kube;
}
