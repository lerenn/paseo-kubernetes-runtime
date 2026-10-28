import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GitRunner, runGit } from "../server/git.js";
import { GitMirrorStats, MirrorGate, parseListing } from "../server/mirror-gate.js";
import { applyFetch } from "../server/mirrors.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A runner that counts the remote-touching git spawns (ls-remote, fetch), slows them down and can fail them. */
function countingGit(delayMs = 0) {
  const counts = { lsRemote: 0, fetch: 0, running: 0, peak: 0, failLs: 0 };
  const git: GitRunner = async (args, options) => {
    const sub = args[0];
    if (sub !== "ls-remote" && sub !== "fetch") return runGit(args, options);
    if (sub === "ls-remote") {
      counts.lsRemote += 1;
      if (counts.failLs > 0) {
        counts.failLs -= 1;
        return { code: 128, stdout: "", stderr: "ssh: connection refused" };
      }
    } else {
      counts.fetch += 1;
      counts.running += 1;
      counts.peak = Math.max(counts.peak, counts.running);
    }
    try {
      await sleep(delayMs);
      return await runGit(args, options);
    } finally {
      if (sub === "fetch") counts.running -= 1;
    }
  };
  return { git, counts };
}

function setup(names: string[] = ["main"]) {
  const root = mkdtempSync(join(tmpdir(), "mirror-gate-"));
  const remote = join(root, "remote");
  const project = join(root, "project");
  mkdirSync(remote);
  mkdirSync(project);
  sh(remote, "init", "-q", "-b", "main");
  writeFileSync(join(remote, "a.txt"), "1\n");
  sh(remote, "add", ".");
  sh(remote, "commit", "-qm", "one");
  for (const n of names) if (n !== "main") sh(remote, "branch", n);
  sh(project, "init", "-q", "-b", "main");
  const target = (id: string) => ({ id, podUrls: [], daemonUrl: remote, origin: true });
  return { root, remote, project, target };
}

const fetchOf = (git: GitRunner, project: string, id: string, target: ReturnType<ReturnType<typeof setup>["target"]>, gate: MirrorGate) =>
  applyFetch(git, project, { op: "fetch", mirror: id, haves: [] }, [target], gate);

