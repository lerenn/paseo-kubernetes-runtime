import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";

export interface PodProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** Resolves when the exec ends (the process, or the connection to the pod). */
  exit: Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: string): void;
}

export interface PodInfo {
  uid: string;
  ready: boolean;
  /** Being deleted: not usable even if it still reports Ready. */
  terminating: boolean;
  phase?: string;
  /** Set when the pod is being disrupted involuntarily (a node reclaim, an eviction): the `DisruptionTarget` condition's reason. */
  disrupted?: string;
  /** A container was killed for memory. */
  oomKilled?: boolean;
  /** Why the pod is not running yet, in a form fit to show a user (scheduling, volume, image pull). */
  problem?: string;
}

export function parsePodInfo(pod: any): PodInfo {
  const conditions: any[] = pod?.status?.conditions ?? [];
  const cond = (type: string) => conditions.find((c) => c.type === type);
  const unscheduled = cond("PodScheduled")?.status === "False" ? cond("PodScheduled") : undefined;
  const waiting = (pod?.status?.containerStatuses ?? [])
    .map((c: any) => c.state?.waiting)
    .find((w: any) => w?.reason && w.reason !== "ContainerCreating" && w.reason !== "PodInitializing");
  const problem = unscheduled
    ? `Pod cannot be scheduled: ${unscheduled.message ?? unscheduled.reason}`
    : waiting
      ? `Container waiting: ${waiting.reason}${waiting.message ? ` (${waiting.message})` : ""}`
      : undefined;
  const disruption = cond("DisruptionTarget")?.status === "True" ? cond("DisruptionTarget") : undefined;
  const oom = (pod?.status?.containerStatuses ?? []).some((c: any) => c.state?.terminated?.reason === "OOMKilled" || c.lastState?.terminated?.reason === "OOMKilled");
  return {
    uid: pod?.metadata?.uid ?? "",
    ready: cond("Ready")?.status === "True",
    terminating: Boolean(pod?.metadata?.deletionTimestamp),
    phase: pod?.status?.phase,
    ...(disruption ? { disrupted: disruption.reason ?? "Disrupted" } : {}),
    ...(oom ? { oomKilled: true } : {}),
    ...(problem ? { problem } : {}),
  };
}

export interface SandboxInfo {
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  operatingMode: "Running" | "Suspended";
  createdAt?: string;
  /** The workspace container's image as the Sandbox asks for it. */
  image?: string;
}

export interface ClaimInfo {
  name: string;
  labels: Record<string, string>;
  createdAt?: string;
  /** Requested size, e.g. 10Gi. */
  size?: string;
}

export function parseClaimList(json: any): ClaimInfo[] {
  return (json?.items ?? []).map((item: any) => ({
    name: item.metadata.name,
    labels: item.metadata.labels ?? {},
    createdAt: item.metadata.creationTimestamp,
    ...(item.spec?.resources?.requests?.storage ? { size: item.spec.resources.requests.storage } : {}),
  }));
}

export function parseSandboxList(json: any): SandboxInfo[] {
  return (json?.items ?? []).map((item: any) => ({
    name: item.metadata.name,
    labels: item.metadata.labels ?? {},
    annotations: item.metadata.annotations ?? {},
    operatingMode: item.spec?.operatingMode === "Suspended" ? "Suspended" : "Running",
    createdAt: item.metadata.creationTimestamp,
    ...(item.spec?.podTemplate?.spec?.containers?.[0]?.image ? { image: item.spec.podTemplate.spec.containers[0].image } : {}),
  }));
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The only cluster surface kube-agents needs; tests substitute a fake. */
export interface Kube {
  apply(manifest: Record<string, unknown>): Promise<void>;
  /** Current state of a pod, or null when it does not exist (yet). */
  podInfo(name: string): Promise<PodInfo | null>;
  exec(pod: string, argv: string[]): Promise<ExecResult>;
  /** Merge-patches a Sandbox (suspend, resume, claim from the pool). */
  patchSandbox(name: string, patch: Record<string, unknown>): Promise<void>;
  /** Sets labels and annotations on a pod or volume claim (`kubectl label/annotate --overwrite`). */
  label(kind: "pod" | "pvc", name: string, labels: Record<string, string>, annotations?: Record<string, string>): Promise<void>;
  /** Sandboxes matching a label selector. */
  listSandboxes(selector: string): Promise<SandboxInfo[]>;
  /** Volume claims matching a label selector (all claims in the namespace when omitted). */
  listClaims(selector?: string): Promise<ClaimInfo[]>;
  /** Runs a command in the pod with `input` on its stdin (used to copy files in over the Kubernetes API). */
  execInput(pod: string, argv: string[], input: Readable): Promise<ExecResult>;
  /** Long-lived stdio JSON-RPC (ndjson) stream to a process inside the pod. */
  execStream(pod: string, argv: string[]): AcpStream;
  /** A process in the pod with raw stdio, for the provider processes Paseo asks the runtime to start. */
  spawnExec(pod: string, argv: string[]): PodProcess;
  delete(kind: string, name: string): Promise<void>;
  readonly namespace: string;
  /**
   * Server-side-applies one Secret key, with a field manager per key so writing one key never drops
   * another. Needs only `patch` on the Secret. The manifest travels on stdin, never on argv.
   */
  applySecretKey(secret: string, key: string, manifest: string): Promise<void>;
  /**
   * Removes one key from a Secret with a merge patch (`{"data":{"<key>":null}}`) sent through
   * `kubectl proxy`. Needs only `patch`: `kubectl patch` would GET first, and server-side apply does
   * not remove a key by leaving it out.
   */
  removeSecretKey(secret: string, key: string): Promise<void>;
}

export interface KubectlOptions {
  context?: string;
  namespace: string;
  binary?: string;
}

function run(binary: string, args: string[], stdin?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

export function ndjsonStream(
  child: Pick<ReturnType<typeof spawn>, "stdin" | "stdout" | "kill">,
): AcpStream {
  let buffer = "";
  // The consumer cancelling the reader kills the child, whose stdout then ends: closing or
  // enqueuing after that throws, and an uncaught throw here takes down the whole plugin process.
  let done = false;
  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (error) controller.error(error);
        else controller.close();
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line || done) continue;
          try {
            controller.enqueue(JSON.parse(line) as AcpStreamMessage);
          } catch {
            // Non-JSON output (banners, warnings) is not part of the protocol.
          }
        }
      });
      child.stdout!.on("end", () => finish());
      child.stdout!.on("error", (e) => finish(e));
    },
    cancel() {
      done = true;
      child.kill();
    },
  });
  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      return new Promise((resolve, reject) => {
        child.stdin!.write(`${JSON.stringify(message)}\n`, (e) => (e ? reject(e) : resolve()));
      });
    },
    close() {
      child.stdin!.end();
    },
    abort() {
      child.kill();
    },
  });
  return { readable, writable };
}

