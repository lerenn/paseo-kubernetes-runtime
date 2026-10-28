import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_SCRIPT } from "../server/pod-assets.js";
import { initSubmodules } from "../server/pod-setup.js";
import { SubmoduleTracker } from "../server/submodule-status.js";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A pod's HOME with the bridge script and an empty mirror, and a runner for `bridge.mjs call fetch`. */
function podHome() {
  const home = mkdtempSync(join(tmpdir(), "kube-bridge-"));
  writeFileSync(join(home, "bridge.mjs"), BRIDGE_SCRIPT);
  const mirror = join(home, "mirrors", "m.git");
  mkdirSync(mirror, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", mirror]);
  const sock = join(home, "bridge.sock");
  const run = (env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; stderr: string; ms: number }>((resolve) => {
      const started = Date.now();
      const child = spawn("node", [join(home, "bridge.mjs"), "call", "fetch", mirror], { env: { ...process.env, HOME: home, PASEO_BRIDGE_RETRY_MS: "50", ...env }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stderr, ms: Date.now() - started }));
    });
  const serve = (replies: ((c: import("node:net").Socket) => void)[]) =>
    new Promise<{ requests: () => number }>((resolve) => {
      let n = 0;
      const server = createServer({ allowHalfOpen: true }, (c) => {
        let buf = "";
        c.on("data", (d) => {
          buf += d;
          if (!buf.includes("\n")) return;
          buf = "";
          (replies[Math.min(n++, replies.length - 1)] ?? (() => undefined))(c);
        });
        c.on("error", () => undefined);
      });
      servers.push(server);
      server.listen(sock, () => resolve({ requests: () => n }));
    });
  return { run, serve };
}

const ok = (c: import("node:net").Socket) => c.end(JSON.stringify({ ok: true, refs: [] }));
const garbage = (c: import("node:net").Socket) => c.end("{\"ok\":tr");

describe("pod bridge fetch call", () => {
  it("retries a truncated reply and succeeds", async () => {
    const { run, serve } = podHome();
    const s = await serve([garbage, garbage, ok]);
    const r = await run();
    expect(r.code).toBe(0);
    expect(s.requests()).toBe(3);
    expect(r.stderr).toContain("bad bridge reply");
  });

  it("waits for a bridge that is restarting (connection refused, then it comes back)", async () => {
    const { run, serve } = podHome();
    const result = run({ PASEO_BRIDGE_RETRY_MS: "200" });
    await new Promise((r) => setTimeout(r, 500));
    await serve([ok]);
    const r = await result;
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/bridge unavailable/);
  });

  it("gives up on a bridge that never answers, with a timeout per request and a bounded number of tries", async () => {
    const { run, serve } = podHome();
    const s = await serve([() => undefined]);
    const r = await run({ PASEO_BRIDGE_TIMEOUT_MS: "200", PASEO_BRIDGE_ATTEMPTS: "2" });
    expect(r.code).toBe(1);
    expect(s.requests()).toBe(2);
    expect(r.ms).toBeLessThan(10_000);
    expect(r.stderr).toMatch(/no answer/);
  });

  it("does not retry a refusal from the daemon", async () => {
    const { run, serve } = podHome();
    const s = await serve([(c) => c.end(JSON.stringify({ ok: false, message: "kube-agents: fetch failed on the daemon" }))]);
    const r = await run();
    expect(r.code).toBe(1);
    expect(s.requests()).toBe(1);
  });

  it("retries the daemon's 'run the command again' answers", async () => {
    const { run, serve } = podHome();
    const busy = (c: import("node:net").Socket) => c.end(JSON.stringify({ ok: false, message: "too many git fetches are running for pods" }));
    const s = await serve([busy, ok]);
    expect((await run()).code).toBe(0);
    expect(s.requests()).toBe(2);
  });
});

/** A pod whose commands are scripted by the first word they run. */
function fakeKube(handler: (argv: string[]) => { code: number; stderr?: string } | Promise<{ code: number; stderr?: string }>) {
  const calls: string[][] = [];
  return {
    calls,
    kube: {
      exec: async (_pod: string, argv: string[]) => {
        calls.push(argv);
        const r = await handler(argv);
        return { code: r.code, stdout: "", stderr: r.stderr ?? "" };
      },
    } as never,
  };
}

