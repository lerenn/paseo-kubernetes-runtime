import type { Kube } from "./kube.js";

export interface DockerSidecarWait {
  timeoutSeconds?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Waits (bounded, never fatal) for the pod's `dockerd` sidecar to answer `docker info`, run in the agent container whose
 * `DOCKER_HOST` points at it. Returns the seconds it took, or undefined when it did not answer in time. The pod's own
 * readiness does not depend on dockerd.
 */
export async function waitDockerSidecar(kube: Pick<Kube, "exec">, pod: string, options: DockerSidecarWait = {}): Promise<number | undefined> {
  const { timeoutSeconds = 60, pollMs = 2000, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)), now = Date.now } = options;
  const start = now();
  const deadline = start + timeoutSeconds * 1000;
  for (;;) {
    const r = await kube.exec(pod, ["docker", "info"]).catch(() => null);
    if (r?.code === 0) return Math.round((now() - start) / 1000);
    if (now() >= deadline) return undefined;
    await sleep(pollMs);
  }
}
