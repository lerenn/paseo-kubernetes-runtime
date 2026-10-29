import type { Kube, PodInfo, SandboxInfo } from "./kube.js";

export interface WaitOptions {
  timeoutSeconds: number;
  pollMs?: number;
  /** Called when the reason the pod is not ready changes (for example it cannot be scheduled yet). */
  onProblem?: (message: string) => void;
  /** Reads the pod's Sandbox; its Ready condition says why no pod exists (for example the namespace quota is full). */
  sandbox?: () => Promise<SandboxInfo | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface QuotaBlock {
  quota: string;
  resource: string;
  requested: string;
  used?: string;
  limited?: string;
}

const pairs = (text: string | undefined) =>
  Object.fromEntries([...(text ?? "").matchAll(/([\w./-]+)=([^,\s]+)/g)].map((m) => [m[1]!, m[2]!]));

/** Quantity in base units (Ki/Mi/Gi/Ti, m, plain), or undefined when it is not one we read. */
function quantity(q: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti)?$/.exec(q ?? "");
  if (!m) return undefined;
  const unit = { m: 1e-3, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }[m[2] as "m"] ?? 1;
  return Number(m[1]) * unit;
}

/**
 * Reads the Sandbox's Ready condition: when the controller could not create the pod because the namespace
 * ResourceQuota is full, says which quota and resource. Undefined for any other condition.
 */
export function parseQuotaBlock(ready: SandboxInfo["ready"]): QuotaBlock | undefined {
  if (!ready || ready.reason !== "ReconcilerError" || !ready.message?.includes("exceeded quota")) return undefined;
  const message = ready.message;
  const quota = /exceeded quota: ([^,\s]+)/.exec(message)?.[1];
  const section = (name: string) => new RegExp(`${name}: (.*?)(?=, (?:requested|used|limited): |$)`, "s").exec(message)?.[1];
  const requested = pairs(section("requested"));
  const used = pairs(section("used"));
  const limited = pairs(section("limited"));
  const resources = Object.keys(requested);
  if (!quota || !resources.length) return undefined;
  // a quota with several resources: name the one that does not fit
  const resource =
    resources.find((r) => {
      const [need, have, cap] = [quantity(requested[r]), quantity(used[r]), quantity(limited[r])];
      return need !== undefined && have !== undefined && cap !== undefined && have + need > cap;
    }) ?? resources[0]!;
  return { quota, resource, requested: requested[resource]!, used: used[resource], limited: limited[resource] };
}

/** "namespace quota 'agents' is full (requests.memory 35Gi of 40Gi used, this pod needs 8Gi)" */
function quotaDetail(block: QuotaBlock): string {
  return block.used && block.limited ? `${block.resource} ${block.used} of ${block.limited} used, this pod needs ${block.requested}` : `${block.resource}, this pod needs ${block.requested}`;
}

export function quotaNotice(block: QuotaBlock): string {
  return `Queued: namespace quota '${block.quota}' is full (${quotaDetail(block)}). It starts by itself when a pod ends.`;
}

export function quotaFailure(block: QuotaBlock): string {
  const usage = block.used && block.limited ? `${block.resource} used ${block.used} of ${block.limited}, needs ${block.requested}` : `${block.resource}, needs ${block.requested}`;
  return `namespace quota '${block.quota}' exceeded (${usage})`;
}

/** Waiting for readiness reads a snapshot no older than this, whatever the cache TTL is. */
const POD_WAIT_MAX_AGE_MS = 1_000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the sandbox's pod exists, is Ready and is not terminating. A timeout names the last
 * known problem (unschedulable, volume bound to another zone, image pull) instead of hanging silently.
 */
export async function waitPodReady(kube: Kube, name: string, options: WaitOptions): Promise<PodInfo> {
  const { timeoutSeconds, pollMs = 2000, onProblem, sleep = realSleep, now = Date.now } = options;
  const deadline = now() + timeoutSeconds * 1000;
  let lastProblem: string | undefined;
  let quota: QuotaBlock | undefined;
  for (;;) {
    const info = await kube.podInfo(name, { maxAgeMs: POD_WAIT_MAX_AGE_MS }).catch(() => null);
    if (info?.ready && !info.terminating) return info;
    if (!info) {
      // no pod: the controller may be refused by the namespace quota, which it retries by itself
      const ready = (await options.sandbox?.().catch(() => undefined))?.ready;
      // a pod spec Kubernetes rejects (a memory request above its limit, a bad field) never comes right by waiting: say so now
      if (ready?.reason === "InvalidConfiguration") throw new Error(`Pod ${name} is invalid and cannot be created: ${ready.message ?? "invalid configuration"}`);
      const block = parseQuotaBlock(ready);
      if (block) quota = block;
    } else quota = undefined;
    const problem = quota ? quotaNotice(quota) : info?.terminating ? "Pod is being replaced" : info?.problem;
    if (problem && problem !== lastProblem) {
      lastProblem = problem;
      onProblem?.(problem);
    }
    if (now() >= deadline) {
      const why = quota ? `: ${quotaFailure(quota)}` : lastProblem ? `: ${lastProblem}` : info ? "" : " (it does not exist)";
      throw new Error(`Pod ${name} was not ready after ${timeoutSeconds}s${why}`);
    }
    await sleep(pollMs);
  }
}