describe("initSubmodules", () => {
  const paths = [{ path: "infra/tf-aws", targetId: "a" }, { path: "misc/annie-deepeval", targetId: "b" }];
  const noSleep = async () => undefined;

  it("fills each remote's mirror once through the bridge, then updates each submodule", async () => {
    const { kube, calls } = fakeKube(() => ({ code: 0 }));
    const shared = [...paths, { path: "other/copy", targetId: "a" }];
    await initSubmodules(kube, "pod", "/w", [], 6, { paths: shared, sleep: noSleep });
    expect(calls.filter((c) => c.join(" ").includes("bridge.mjs"))).toHaveLength(2); // three paths, two remotes
    calls.length = 0;
    const states: string[] = [];
    const r = await initSubmodules(kube, "pod", "/w", [], 6, { paths, sleep: noSleep, onState: (p, s) => states.push(`${p}:${s}`) });
    expect(r).toEqual({ ok: true, message: "" });
    expect(calls.filter((c) => c.join(" ").includes("bridge.mjs"))).toHaveLength(2);
    expect(calls.filter((c) => c.join(" ").includes("submodule update"))).toHaveLength(2);
    expect(states).toContain("infra/tf-aws:ready");
    expect(states).toContain("misc/annie-deepeval:ready");
  });

  it("retries a failing submodule, then reports it failed with the error while the others finish", async () => {
    let tf = 0;
    const { kube } = fakeKube((argv) => {
      if (argv.includes("infra/tf-aws") && argv[2]?.includes("submodule update")) {
        tf += 1;
        return { code: 1, stderr: "kube-agents: bridge unavailable: connect ECONNREFUSED /workspace/.home/bridge.sock" };
      }
      return { code: 0 };
    });
    const events: [string, string, string | undefined][] = [];
    const r = await initSubmodules(kube, "pod", "/w", [], 6, { paths, attempts: 3, sleep: noSleep, onState: (p, s, _n, m) => events.push([p, s, m]) });
    expect(tf).toBe(3);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/infra\/tf-aws: .*ECONNREFUSED/);
    expect(events.find((e) => e[0] === "infra/tf-aws" && e[1] === "failed")?.[2]).toMatch(/ECONNREFUSED/);
    expect(events).toContainEqual(["misc/annie-deepeval", "ready", undefined]);
  });

  it("retries a mirror fetch that failed because the bridge was down", async () => {
    let n = 0;
    const { kube } = fakeKube((argv) => (argv.join(" ").includes("bridge.mjs") && ++n < 2 ? { code: 1, stderr: "kube-agents: bridge unavailable: connect ECONNREFUSED" } : { code: 0 }));
    const r = await initSubmodules(kube, "pod", "/w", [], 1, { paths: [paths[0]!], sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });

  it("succeeds when a retry gets through", async () => {
    let n = 0;
    const { kube } = fakeKube((argv) => (argv[2]?.includes("submodule update") ? (++n < 2 ? { code: 1, stderr: "bad bridge reply" } : { code: 0 }) : { code: 0 }));
    const r = await initSubmodules(kube, "pod", "/w", [], 1, { paths: [paths[0]!], sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });

  it("gives up on a command that hangs", async () => {
    const { kube } = fakeKube((argv) => (argv[2]?.includes("submodule update") ? new Promise(() => undefined) : { code: 0 }));
    const r = await initSubmodules(kube, "pod", "/w", [], 1, { paths: [paths[0]!], attempts: 1, timeoutMs: 50, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/did not finish/);
  });
});

describe("a wait on a failed submodule", () => {
  it("starts the provisioning again and waits for that run", async () => {
    const tracker = new SubmoduleTracker();
    tracker.reset([{ path: "a", checkedOut: false }]);
    tracker.update("a", "failed", 0.1, "bad bridge reply");
    expect(tracker.report().submodules[0]).toMatchObject({ state: "failed", message: "bad bridge reply" });
    let retries = 0;
    tracker.retry = () => {
      retries += 1;
      setTimeout(() => tracker.update("a", "ready", 1), 10);
    };
    await expect(tracker.wait("a", 2_000)).resolves.toMatchObject({ state: "ready" });
    expect(retries).toBe(1);
  });

  it("answers failed when there is nothing to retry with", async () => {
    const tracker = new SubmoduleTracker();
    tracker.reset([{ path: "a", checkedOut: false }]);
    tracker.update("a", "failed", 0.1, "x");
    await expect(tracker.wait("a", 100)).resolves.toMatchObject({ state: "failed" });
  });
});