export class Kubectl implements Kube {
  readonly namespace: string;
  private readonly binary: string;
  private readonly contextArgs: string[];
  private readonly base: string[];

  constructor(options: KubectlOptions) {
    this.namespace = options.namespace;
    this.binary = options.binary ?? "kubectl";
    this.contextArgs = options.context ? ["--context", options.context] : [];
    this.base = [...this.contextArgs, "-n", options.namespace];
  }

  protected async ok(args: string[], stdin?: string): Promise<ExecResult> {
    const result = await run(this.binary, [...this.base, ...args], stdin);
    if (result.code !== 0) {
      throw new Error(`kubectl ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result;
  }

  async apply(manifest: Record<string, unknown>): Promise<void> {
    await this.ok(["apply", "-f", "-"], JSON.stringify(manifest));
  }

  async podInfo(name: string): Promise<PodInfo | null> {
    const result = await this.ok(["get", "pod", name, "--ignore-not-found", "-o", "json"]);
    return result.stdout.trim() ? parsePodInfo(JSON.parse(result.stdout)) : null;
  }

  exec(pod: string, argv: string[]): Promise<ExecResult> {
    return run(this.binary, [...this.base, "exec", pod, "--", ...argv]);
  }

  execInput(pod: string, argv: string[], input: Readable): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [...this.base, "exec", "-i", pod, "--", ...argv], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.on("error", () => undefined);
      input.on("error", reject);
      input.pipe(child.stdin);
    });
  }

  spawnExec(pod: string, argv: string[]): PodProcess {
    const child = spawn(this.binary, [...this.base, "exec", "-i", pod, "--", ...argv], { stdio: ["pipe", "pipe", "pipe"] });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("error", () => resolve({ code: 127, signal: null }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      exit,
      kill: (signal) => void child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM"),
    };
  }

  execStream(pod: string, argv: string[]): AcpStream {
    const child = spawn(this.binary, [...this.base, "exec", "-i", pod, "--", ...argv], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    return ndjsonStream(child);
  }

  async applySecretKey(_secret: string, key: string, manifest: string): Promise<void> {
    await this.ok(
      ["apply", "--server-side", `--field-manager=paseo-kube-agents-${key.toLowerCase()}`, "--force-conflicts", "-f", "-"],
      manifest,
    );
  }

  async patchSandbox(name: string, patch: Record<string, unknown>): Promise<void> {
    await this.ok(["patch", "sandbox", name, "--type=merge", "-p", JSON.stringify(patch)]);
  }

  async label(kind: "pod" | "pvc", name: string, labels: Record<string, string>, annotations: Record<string, string> = {}): Promise<void> {
    await this.ok(["label", kind, name, "--overwrite", ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)]);
    if (Object.keys(annotations).length) {
      await this.ok(["annotate", kind, name, "--overwrite", ...Object.entries(annotations).map(([k, v]) => `${k}=${v}`)]);
    }
  }

  async listSandboxes(selector: string): Promise<SandboxInfo[]> {
    const result = await this.ok(["get", "sandbox", "-l", selector, "-o", "json"]);
    return parseSandboxList(JSON.parse(result.stdout));
  }

  async listClaims(selector?: string): Promise<ClaimInfo[]> {
    const result = await this.ok(["get", "pvc", ...(selector ? ["-l", selector] : []), "-o", "json"]);
    return parseClaimList(JSON.parse(result.stdout));
  }

  async removeSecretKey(secret: string, key: string): Promise<void> {
    const proxy = spawn(this.binary, [...this.contextArgs, "proxy", "--port=0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error("kubectl proxy did not start")), 15_000);
        proxy.stdout.on("data", (d) => {
          out += d;
          const m = /127\.0\.0\.1:(\d+)/.exec(out);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        proxy.on("error", reject);
        proxy.on("close", () => reject(new Error("kubectl proxy exited")));
      });
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/namespaces/${this.namespace}/secrets/${secret}`, {
        method: "PATCH",
        headers: { "content-type": "application/merge-patch+json" },
        body: JSON.stringify({ data: { [key]: null } }),
      });
      // The response is the whole Secret, values included: only the status is looked at, never the body.
      void res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new Error(`removing ${key} failed: HTTP ${res.status}`);
    } finally {
      proxy.kill();
    }
  }

  async delete(kind: string, name: string): Promise<void> {
    await this.ok(["delete", kind, name, "--ignore-not-found", "--wait=false"]);
  }
}
