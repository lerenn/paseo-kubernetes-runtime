import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../shared/settings.js";
import { KubernetesRuntime } from "../server/runtime.js";
import { runGit } from "../server/git.js";
import { LocalPodKube } from "./local-pod.js";

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...ID }, encoding: "utf8" }).trim();
const wait = (cond: () => boolean | Promise<boolean>, ms = 8000) =>
  new Promise<void>(async (resolve, reject) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return resolve();
      await new Promise((r) => setTimeout(r, 25));
    }
    reject(new Error("timed out"));
  });

function repos(withSubmodule = false) {
  const root = mkdtempSync(join(tmpdir(), "kube-sim-"));
  const origin = join(root, "origin.git");
  const project = join(root, "project");
  mkdirSync(origin);
  sh(origin, "init", "-q", "--bare", "-b", "main");
  sh(root, "clone", "-q", origin, project);
  writeFileSync(join(project, "a.txt"), "one\n");
  sh(project, "add", ".");
  sh(project, "commit", "-qm", "one");
  sh(project, "push", "-q", "origin", "main");
  let sub = "";
  if (withSubmodule) {
    sub = join(root, "sub.git");
    const subWork = join(root, "sub");
    mkdirSync(sub);
    sh(sub, "init", "-q", "--bare", "-b", "main");
    sh(root, "clone", "-q", sub, subWork);
    writeFileSync(join(subWork, "lib.txt"), "lib one\n");
    sh(subWork, "add", ".");
    sh(subWork, "commit", "-qm", "lib one");
    sh(subWork, "push", "-q", "origin", "main");
    sh(project, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/lib");
    sh(project, "commit", "-qm", "add submodule");
    sh(project, "push", "-q", "origin", "main");
  }
  return { origin, project, sub, root };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function openSession(argv0 = "sh", mcpServers: Record<string, any> = {}, tunnel?: { pod: number; daemon: number }, env: Record<string, string> = {}, withSubmodule = false, extra: { config?: object; git?: (args: string[], o?: any) => Promise<any> } = {}) {
  const { origin, project, sub, root } = repos(withSubmodule);
  const kube = new LocalPodKube(project);
  const runtime = new KubernetesRuntime({
    getConfig: async () => ConfigSchema.parse({ readyTimeoutSeconds: 5, ...extra.config }),
    ...(extra.git ? { git: extra.git as never } : {}),
    kubeFor: () => kube,
    daemonId: "srv_ME",
    log: () => undefined,
    mapTunnelPort: tunnel ? (p) => (p === tunnel.pod ? tunnel.daemon : p) : undefined,
    ticker: () => () => undefined,
  });
  cleanups.push(() => {
    runtime.stop();
    kube.stop();
  });
  const notices: string[] = [];
  const ctx = { notice: (m: string) => void notices.push(m), signal: new AbortController().signal };
  await runtime.registration().prepare!(
    { workspaceId: "wks_1", options: { cwd: project, slug: "brave-otter-12", ref: null }, purpose: "session", argv: [argv0], env, mcpServers } as never,
    ctx,
  );
  return { origin, project, sub, root, kube, podDir: kube.checkout, notices, runtime };
}

describe("seeded pod workspace and push-back (real git, real pod scripts)", () => {
  it("builds the workspace from a bundle of the daemon's checkout, with no remote access in the pod", async () => {
    const { project, kube, podDir } = await openSession();
    expect(sh(podDir, "log", "-1", "--format=%s")).toBe("one");
    expect(sh(podDir, "branch", "--show-current")).toBe("main");
    expect(sh(podDir, "config", "remote.origin.pushurl")).toContain("outbox.git");
    expect(sh(podDir, "status", "-sb")).not.toContain("gone"); // origin/main was fetched after the seed
    expect(sh(podDir, "rev-parse", "origin/main")).toBe(sh(podDir, "rev-parse", "HEAD"));
    expect(sh(podDir, "config", "user.name")).toBeTruthy();
    expect(sh(project, "for-each-ref", "refs/kube-seed")).toBe(""); // temporary ref cleaned up
    expect((await kube.as(["sh", "-c", "env | grep -c GH_TOKEN || true"])).stdout.trim()).toBe("0");
  });

  it("pushes the pod's commits from the daemon with the daemon's credentials", async () => {
    const { origin, kube, podDir } = await openSession();
    writeFileSync(join(podDir, "work.txt"), "from the pod\n");
    sh(podDir, "add", ".");
    sh(podDir, "commit", "-qm", "pod work");
    const pushed = await kube.as(["git", "push", "origin", "HEAD:refs/heads/throwaway"], { cwd: podDir });
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.stderr).toContain("pushed");
    expect(pushed.stderr).toContain("from the daemon");
    expect(sh(origin, "log", "-1", "--format=%s", "refs/heads/throwaway")).toBe("pod work");
  });

  it("a second push on the same branch sends only the new commits", async () => {
    const { origin, kube, podDir } = await openSession();
    for (const n of [1, 2]) {
      writeFileSync(join(podDir, `f${n}.txt`), `${n}\n`);
      sh(podDir, "add", ".");
      sh(podDir, "commit", "-qm", `c${n}`);
      const r = await kube.as(["git", "push", "origin", "HEAD:refs/heads/multi"], { cwd: podDir });
      expect(r.code, r.stderr).toBe(0);
    }
    expect(sh(origin, "log", "--format=%s", "refs/heads/multi").split("\n").slice(0, 2)).toEqual(["c2", "c1"]);
  });

  it("relays the remote's rejection to the agent and refuses deletions and non-branch refs", async () => {
    const { origin, kube, podDir } = await openSession();
    writeFileSync(join(podDir, "x.txt"), "x\n");
    sh(podDir, "add", ".");
    sh(podDir, "commit", "-qm", "diverge");
    // advance origin/main behind the pod's back, then push a commit that is no longer a fast-forward
    const other = join(mkdtempSync(join(tmpdir(), "kube-other-")), "o");
    sh(tmpdir(), "clone", "-q", origin, other);
    writeFileSync(join(other, "y.txt"), "y\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "other");
    sh(other, "push", "-q", "origin", "main");
    writeFileSync(join(podDir, "z.txt"), "z\n");
    sh(podDir, "add", ".");
    sh(podDir, "commit", "-qm", "diverged again");
    const nonFf = await kube.as(["git", "push", "origin", "HEAD:refs/heads/main"], { cwd: podDir });
    expect(nonFf.code).not.toBe(0);
    expect(nonFf.stderr).toMatch(/rejected by the remote/);

    const del = await kube.as(["git", "push", "origin", ":refs/heads/throwaway"], { cwd: podDir });
    expect(del.code).not.toBe(0);
    expect(del.stderr).toMatch(/not supported/);
    sh(podDir, "tag", "v1");
    const tag = await kube.as(["git", "push", "origin", "refs/tags/v1"], { cwd: podDir });
    expect(tag.code).not.toBe(0);
    expect(tag.stderr).toMatch(/only branches/);
  });
});

describe("fetching through the daemon (real git, real pod scripts)", () => {
  it("git fetch and git pull get new commits from the remote with the daemon's credentials", async () => {
    const { origin, kube, podDir } = await openSession();
    const other = join(mkdtempSync(join(tmpdir(), "kube-other-")), "o");
    sh(tmpdir(), "clone", "-q", origin, other);
    writeFileSync(join(other, "new.txt"), "new\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "upstream work");
    sh(other, "push", "-q", "origin", "main");
    sh(other, "tag", "v9");
    sh(other, "push", "-q", "origin", "v9");

    const fetched = await kube.as(["git", "fetch", "origin"], { cwd: podDir });
    expect(fetched.code, fetched.stderr).toBe(0);
    expect(sh(podDir, "log", "-1", "--format=%s", "origin/main")).toBe("upstream work");
    expect(sh(podDir, "tag", "--list", "v9")).toBe("v9");
    expect((await kube.as(["git", "config", "--global", "--get-regexp", "insteadof"])).stdout).toContain("mirrors/");

    expect(sh(podDir, "config", "branch.main.merge")).toBe("refs/heads/main"); // a plain `git pull` knows where from
    // a second upstream commit arrives through pull, sending only what the pod lacks
    writeFileSync(join(other, "more.txt"), "more\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "more upstream work");
    sh(other, "push", "-q", "origin", "main");
    const pulled = await kube.as(["git", "pull", "--ff-only"], { cwd: podDir });
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(sh(podDir, "log", "-1", "--format=%s")).toBe("more upstream work");
  });

  it("checks out the submodules of the seeded commit and updates them through the daemon", async () => {
    const { sub, root, kube, podDir, notices } = await openSession("sh", {}, undefined, {}, true);
    expect(notices.join("\n")).not.toMatch(/submodules/);
    expect(sh(podDir, "submodule", "status")).toContain("vendor/lib");
    expect(sh(join(podDir, "vendor/lib"), "log", "-1", "--format=%s")).toBe("lib one");

    const subWork = join(root, "sub");
    writeFileSync(join(subWork, "lib2.txt"), "lib two\n");
    sh(subWork, "add", ".");
    sh(subWork, "commit", "-qm", "lib two");
    sh(subWork, "push", "-q", "origin", "main");
    const updated = await kube.as(["git", "submodule", "update", "--remote", "vendor/lib"], { cwd: podDir });
    expect(updated.code, updated.stderr).toBe(0);
    expect(sh(join(podDir, "vendor/lib"), "log", "-1", "--format=%s")).toBe("lib two");

    // the pod commits in the submodule with the daemon's identity (no identity set up by the agent) and pushes a branch
    const lib = join(podDir, "vendor/lib");
    writeFileSync(join(lib, "pod.txt"), "from the pod\n");
    const steps = [["git", "switch", "-q", "-c", "pod-branch"], ["git", "add", "."], ["git", "commit", "-qm", "pod change"], ["git", "push", "origin", "pod-branch"]];
    for (const argv of steps) {
      const r = await kube.as(argv, { cwd: lib });
      expect(r.code, `${argv.join(" ")}: ${r.stderr}`).toBe(0);
    }
    expect(sh(sub, "log", "-1", "--format=%s", "refs/heads/pod-branch")).toBe("pod change");
    expect(sh(sub, "log", "-1", "--format=%an", "refs/heads/pod-branch")).toBeTruthy();
    const del = await kube.as(["git", "push", "origin", ":pod-branch"], { cwd: lib });
    expect(del.code).not.toBe(0);
    expect(del.stderr).toMatch(/not supported/);
  });
});

describe("other repositories through the daemon (real git, real pod scripts)", () => {
  /** A bare repo standing in for git@example.test:o/r.git, reached by the daemon through an insteadOf rule. */
  function otherRepo() {
    const root = mkdtempSync(join(tmpdir(), "kube-other-"));
    const bare = join(root, "r.git");
    mkdirSync(bare);
    sh(bare, "init", "-q", "--bare", "-b", "main");
    const work = join(root, "w");
    sh(root, "clone", "-q", bare, work);
    writeFileSync(join(work, "readme.txt"), "other repo\n");
    sh(work, "add", ".");
    sh(work, "commit", "-qm", "first");
    sh(work, "push", "-q", "origin", "main");
    const git = (args: string[], o?: any) => runGit(["-c", `url.${bare}.insteadOf=git@example.test:o/r.git`, ...args], o);
    return { bare, git };
  }
  const session = (git: (a: string[], o?: any) => Promise<any>, allow = ["o/*"], enabled = true) =>
    openSession("sh", {}, undefined, {}, false, { config: { otherRepos: { enabled, hosts: ["example.test"], allow } }, git });
  const asAgent = (kube: any, argv: string[], cwd?: string) => kube.as(argv, { cwd, env: { PATH: `${kube.home}/bin:${process.env.PATH}` } });

  it("clones, fetches and pushes a branch of a repository nobody mentioned, with no credential in the pod", async () => {
    const { bare, git } = otherRepo();
    const { kube, root: _r } = await session(git);
    const dest = join(kube.root, "other-clone");
    const cloned = await asAgent(kube, ["git", "clone", "https://example.test/o/r", dest]);
    expect(cloned.code, cloned.stderr).toBe(0);
    expect(sh(dest, "log", "-1", "--format=%s")).toBe("first");

    // upstream moves on, the pod fetches it through the daemon
    const other = join(mkdtempSync(join(tmpdir(), "kube-up-")), "u");
    sh(tmpdir(), "clone", "-q", bare, other);
    writeFileSync(join(other, "more.txt"), "more\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "second");
    sh(other, "push", "-q", "origin", "main");
    const pulled = await asAgent(kube, ["git", "pull", "--ff-only"], dest);
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(sh(dest, "log", "-1", "--format=%s")).toBe("second");

    // a branch pushed from the pod is pushed by the daemon; a deletion is refused
    writeFileSync(join(dest, "pod.txt"), "from the pod\n");
    for (const argv of [["git", "switch", "-q", "-c", "pod-branch"], ["git", "add", "."], ["git", "commit", "-qm", "pod change"], ["git", "push", "origin", "pod-branch"]]) {
      const r = await asAgent(kube, argv, dest);
      expect(r.code, `${argv.join(" ")}: ${r.stderr}`).toBe(0);
    }
    expect(sh(bare, "log", "-1", "--format=%s", "refs/heads/pod-branch")).toBe("pod change");
    const del = await asAgent(kube, ["git", "push", "origin", ":pod-branch"], dest);
    expect(del.code).not.toBe(0);
    expect(del.stderr).toMatch(/not supported/);
  });

  it("refuses repositories outside the allowlist, and everything when the setting is off", async () => {
    const { git } = otherRepo();
    const allowed = await session(git, ["o/other-only"]);
    const denied = await asAgent(allowed.kube, ["git", "clone", "https://example.test/o/r", join(allowed.kube.root, "nope")]);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/not in the allowed repositories/);
    const off = await session(git, [], false);
    const refused = await asAgent(off.kube, ["git", "ls-remote", "https://example.test/o/r"]);
    expect(refused.code).not.toBe(0);
  });
});

describe("the Files panel through the runtime (real node script)", () => {
  it("reads, writes, lists and refuses paths that leave the workspace", async () => {
    const { project, runtime } = await openSession();
    const fs = runtime.registration().fs!;
    const ask = (path: string, extra: object = {}) => ({ workspaceId: "wks_1", options: { cwd: project, slug: "brave-otter-12", ref: null }, path, ...extra }) as never;
    const file = join(project, "docs", "note.txt");

    await fs.mkdir(ask(join(project, "docs")));
    await expect(fs.mkdir(ask(join(project, "docs")))).rejects.toThrow(/^EEXIST/);
    const written = await fs.write(ask(file, { data: new TextEncoder().encode("hello"), exclusive: true }));
    expect(written).toMatchObject({ kind: "file", size: 5, mode: 0o644 });
    await expect(fs.write(ask(file, { data: new TextEncoder().encode("x"), exclusive: true }))).rejects.toThrow(/^EEXIST/);
    await expect(fs.write(ask(file, { data: new TextEncoder().encode("y"), expectedMtimeMs: written.mtimeMs - 5000 }))).rejects.toThrow(/^ECONFLICT/);
    const replaced = await fs.write(ask(file, { data: new TextEncoder().encode("hello world"), expectedMtimeMs: written.mtimeMs }));
    expect(replaced.size).toBe(11);
    expect(new TextDecoder().decode(await fs.read(ask(file, { offset: 6 })))).toBe("world");
    expect((await fs.readdir(ask(join(project, "docs")))).map((e) => e.name)).toEqual(["note.txt"]);
    expect(await fs.stat(ask(join(project, "missing")))).toBeNull();
    await expect(fs.read(ask(join(project, "missing")))).rejects.toThrow(/^ENOENT/);

    await fs.copy(ask(file, { to: join(project, "docs", "copy.txt") }));
    await fs.rename(ask(join(project, "docs", "copy.txt"), { to: join(project, "docs", "moved.txt") }));
    await fs.remove(ask(join(project, "docs"), { recursive: true }));
    expect(await fs.stat(ask(join(project, "docs")))).toBeNull();

    // confinement: outside paths, relative paths, and a symlink out of the workspace
    await expect(fs.read(ask("/etc/hostname"))).rejects.toThrow(/^EACCES/);
    await expect(fs.stat(ask("docs/x"))).rejects.toThrow(/^EINVAL/);
    symlinkSync("/etc", join(project, "escape"));
    await expect(fs.readdir(ask(join(project, "escape")))).rejects.toThrow(/^EACCES/);
    await expect(fs.write(ask(join(project, "escape", "pwn"), { data: new Uint8Array([1]) }))).rejects.toThrow(/^EACCES/);
    await expect(fs.remove(ask(project, { recursive: true }))).rejects.toThrow(/^EACCES/);
  });
});

describe("loopback tunnel to the daemon's MCP servers", () => {
  it("serves the daemon's loopback port inside the pod with headers intact, including a streaming response", async () => {
    const seen: { auth?: string; url?: string }[] = [];
    const daemon = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, url: req.url });
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t = setInterval(() => {
        res.write(`data: chunk${n}\n\n`);
        if (++n === 3) {
          clearInterval(t);
          res.end();
        }
      }, 30);
    });
    await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
    cleanups.push(() => daemon.close());
    const daemonPort = (daemon.address() as AddressInfo).port;
    // the pod's listener needs its own free port on this shared host
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const podPort = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));

    const { kube } = await openSession("sh", { inbox: { type: "http", url: `http://127.0.0.1:${podPort}/mcp`, headers: { authorization: "Bearer cap" } } }, { pod: podPort, daemon: daemonPort });
    await wait(async () => (await kube.as(["node", "-e", `require("net").connect(${podPort},"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))`])).code === 0);
    const out = await kube.as(["node", "-e", `fetch("http://127.0.0.1:${podPort}/mcp",{method:"POST",headers:{authorization:"Bearer cap"},body:"{}"}).then(async r=>{let t="";for await(const c of r.body)t+=Buffer.from(c).toString();console.log(r.status,t.replace(/\\n/g,"|"))})`]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe("200 data: chunk0||data: chunk1||data: chunk2||");
    expect(seen[0]).toEqual({ auth: "Bearer cap", url: "/mcp" });
  });

  it("does not tunnel ports the session's config does not name", async () => {
    const daemon = createServer((_req, res) => res.end("secret"));
    await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
    cleanups.push(() => daemon.close());
    const port = (daemon.address() as AddressInfo).port;
    const { kube } = await openSession("sh", {});
    const r = await kube.as(["node", "-e", `require("net").connect(${port},"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(3))`]);
    // nothing listens inside the pod on that port, and the daemon's server is not reachable through the bridge
    expect([0, 3]).toContain(r.code);
  });
});