describe("mirror gate", () => {
  it("parses ls-remote output: branches, tags (not peeled lines) and the default branch", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const out = `ref: refs/heads/main\tHEAD\n${a}\tHEAD\n${a}\trefs/heads/main\n${b}\trefs/tags/v1\n${a}\trefs/tags/v1^{}\n`;
    const listing = parseListing(out);
    expect(listing.head).toBe("refs/heads/main");
    expect([...listing.refs]).toEqual([["refs/heads/main", a], ["refs/tags/v1", b]]);
  });

  it("answers N pods asking the same remote within the TTL with one ls-remote", async () => {
    const { project, target } = setup(["main", "dev"]);
    const { git, counts } = countingGit(20);
    const gate = new MirrorGate({ stats: new GitMirrorStats() });
    const t = target("1111111111111111");
    const replies = await Promise.all(Array.from({ length: 10 }, () => fetchOf(git, project, t.id, t, gate)));
    expect(replies.every((r) => r.ok && r.head === "refs/heads/main")).toBe(true);
    expect(replies[0]!.refs!.map(([r]) => r).sort()).toEqual(["refs/heads/dev", "refs/heads/main"]);
    expect(counts.lsRemote).toBe(1);
    expect(counts.fetch).toBe(1);
    // a later pod inside the TTL: still no ls-remote, and no fetch because the mirror matches
    const again = await fetchOf(git, project, t.id, t, gate);
    expect(again.ok).toBe(true);
    expect(counts.lsRemote).toBe(1);
    expect(counts.fetch).toBe(1);
    expect(gate.stats.lsRemote).toBe(1);
    expect(gate.stats.lsRemoteCached).toBe(10);
    expect(gate.stats.skipped).toBe(10);
  });

  it("lists the remote again once the TTL has passed", async () => {
    const { project, target } = setup();
    const { git, counts } = countingGit();
    let clock = 0;
    const gate = new MirrorGate({ ttlMs: 5_000, now: () => clock, stats: new GitMirrorStats() });
    const t = target("2222222222222222");
    await fetchOf(git, project, t.id, t, gate);
    clock = 4_000;
    await fetchOf(git, project, t.id, t, gate);
    expect(counts.lsRemote).toBe(1);
    clock = 6_000;
    await fetchOf(git, project, t.id, t, gate);
    expect(counts.lsRemote).toBe(2);
    expect(counts.fetch).toBe(1); // unchanged refs: no second fetch
  });

  it("never runs more than two fetches at once across remotes", async () => {
    const { project, target } = setup();
    const { git, counts } = countingGit(40);
    const gate = new MirrorGate({ stats: new GitMirrorStats() });
    const targets = Array.from({ length: 6 }, (_, i) => target(`c${i}`.repeat(8)));
    const replies = await Promise.all(targets.map((t) => fetchOf(git, project, t.id, t, gate)));
    expect(replies.every((r) => r.ok)).toBe(true);
    expect(counts.fetch).toBe(6);
    expect(counts.peak).toBe(2);
    expect(gate.stats.queued).toBe(4);
  });

  it("serves the queue first come first served and fails a wait that outlasts the timeout", async () => {
    const gate = new MirrorGate({ maxConcurrent: 1, queueTimeoutMs: 50, stats: new GitMirrorStats() });
    const order: number[] = [];
    let release!: () => void;
    const held = gate.withSlot(() => new Promise<void>((r) => (release = r)));
    const waiters = [1, 2].map((n) => gate.withSlot(async () => void order.push(n)));
    release();
    await Promise.all([held, ...waiters]);
    expect(order).toEqual([1, 2]);

    const blocker = gate.withSlot(() => sleep(200));
    await expect(gate.withSlot(async () => undefined)).rejects.toThrow(/too many git fetches/);
    await blocker;
    // the slot is free again, and the timed-out waiter left no ghost behind
    await expect(gate.withSlot(async () => "ok")).resolves.toBe("ok");
  });

  it("reports a slot timeout as a failed fetch reply", async () => {
    const { project, target } = setup();
    const { git } = countingGit();
    const gate = new MirrorGate({ maxConcurrent: 1, queueTimeoutMs: 30, stats: new GitMirrorStats() });
    const blocker = gate.withSlot(() => sleep(150));
    const t = target("3333333333333333");
    const reply = await fetchOf(git, project, t.id, t, gate);
    expect(reply.ok).toBe(false);
    expect(reply.message).toMatch(/too many git fetches/);
    await blocker;
    expect((await fetchOf(git, project, t.id, t, gate)).ok).toBe(true);
  });

  it("skips the fetch when the mirror already has the remote's refs, and fetches when a branch moved", async () => {
    const { remote, project, target } = setup();
    const { git, counts } = countingGit();
    let clock = 0;
    const gate = new MirrorGate({ ttlMs: 1_000, now: () => clock, stats: new GitMirrorStats() });
    const t = target("4444444444444444");
    await fetchOf(git, project, t.id, t, gate);
    clock = 2_000;
    const same = await fetchOf(git, project, t.id, t, gate);
    expect(same.ok).toBe(true);
    expect(same.refs!.length).toBe(1);
    expect(counts.fetch).toBe(1);
    writeFileSync(join(remote, "a.txt"), "2\n");
    sh(remote, "commit", "-qam", "two");
    clock = 4_000;
    const moved = await fetchOf(git, project, t.id, t, gate);
    expect(counts.fetch).toBe(2);
    expect(moved.refs![0]![1]).toBe(sh(remote, "rev-parse", "HEAD"));
  });

  it("does not serve stale refs after a push: invalidate forces a new listing and fetch", async () => {
    const { remote, project, target } = setup();
    const { git, counts } = countingGit();
    const gate = new MirrorGate({ stats: new GitMirrorStats() }); // real clock, 8 s TTL: only invalidate can refresh
    const t = target("5555555555555555");
    await fetchOf(git, project, t.id, t, gate);
    writeFileSync(join(remote, "a.txt"), "pushed\n");
    sh(remote, "commit", "-qam", "pushed");
    const stale = await fetchOf(git, project, t.id, t, gate);
    expect(stale.refs![0]![1]).not.toBe(sh(remote, "rev-parse", "HEAD")); // inside the TTL, before any push through the bridge
    gate.invalidate();
    const fresh = await fetchOf(git, project, t.id, t, gate);
    expect(fresh.refs![0]![1]).toBe(sh(remote, "rev-parse", "HEAD"));
    expect(counts.lsRemote).toBe(2);
    expect(counts.fetch).toBe(2);
  });

  it("does not hand a listing read before an invalidation to readers after it", async () => {
    const { project, target } = setup();
    const { git, counts } = countingGit(40);
    const gate = new MirrorGate({ stats: new GitMirrorStats() });
    const t = target("6666666666666666");
    const first = fetchOf(git, project, t.id, t, gate);
    while (counts.lsRemote === 0) await sleep(2);
    gate.invalidate(); // a push lands while the first listing is in flight
    await first;
    await fetchOf(git, project, t.id, t, gate);
    expect(counts.lsRemote).toBe(2);
  });

  it("does not cache errors: a failed ls-remote is retried and the fetch still goes through", async () => {
    const { project, target } = setup();
    const { git, counts } = countingGit();
    counts.failLs = 1;
    const gate = new MirrorGate({ stats: new GitMirrorStats() });
    const t = target("7777777777777777");
    const first = await fetchOf(git, project, t.id, t, gate);
    expect(first.ok).toBe(true); // listing unavailable: the fetch ran anyway
    expect(first.head).toBeUndefined();
    const second = await fetchOf(git, project, t.id, t, gate);
    expect(second.ok).toBe(true);
    expect(second.head).toBe("refs/heads/main");
    expect(counts.lsRemote).toBe(2);
  });

  it("does not cache a failed fetch: the next pod tries again", async () => {
    const { remote, project, target } = setup();
    const { git, counts } = countingGit();
    const gate = new MirrorGate({ stats: new GitMirrorStats() });
    const t = { ...target("8888888888888888"), daemonUrl: join(remote, "missing") };
    const failed = await fetchOf(git, project, t.id, t, gate);
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/fetch failed/);
    const retry = await fetchOf(git, project, t.id, t, gate);
    expect(retry.ok).toBe(false);
    expect(counts.fetch).toBe(2);
    expect(counts.lsRemote).toBe(2);
  });

  it("formats the once-a-minute line and resets", () => {
    const stats = new GitMirrorStats();
    expect(stats.take()).toBeUndefined();
    stats.lsRemote = 2;
    stats.lsRemoteCached = 8;
    stats.fetches = 10;
    stats.skipped = 7;
    stats.queued = 1;
    stats.recordSpawn(100);
    stats.recordSpawn(300);
    expect(stats.take()).toBe("[kubernetes-runtime] git mirror last minute: ls-remote 2 (cached 8), fetches 10 (skipped 7, queued 1), ssh/upload-pack spawns 2, latency avg 200 ms max 300 ms");
    expect(stats.take()).toBeUndefined();
  });
});
