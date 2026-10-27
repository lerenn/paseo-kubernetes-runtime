import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { ExecResult, Kube, PodInfo } from "../server/kube.js";
import { ndjsonStream } from "../server/kube.js";

/**
 * A "pod" that is a directory on this machine: commands run as local processes with HOME there, and
 * `/workspace` is mapped under it. The pod-side scripts (bridge, hook, shims) and git are the real
 * ones; only the cluster is simulated.
 */
export class LocalPodKube implements Kube {
  readonly root = mkdtempSync(join(tmpdir(), "kube-localpod-"));
  readonly home = join(this.root, "home");
  readonly workspace = join(this.root, "workspace");
  /** The pod's copy of the daemon checkout: the daemon's own path would be the very directory the test runs against. */
  readonly checkout = join(this.root, "checkout");
  deleted: string[] = [];
  children: ChildProcess[] = [];

  constructor(private readonly daemonCwd?: string) {
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.workspace, { recursive: true });
    mkdirSync(this.checkout, { recursive: true });
  }

  private map = (argv: string[]) =>
    argv.map((a) => (this.daemonCwd ? a.replaceAll(this.daemonCwd, this.checkout) : a).replaceAll("/workspace", this.workspace));
  /** A pod has no GitHub credentials; drop any the test runner happens to have. */
  private env = () => {
    const { GH_TOKEN: _a, GITHUB_TOKEN: _b, ...rest } = process.env;
    return { ...rest, HOME: this.home, GIT_TERMINAL_PROMPT: "0" };
  };

  async apply() {}
  async podInfo(): Promise<PodInfo> {
    return { uid: "local", ready: true, terminating: false };
  }
  async delete(kind: string, name: string) {
    this.deleted.push(`${kind}/${name}`);
  }
  async applySecretKey() {}
  async removeSecretKey() {}
  async patchSandbox() {}
  async label() {}
  async annotatePod() {}
  async listObjects() {
    return [];
  }
  async listClaims() {
    return [];
  }
  async listSandboxes() {
    return [];
  }
  readonly namespace = "local";

  /** Runs a command in the pod; resolves with its output whatever the exit code. */
  exec(_pod: string, argv: string[]): Promise<ExecResult> {
    return this.run(argv, undefined);
  }
  execInput(_pod: string, argv: string[], input: Readable): Promise<ExecResult> {
    return this.run(argv, input);
  }
  /** `exec` with a working directory and extra env, for acting as the agent in tests. */
  async as(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
    return this.run(argv, undefined, options);
  }

  private run(argv: string[], input?: Readable, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const [cmd, ...rest] = this.map(argv);
      const child = spawn(cmd!, rest, { env: { ...this.env(), ...options.env }, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.on("error", () => undefined);
      if (input) input.pipe(child.stdin);
      else child.stdin.end();
    });
  }

  spawnExec(): never {
    throw new Error("not used by the local pod");
  }

  execStream(_pod: string, argv: string[]) {
    const [cmd, ...rest] = this.map(argv);
    const child = spawn(cmd!, rest, { env: this.env(), stdio: ["pipe", "pipe", "inherit"] });
    this.children.push(child);
    return ndjsonStream(child);
  }

  stop() {
    for (const c of this.children) c.kill();
  }
}
