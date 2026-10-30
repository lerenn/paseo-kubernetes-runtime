import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_SCRIPT } from "../server/pod-assets.js";
import { SUBMODULE_TIP, initSubmodules } from "../server/pod-setup.js";
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
function fakeKube(handler: (argv: string[]) => { code: number; stdout?: string; stderr?: string } | Promise<{ code: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  return {
    calls,
    kube: {
      exec: async (_pod: string, argv: string[]) => {
        calls.push(argv);
        const r = await handler(argv);
        return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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

describe("submodule checkout: pinned or remote tip (ANY-2753 investigator read a three-week-old gitlink)", () => {
  const paths = [{ path: "infra/tf-aws", targetId: "a" }];
  const noSleep = async () => undefined;
  const [pin, tip] = ["1".repeat(40), "2".repeat(40)];
  const isTip = (argv: string[]) => argv[2] === SUBMODULE_TIP;

  it("pinned (default): stays at the gitlink and reports its sha", async () => {
    const { kube, calls } = fakeKube((argv) => (isTip(argv) ? { code: 0, stdout: `${pin} ${pin}\n` } : { code: 0 }));
    const ready: unknown[] = [];
    await initSubmodules(kube, "pod", "/w", [], 1, { paths, sleep: noSleep, onState: (_p, s, _n, m, c) => s === "ready" && ready.push({ m, c }) });
    expect(calls.find(isTip)?.slice(-1)).toEqual(["pinned"]);
    expect(ready).toEqual([{ m: undefined, c: { sha: pin, at: "pinned" } }]);
  });

  it("remote: reports the tip it moved to and the gitlink it left", async () => {
    const { kube, calls } = fakeKube((argv) => (isTip(argv) ? { code: 0, stdout: `${pin} ${tip}\n` } : { code: 0 }));
    const ready: unknown[] = [];
    await initSubmodules(kube, "pod", "/w", [], 1, { paths, checkout: "remote", sleep: noSleep, onState: (_p, s, _n, m, c) => s === "ready" && ready.push({ m, c }) });
    expect(calls.find(isTip)?.slice(-3)).toEqual(["/w", "infra/tf-aws", "remote"]);
    expect(ready).toEqual([{ m: undefined, c: { sha: tip, pinned: pin, at: "remote" } }]);
  });

  it("remote: a failed move leaves it ready at the gitlink, with the reason", async () => {
    const { kube } = fakeKube((argv) => (isTip(argv) ? { code: 3, stdout: `${pin} ${pin}\n`, stderr: "fatal: could not read from remote" } : { code: 0 }));
    const ready: { m?: string; c?: unknown }[] = [];
    const r = await initSubmodules(kube, "pod", "/w", [], 1, { paths, checkout: "remote", sleep: noSleep, onState: (_p, s, _n, m, c) => s === "ready" && ready.push({ m, c }) });
    expect(r.ok).toBe(true);
    expect(ready[0]?.c).toEqual({ sha: pin, at: "pinned" });
    expect(ready[0]?.m).toMatch(/at the pinned commit: could not move to the remote tip: fatal: could not read from remote/);
  });
});

describe("SUBMODULE_TIP in a real checkout", () => {
  const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();
  const tipScript = (cwd: string, path: string, mode: string) => {
    try {
      return { code: 0, out: execFileSync("sh", ["-c", SUBMODULE_TIP, "sh", cwd, path, mode], { env, encoding: "utf8" }).trim() };
    } catch (e) {
      return { code: (e as { status: number }).status, out: String((e as { stdout: string }).stdout).trim() };
    }
  };
  /** An upstream with main two commits ahead of what the superproject pins, and a `release` branch. */
  function setup(branch?: string) {
    const root = mkdtempSync(join(tmpdir(), "kube-subtip-"));
    const up = join(root, "up");
    mkdirSync(up);
    git(up, "init", "-q", "-b", "main");
    git(up, "commit", "-q", "--allow-empty", "-m", "one");
    const pinned = git(up, "rev-parse", "HEAD");
    git(up, "branch", "release");
    git(up, "commit", "-q", "--allow-empty", "-m", "two");
    git(up, "commit", "-q", "--allow-empty", "-m", "three");
    const main = git(up, "rev-parse", "HEAD");
    const sup = join(root, "sup");
    mkdirSync(sup);
    git(sup, "init", "-q", "-b", "main");
    git(sup, "submodule", "add", "-q", up, "infra/tf-aws");
    git(join(sup, "infra/tf-aws"), "checkout", "-q", pinned);
    if (branch) git(sup, "config", "-f", ".gitmodules", "submodule.infra/tf-aws.branch", branch);
    git(sup, "add", "-A");
    git(sup, "commit", "-q", "-m", "pin");
    const work = join(root, "work");
    execFileSync("git", ["clone", "-q", sup, work], { env });
    git(work, "submodule", "update", "-q", "--init");
    return { work, up, pinned, main, release: git(up, "rev-parse", "release") };
  }

  it("pinned: prints the gitlink twice and moves nothing", () => {
    const { work, pinned } = setup();
    expect(tipScript(work, "infra/tf-aws", "pinned")).toEqual({ code: 0, out: `${pinned} ${pinned}` });
    expect(git(join(work, "infra/tf-aws"), "rev-parse", "HEAD")).toBe(pinned);
  });

  it("remote: moves to the remote default branch tip, detached", () => {
    const { work, pinned, main } = setup();
    expect(tipScript(work, "infra/tf-aws", "remote")).toEqual({ code: 0, out: `${pinned} ${main}` });
    const sub = join(work, "infra/tf-aws");
    expect(git(sub, "rev-parse", "HEAD")).toBe(main);
    expect(git(sub, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD"); // detached, as git checks submodules out
  });

  it("remote: follows the branch .gitmodules names", () => {
    const { work, pinned, release } = setup("release");
    expect(tipScript(work, "infra/tf-aws", "remote")).toEqual({ code: 0, out: `${pinned} ${release}` });
  });

  it("remote: a remote that cannot be fetched leaves the gitlink and exits 3", () => {
    const { work, pinned } = setup();
    git(join(work, "infra/tf-aws"), "remote", "set-url", "origin", join(tmpdir(), "nowhere-" + Date.now()));
    expect(tipScript(work, "infra/tf-aws", "remote")).toEqual({ code: 3, out: `${pinned} ${pinned}` });
    expect(git(join(work, "infra/tf-aws"), "rev-parse", "HEAD")).toBe(pinned);
  });
});
