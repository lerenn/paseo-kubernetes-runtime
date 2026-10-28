import type { PodRow } from "../shared/status.js";
import { LastGood, SingleFlightCache, type Snapshot } from "./coalesce.js";
import type { DockerStatus } from "./docker-sandbox.js";
import type { OomEntry } from "./oom.js";
import { buildPodRows, type AgentSummary, type ClusterRead } from "./status.js";
import type { PodEntry } from "./registry.js";

export const STATUS_TTL_MS = 7_000;
/** A caller never waits longer than this for a refresh it started when it has an older snapshot to give. */
export const STATUS_SOFT_MS = 8_000;
const DAEMON_READ_MS = 6_000;
const CLUSTER_READ_MS = 8_000;
const DOCKER_READ_MS = 4_000;

/** What the Runtime screen shows besides the pod rows (the reaper and auto-archive parts are cheap and read fresh by the caller). */
export interface StatusSources {
  titles(): Promise<Map<string, string> | null>;
  agents(): Promise<AgentSummary[] | null>;
  cluster(): Promise<ClusterRead | null>;
  docker(): Promise<Map<string, DockerStatus>>;
  entries(): readonly PodEntry[];
  oom(): ReadonlyMap<string, OomEntry>;
  log?(line: string): void;
  now?: () => number;
}

/**
 * The pod rows of the Runtime screen, read once at a time and kept a few seconds: the screens poll, and each read asks
 * the Paseo daemon (slow when it is busy) and the cluster. Every source has its own timeout and falls back to its
 * last good answer, so one slow part never blocks the RPC.
 */
export class PodRowsService {
  private readonly cache: SingleFlightCache<PodRow[]>;
  private readonly titles: LastGood<Map<string, string>>;
  private readonly agents: LastGood<AgentSummary[]>;
  private readonly cluster: LastGood<ClusterRead>;
  private readonly docker: LastGood<Map<string, DockerStatus>>;

  constructor(private readonly src: StatusSources, opts: { ttlMs?: number; softMs?: number; daemonMs?: number; clusterMs?: number; dockerMs?: number } = {}) {
    const now = src.now ?? Date.now;
    this.cache = new SingleFlightCache(opts.ttlMs ?? STATUS_TTL_MS, opts.softMs ?? STATUS_SOFT_MS, now);
    this.titles = new LastGood(opts.daemonMs ?? DAEMON_READ_MS, now);
    this.agents = new LastGood(opts.daemonMs ?? DAEMON_READ_MS, now);
    this.cluster = new LastGood(opts.clusterMs ?? CLUSTER_READ_MS, now);
    this.docker = new LastGood(opts.dockerMs ?? DOCKER_READ_MS, now);
  }

  async rows(): Promise<Snapshot<PodRow[]>> {
    return this.cache.get(() => this.read());
  }

  private async read(): Promise<PodRow[]> {
    const [titles, agents, cluster, docker] = await Promise.all([
      this.titles.read(() => this.src.titles()),
      this.agents.read(() => this.src.agents()),
      this.cluster.read(() => this.src.cluster()),
      this.docker.read(() => this.src.docker()),
    ]);
    const late = [titles.stale && "workspaces", agents.stale && "agents", cluster.stale && "cluster", docker.stale && "docker"].filter(Boolean);
    if (late.length) this.src.log?.(`[kubernetes-runtime] status: ${late.join(", ")} slow or unavailable, using the last good value`);
    if (!cluster.value) throw new Error("the cluster could not be read in time and there is no earlier answer");
    return buildPodRows({
      ...cluster.value,
      entries: this.src.entries(),
      titles: titles.value ?? null,
      agents: agents.value ?? null,
      oom: this.src.oom(),
      docker: docker.value,
    });
  }
}
