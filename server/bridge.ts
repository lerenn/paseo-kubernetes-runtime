import { type Socket, connect } from "node:net";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { type GitRunner, scrub } from "./git.js";
import type { FetchRequest } from "./mirrors.js";
import type { Kube } from "./kube.js";

export interface BridgeReply {
  ok?: boolean;
  message?: string;
  refs?: [string, string][];
  head?: string;
  pack?: string;
}

export type PushRequest = { op: "push"; ref: string; old: string; new: string; base: string; pack: string; /** A submodule's mirror in the pod; absent for the project's own branches. */ mirror?: string };
export type BridgeRequest = PushRequest | FetchRequest;

export interface BridgeHandlers {
  handle(request: BridgeRequest): Promise<BridgeReply>;
}

/** A tunnel frame between the pod bridge and the daemon, one per connection event. */
export interface TcpFrame {
  tcp: "open" | "data" | "end";
  cid: number;
  port?: number;
  b64?: string;
}

const SHA = /^[0-9a-f]{40}$/;
const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/;
const TAG_REF = /^refs\/tags\/[A-Za-z0-9._/-]+$/;
const ZERO_SHA = "0".repeat(40);
const MAX_PACK_BYTES = 64 * 1024 * 1024;

/**
 * Applies the pod's new commits in the daemon's checkout and pushes them with the daemon's own git
 * credentials. Only branch pushes are accepted: no deletions, no tags, no other refs.
 */
export async function applyPush(
  git: GitRunner,
  projectDir: string,
  request: PushRequest,
  /** Where the commits are applied and what is pushed to; the project's origin unless a mirror asked. */
  destination: { dir: string; remote: string } = { dir: projectDir, remote: "origin" },
): Promise<BridgeReply> {
  const { ref, new: sha, old, base } = request;
  if (!(BRANCH_REF.test(ref) || TAG_REF.test(ref)) || ref.includes("..")) return { ok: false, message: `kube-agents: refusing to push ${ref}: only branches and new tags are pushed from pods` };
  // a tag is only ever created: moving one is refused here as well as in the pod's hook
  if (TAG_REF.test(ref) && old !== ZERO_SHA) return { ok: false, message: `kube-agents: moving the existing tag ${ref.replace("refs/tags/", "")} from a pod is not supported` };
  if (![sha, old, base].every((v) => SHA.test(v))) return { ok: false, message: "kube-agents: malformed push request" };
  const pack = Buffer.from(request.pack, "base64");
  if (pack.length > MAX_PACK_BYTES) return { ok: false, message: "kube-agents: push is too large to relay (over 64MB)" };

  if (pack.length > 0) {
    const indexed = await git(["index-pack", "--stdin", "--fix-thin"], { cwd: destination.dir, input: pack });
    if (indexed.code !== 0) return { ok: false, message: `kube-agents: could not read the pushed commits: ${scrub(indexed.stderr.trim())}` };
  }
  const known = await git(["cat-file", "-e", `${sha}^{commit}`], { cwd: destination.dir });
  if (known.code !== 0) return { ok: false, message: "kube-agents: the pushed commit is missing on the daemon" };

  const pushed = await git(["push", destination.remote, `${sha}:${ref}`], { cwd: destination.dir });
  if (pushed.code !== 0) {
    return { ok: false, message: `kube-agents: push to ${ref} rejected by the remote:\n${scrub(pushed.stderr.trim())}` };
  }
  return { ok: true, message: `kube-agents: pushed ${sha.slice(0, 7)} to ${ref.replace("refs/heads/", "")} from the daemon` };
}

/**
 * Carries TCP connections from pod-side loopback listeners to the same loopback ports on the daemon.
 * Only ports the session's config names are reachable, and only on 127.0.0.1: nothing else on the
 * daemon, and nothing on the network. Raw bytes pass through, so streaming responses work.
 */
export class Tunnels {
  private readonly sockets = new Map<number, Socket>();

  constructor(
    private readonly allowed: ReadonlySet<number>,
    private readonly send: (frame: Omit<TcpFrame, "cid"> & { cid: number }) => void,
    /** Maps a pod port to the daemon port (identity in production; tests share one host). */
    private readonly mapPort: (port: number) => number = (p) => p,
  ) {}

  onFrame(frame: TcpFrame): void {
    if (frame.tcp === "open") {
      const port = frame.port ?? 0;
      if (!this.allowed.has(port)) {
        this.send({ tcp: "end", cid: frame.cid });
        return;
      }
      const socket = connect({ host: "127.0.0.1", port: this.mapPort(port) });
      this.sockets.set(frame.cid, socket);
      socket.on("data", (d) => this.send({ tcp: "data", cid: frame.cid, b64: d.toString("base64") }));
      socket.on("close", () => {
        if (this.sockets.delete(frame.cid)) this.send({ tcp: "end", cid: frame.cid });
      });
      socket.on("error", () => undefined);
      return;
    }
    const socket = this.sockets.get(frame.cid);
    if (!socket) return;
    if (frame.tcp === "data" && frame.b64) socket.write(Buffer.from(frame.b64, "base64"));
    else if (frame.tcp === "end") {
      this.sockets.delete(frame.cid);
      socket.end();
    }
  }

  closeAll(): void {
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
  }
}

/** Loopback ports an MCP server config points at (`http://127.0.0.1:<port>/...`), for the tunnel. */
export function loopbackPorts(
  mcpServers: Readonly<Record<string, { type: string; url?: string }>>,
  /** Other loopback URLs the process is told about through its environment (e.g. Daemon Ops). */
  extraUrls: readonly (string | undefined)[] = [],
): number[] {
  const urls = [...Object.values(mcpServers).map((s) => s.url), ...extraUrls];
  const ports = new Set<number>();
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && Number(url.port)) ports.add(Number(url.port));
    } catch {
      // not a URL
    }
  }
  return [...ports];
}

export interface RunningBridge {
  close(): void;
}

/**
 * Starts the pod-side bridge over `kubectl exec` stdio and answers its requests. The stream ends
 * when the pod is lost or the bridge is closed; recovery starts a new one.
 */
export function startBridge(
  kube: Kube,
  pod: string,
  ports: readonly number[],
  handlers: BridgeHandlers,
  options: { mapPort?: (port: number) => number; /** Called when the channel ended without `close()` (the pod or the plugin's exec was lost). */ onEnd?: () => void } = {},
): RunningBridge {
  const stream = kube.execStream(pod, [
    "sh",
    "-c",
    'exec node "$HOME/bridge.mjs" serve "$1"',
    "sh",
    ports.join(","),
  ]);
  const writer = stream.writable.getWriter();
  let closed = false;
  const send = (message: object) => {
    if (!closed) void writer.write(message as unknown as AcpStreamMessage).catch(() => undefined);
  };
  const tunnels = new Tunnels(new Set(ports), send, options.mapPort);
  void (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || closed) {
        tunnels.closeAll();
        if (!closed) options.onEnd?.();
        return;
      }
      if ((value as { tcp?: string }).tcp) {
        tunnels.onFrame(value as unknown as TcpFrame);
        continue;
      }
      const request = value as unknown as BridgeRequest & { id: number };
      void handlers
        .handle(request)
        .catch((error: Error): BridgeReply => ({ ok: false, message: `kube-agents: ${scrub(error.message)}` }))
        .then((reply) => send({ id: request.id, ...reply }));
    }
  })();
  return {
    close() {
      closed = true;
      tunnels.closeAll();
      void writer.close().catch(() => undefined);
    },
  };
}
