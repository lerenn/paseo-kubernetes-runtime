import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runGit } from "../server/git.js";
import { MIRROR_SETUP_SCRIPT, mirrorId, mirrorSetupArgs, otherRepoTarget, refreshMirror, repoPolicy, submoduleTargets } from "../server/mirrors.js";
import { MirrorGate } from "../server/mirror-gate.js";
import { handleRpc, startSubmoduleMcp } from "../server/submodule-mcp.js";
import { SubmoduleTracker, gitmodulesPaths, parseSubmoduleStatus, submoduleWarning } from "../server/submodule-status.js";
import { ConfigSchema } from "../shared/settings.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

describe("gitProxy setting", () => {
  it("is on by default for the three orgs, with a submodule wait", () => {
    const c = ConfigSchema.parse({});
    expect(c.gitProxy).toEqual({ enabled: true, allowOrgs: ["anyshift-io", "anyshift-engineering", "lerenn"], provisionWaitSeconds: 30, submoduleCheckout: "pinned" });
  });
});

describe("repoPolicy", () => {
  const other = { enabled: true, hosts: ["github.com"], allow: [] as string[] };
  it("scopes github.com to the allowed orgs", () => {
    const { access, prefixes } = repoPolicy(other, { enabled: true, allowOrgs: ["Anyshift-io", "lerenn"] });
    expect(prefixes).toEqual(["github.com/anyshift-io", "github.com/lerenn"]);
    expect(otherRepoTarget("x:github.com/anyshift-io/tf-aws", access)).toMatchObject({ daemonUrl: "git@github.com:anyshift-io/tf-aws.git" });
    expect(otherRepoTarget("x:github.com/evil/repo", access)).toMatchObject({ refused: expect.stringMatching(/not one of the orgs/) });
  });

  it("keeps other hosts whole, and turns github.com on even when other repositories are off", () => {
    const { access, prefixes } = repoPolicy({ enabled: true, hosts: ["example.test"], allow: ["o/*"] }, { enabled: true, allowOrgs: ["lerenn"] });
    expect(prefixes).toEqual(["example.test", "github.com/lerenn"]);
    expect(access.hosts).toEqual(["example.test", "github.com"]);
    const off = repoPolicy({ enabled: false, hosts: ["github.com"], allow: [] }, { enabled: true, allowOrgs: ["lerenn"] });
    expect(off.access.enabled).toBe(true);
    expect(off.prefixes).toEqual(["github.com/lerenn"]);
  });

  it("is the old behaviour when the proxy is off", () => {
    expect(repoPolicy(other, { enabled: false, allowOrgs: ["lerenn"] })).toEqual({ access: { enabled: true, hosts: ["github.com"], allow: [] }, prefixes: ["github.com"] });
    expect(repoPolicy({ ...other, enabled: false }, { enabled: false, allowOrgs: [] }).access.enabled).toBe(false);
  });
});

