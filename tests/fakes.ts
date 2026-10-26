import { PassThrough } from "node:stream";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ClaimInfo, ExecResult, Kube, PodInfo, PodProcess, SandboxInfo } from "../server/kube.js";

export class FakeKube implements Kube {
  calls: string[] = [];
  applied: Record<string, unknown>[] = [];
  execs: { pod: string; argv: string[] }[] = [];
  execResult: ExecResult = { code: 0, stdout: "", stderr: "" };
  waitError?: Error;
  streams: { pod: string; argv: string[] }[] = [];

  async apply(manifest: Record<string, unknown>) {
    this.calls.push("apply");
    this.applied.push(manifest);
    const meta = (manifest as any).metadata ?? {};
    if (meta.name) {
      this.sandboxes.push({
        name: meta.name,
        labels: meta.labels ?? {},
        annotations: meta.annotations ?? {},
        operatingMode: "Running",
        image: (manifest as any).spec?.podTemplate?.spec?.containers?.[0]?.image,
        createdAt: new Date(this.sandboxes.length).toISOString(),
      });
    }
  }
  /** Scripted pod states, consumed in order; the last one repeats. */
  pods: (PodInfo | null)[] = [{ uid: "uid-1", ready: true, terminating: false }];
  async podInfo(name: string) {
    this.calls.push(`pod:${name}`);
    if (this.waitError) throw this.waitError;
    return this.pods.length > 1 ? this.pods.shift()! : this.pods[0]!;
  }
  /** True once the workspace holds a clone (survives a replaced pod when storage is persistent). */
  hasClone = false;
  async exec(pod: string, argv: string[]) {
    this.calls.push("exec");
    this.execs.push({ pod, argv });
    if (argv[0] === "test") return { code: this.hasClone ? 0 : 1, stdout: "", stderr: "" };
    if (this.execResult.code === 0 && argv[0] === "sh" && argv[2]?.includes("git init")) this.hasClone = true;
    return this.execResult;
  }
  inputs: { pod: string; argv: string[]; bytes: number }[] = [];
  async execInput(pod: string, argv: string[], input: import("node:stream").Readable) {
    let bytes = 0;
    for await (const chunk of input) bytes += (chunk as Buffer).length;
    this.calls.push("execInput");
    this.inputs.push({ pod, argv, bytes });
    return this.execResult;
  }
  /** Provider processes started in the pod: their argv, and handles to end them. */
  procs: { pod: string; argv: string[]; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; end(code: number | null, signal?: string | null): void; killed: string[] }[] = [];
  spawnExec(pod: string, argv: string[]): PodProcess {
    this.calls.push("spawn");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const killed: string[] = [];
    let finish!: (v: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => (finish = resolve));
    this.procs.push({ pod, argv, stdin, stdout, stderr, killed, end: (code, signal = null) => finish({ code, signal }) });
    return { stdin, stdout, stderr, exit, kill: (sig) => void killed.push(sig ?? "SIGTERM") };
  }
  execStream(pod: string, argv: string[]) {
    this.streams.push({ pod, argv });
    return {
      readable: new ReadableStream<AcpStreamMessage>(),
      writable: new WritableStream<AcpStreamMessage>(),
    };
  }
  namespace = "paseo-agents";
  patches: { key: string; manifest: string }[] = [];
  removed: string[] = [];
  patches2: { name: string; patch: any }[] = [];
  sandboxes: SandboxInfo[] = [];
  labelled: { kind: string; name: string; labels: Record<string, string> }[] = [];
  async label(kind: string, name: string, labels: Record<string, string>) {
    this.labelled.push({ kind, name, labels });
  }
  async patchSandbox(name: string, patch: Record<string, unknown>) {
    this.calls.push(`patch:${name}`);
    this.patches2.push({ name, patch });
    const sb = this.sandboxes.find((s) => s.name === name);
    const spec = (patch as any).spec;
    if (sb && spec?.operatingMode) sb.operatingMode = spec.operatingMode;
    const meta = (patch as any).metadata;
    if (sb && meta?.labels) sb.labels = { ...sb.labels, ...meta.labels };
    if (sb && meta?.annotations) sb.annotations = { ...sb.annotations, ...meta.annotations };
  }
  claims: ClaimInfo[] = [];
  async listClaims(selector?: string) {
    if (!selector) return this.claims;
    const [k, v] = selector.split("=");
    return this.claims.filter((c) => (v === undefined ? k! in c.labels : c.labels[k!] === v));
  }
  async listSandboxes(selector: string) {
    const terms = selector.split(",").map((t) => t.split("="));
    return this.sandboxes.filter((s) => terms.every(([k, v]) => (v === undefined ? k! in s.labels : s.labels[k!] === v)));
  }
  removeError?: Error;
  async removeSecretKey(_secret: string, key: string) {
    if (this.removeError) throw this.removeError;
    this.removed.push(key);
  }
  patchError?: Error;
  async applySecretKey(_secret: string, key: string, manifest: string) {
    if (this.patchError) throw this.patchError;
    this.patches.push({ key, manifest });
  }
  async delete(kind: string, name: string) {
    this.calls.push(`delete:${kind}/${name}`);
    if (kind === "sandbox") this.sandboxes = this.sandboxes.filter((s) => s.name !== name);
  }
}

import { Readable } from "node:stream";
import type { SeedBundle } from "../server/runtime.js";

/** Stands in for the daemon-side seed bundle so tests need no git checkout. */
export const fakeSeeder = async (_cwd: string, plan: { branch?: string } | null, currentBranch: string): Promise<SeedBundle> => ({
  seed: { id: "seed1", ref: "refs/kube-seed/seed1", sha: "a".repeat(40), branch: plan?.branch ?? currentBranch },
  bundle: Readable.from([Buffer.from("bundle")]),
  done: Promise.resolve(),
  release: async () => undefined,
});