describe("pod setup script", () => {
  it("writes org-scoped insteadOf rules and drops the host-wide ones of an earlier setup", () => {
    const home = mkdtempSync(join(tmpdir(), "kube-home-"));
    const run = (hosts: string) =>
      execFileSync("sh", ["-c", MIRROR_SETUP_SCRIPT, "sh", ...mirrorSetupArgs("/w", { name: "n", email: "e@e" }, [], hosts.split(" "))], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    run("github.com");
    const rules = () => execFileSync("git", ["config", "--global", "--get-regexp", "insteadof"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(rules()).toContain("url.paseo://github.com/.insteadof https://github.com/");
    run("github.com/anyshift-io github.com/lerenn");
    const after = rules();
    expect(after).not.toContain("url.paseo://github.com/.insteadof");
    expect(after).toContain("url.paseo://github.com/anyshift-io/.insteadof https://github.com/anyshift-io/");
    expect(after).toContain("url.paseo://github.com/anyshift-io/.insteadof git@github.com:anyshift-io/");
    expect(after).toContain("url.paseo://github.com/lerenn/.insteadof ssh://git@github.com/lerenn/");
    // a URL of an org outside the list is left alone, one inside is rewritten
    const rewrite = (url: string) => execFileSync("git", ["ls-remote", "--get-url", url], { env: { ...process.env, HOME: home }, encoding: "utf8" }).trim();
    expect(rewrite("git@github.com:anyshift-io/tf-aws.git")).toBe("paseo://github.com/anyshift-io/tf-aws.git");
    expect(rewrite("https://github.com/other/x.git")).toBe("https://github.com/other/x.git");
  });
});

describe("submodule tracking", () => {
  it("parses git submodule status", () => {
    const sha = "a".repeat(40);
    expect(parseSubmoduleStatus(`-${sha} infra/tf-aws\n ${sha} misc/x (heads/main)\n+${sha} y (v1)\n`)).toEqual([
      { path: "infra/tf-aws", checkedOut: false },
      { path: "misc/x", checkedOut: true, sha },
      { path: "y", checkedOut: true, sha },
    ]);
    expect(gitmodulesPaths("submodule.a.path  infra/tf-aws\nsubmodule.b.path misc/x")).toEqual(["infra/tf-aws", "misc/x"]);
  });

  it("reports pending, fetching, ready with progress and an ETA, and wakes waiters", async () => {
    let t = 0;
    const tracker = new SubmoduleTracker(() => t);
    expect(tracker.report(["a"])).toMatchObject({ provisional: true, allReady: false, submodules: [{ path: "a", state: "pending" }] });
    tracker.reset([{ path: "a", checkedOut: false }, { path: "b", checkedOut: false }]);
    expect(tracker.report().submodules.map((s) => s.state)).toEqual(["pending", "pending"]);
    t = 10_000;
    tracker.update("a", "fetching", 0.5);
    const mid = tracker.report();
    expect(mid.allReady).toBe(false);
    expect(mid.submodules[0]).toMatchObject({ state: "fetching", progress: 0.5, etaSeconds: 30 }); // 10 s for half of the 2 units of work
    const waited = tracker.wait("a", 5_000);
    tracker.update("a", "ready", 1);
    await expect(waited).resolves.toMatchObject({ path: "a", state: "ready" });
    expect(tracker.pending()).toEqual(["b"]);
    tracker.finish(false, "boom");
    expect(tracker.report().submodules[1]).toMatchObject({ state: "failed", message: "boom" });
  });

  it("wait gives the current state back on timeout and answers unknown paths at once", async () => {
    vi.useFakeTimers();
    try {
      const tracker = new SubmoduleTracker();
      tracker.reset([{ path: "a", checkedOut: false }]);
      const p = tracker.wait("a", 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toMatchObject({ state: "pending" });
      await expect(tracker.wait("zzz", 1000)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns with the submodule list", () => {
    const w = submoduleWarning(["infra/tf-aws", "misc/annie-deepeval"]);
    expect(w).toContain("submodule_status");
    expect(w).toContain("submodule_wait");
    expect(w).toContain("- infra/tf-aws");
    // the commit it is at is said, so an agent does not take a stale gitlink for the submodule's main
    expect(w).toMatch(/gitlink.*far behind the submodule's own main/);
    expect(w).toContain("git -C <path> fetch origin && git -C <path> checkout --detach origin/HEAD");
    expect(submoduleWarning(["infra/tf-aws"], "remote")).toMatch(/tip of its remote default branch/);
  });

  it("keeps the commit a ready submodule is at across a reset", () => {
    const tracker = new SubmoduleTracker();
    tracker.reset([{ path: "a", checkedOut: false }]);
    tracker.update("a", "ready", 1, undefined, { sha: "b".repeat(40), pinned: "c".repeat(40), at: "remote" });
    expect(tracker.report().submodules[0]).toMatchObject({ sha: "b".repeat(40), pinned: "c".repeat(40), at: "remote" });
    tracker.reset([{ path: "a", checkedOut: true, sha: "b".repeat(40) }]);
    expect(tracker.report().submodules[0]).toMatchObject({ state: "ready", sha: "b".repeat(40), at: "remote" });
  });
});

describe("submodule MCP server", () => {
  it("serves the tools over HTTP for a known token only", async () => {
    const tracker = new SubmoduleTracker();
    tracker.reset([{ path: "infra/tf-aws", checkedOut: false }]);
    const mcp = await startSubmoduleMcp({ lookup: (token) => (token === "tok12345tok" ? { tracker, provisional: async () => [] } : undefined) });
    try {
      const call = async (token: string, body: unknown) => {
        const res = await fetch(`http://127.0.0.1:${mcp.port}/mcp/${token}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
        return { status: res.status, json: res.status === 200 ? ((await res.json()) as any) : null };
      };
      const list = await call("tok12345tok", { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(["submodule_status", "submodule_wait"]);
      expect((await call("tok12345tok", { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const status = await call("tok12345tok", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submodule_status", arguments: {} } });
      expect(JSON.parse(status.json.result.content[0].text).submodules[0]).toMatchObject({ path: "infra/tf-aws", state: "pending" });
      const wait = call("tok12345tok", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "submodule_wait", arguments: { path: "infra/tf-aws", timeout: 30 } } });
      tracker.update("infra/tf-aws", "ready", 1);
      expect(JSON.parse((await wait).json.result.content[0].text)).toMatchObject({ state: "ready" });
      const unknown = await call("nope1234nope", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "submodule_status", arguments: {} } });
      expect(unknown.json.result.isError).toBe(true);
      expect((await fetch(`http://127.0.0.1:${mcp.port}/other`, { method: "POST" })).status).toBe(404);
    } finally {
      mcp.close();
    }
  });

  it("refuses unknown methods", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", id: 1, method: "nope" }, undefined)).toMatchObject({ error: { code: -32601 } });
  });
});

describe("daemon-side provisioning", () => {
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), "kube-proxy-"));
    const p = join(root, "p");
    mkdirSync(p);
    sh(p, "init", "-q", "-b", "main");
    writeFileSync(join(p, ".gitmodules"), '[submodule "tf.aws"]\n\tpath = infra/tf-aws\n\turl = ../tf-aws.git\n[submodule "ann"]\n\tpath = misc/annie-deepeval\n\turl = git@github.com:anyshift-io/annie-deepeval.git\n');
    sh(p, "add", ".");
    sh(p, "commit", "-qm", "m");
    return { root, p, head: sh(p, "rev-parse", "HEAD") };
  };

  it("maps each submodule path to the fetch target serving it", async () => {
    const { p, head } = project();
    const map = await submoduleTargets(runGit, p, "git@github.com:anyshift-io/anyshift-monorepo.git", [head, "not-a-sha"]);
    expect(map).toEqual([
      { path: "infra/tf-aws", targetId: mirrorId("https://github.com/anyshift-io/tf-aws") },
      { path: "misc/annie-deepeval", targetId: mirrorId("https://github.com/anyshift-io/annie-deepeval") },
    ]);
  });

  it("fills the daemon's cache once and skips an unchanged remote the second time", async () => {
    const { root, p } = project();
    const remote = join(root, "sub");
    mkdirSync(remote);
    sh(remote, "init", "-q", "-b", "main");
    writeFileSync(join(remote, "f"), "x");
    sh(remote, "add", ".");
    sh(remote, "commit", "-qm", "s");
    const gate = new MirrorGate({ ttlMs: 0 });
    const target = { id: "bbbbbbbbbbbbbbbb", podUrls: [], daemonUrl: remote, origin: false };
    const first = await refreshMirror(runGit, p, target, gate);
    expect(first.error).toBeUndefined();
    expect(sh(first.dir, "rev-parse", "main")).toBe(sh(remote, "rev-parse", "main"));
    expect(gate.stats.skipped).toBe(0);
    await refreshMirror(runGit, p, target, gate);
    expect(gate.stats.skipped).toBe(1);
  });
});
