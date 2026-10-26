import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGit } from "../server/git.js";
import { parseSubmoduleMarker, submoduleBackoffMs } from "../server/pod-setup.js";
import { CHUNK_BYTES, applyFetch, serveFetchChunk, fetchTargets, otherRepoTarget, repoAllowed, resolveSubmoduleUrl } from "../server/mirrors.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, encoding: "utf8" }).trim();

describe("fetch targets", () => {
  it("resolves relative submodule URLs against the project's remote", () => {
    expect(resolveSubmoduleUrl("https://github.com/o/r", "../other.git")).toBe("https://github.com/o/other.git");
    expect(resolveSubmoduleUrl("https://github.com/o/r", "./x")).toBe("https://github.com/o/r/x");
    expect(resolveSubmoduleUrl("https://github.com/o/r", "https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
  });

  it("lists the origin and the submodules recorded at the given commits, and refuses anything else", async () => {
    const root = mkdtempSync(join(tmpdir(), "kube-mirrors-"));
    const project = join(root, "p");
    mkdirSync(project);
    sh(project, "init", "-q", "-b", "main");
    writeFileSync(join(project, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ../lib.git\n');
    sh(project, "add", ".");
    sh(project, "commit", "-qm", "m");
    const head = sh(project, "rev-parse", "HEAD");
    const targets = await fetchTargets(runGit, project, "git@github.com:o/r.git", [head]);
    expect(targets.map((t) => [t.origin, t.daemonUrl])).toEqual([
      [true, "git@github.com:o/r.git"],
      [false, "git@github.com:o/lib.git"], // ssh stays ssh for the daemon

    ]);
    expect(targets[0]!.podUrls).toContain("https://github.com/o/r.git");
    expect(targets[1]!.podUrls).toContain("https://github.com/o/lib.git");

    const refused = await applyFetch(runGit, project, { op: "fetch", mirror: "deadbeefdeadbeef", haves: [] }, targets);
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/not part of the project/);
    const malformed = await applyFetch(runGit, project, { op: "fetch", mirror: targets[0]!.id, haves: ["--upload-pack=x"] }, targets);
    expect(malformed.ok).toBe(false);
  });
});

describe("big fetches", () => {
  it("spools a pack over the inline size to a file and serves it in chunks that index into a working repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "kube-bigfetch-"));
    const remote = join(root, "remote");
    const project = join(root, "project");
    mkdirSync(remote);
    mkdirSync(project);
    sh(remote, "init", "-q", "-b", "main");
    writeFileSync(join(remote, "blob.bin"), randomBytes(13 * 1024 * 1024)); // incompressible: a pack of about 13 MB, three chunks
    sh(remote, "add", ".");
    sh(remote, "commit", "-qm", "big");
    sh(project, "init", "-q", "-b", "main");
    const target = { id: "aaaaaaaaaaaaaaaa", podUrls: [], daemonUrl: remote, origin: true };

    const reply = await applyFetch(runGit, project, { op: "fetch", mirror: target.id, haves: [] }, [target]);
    expect(reply.ok).toBe(true);
    expect(reply.pack).toBeUndefined();
    expect(reply.packBytes).toBeGreaterThan(12 * 1024 * 1024);

    const mine = join(root, "pod.git");
    sh(root, "init", "-q", "--bare", mine);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < reply.packBytes!; ) {
      const chunk = serveFetchChunk({ op: "fetch-chunk", packId: reply.packId!, offset });
      expect(chunk.ok).toBe(true);
      const bytes = Buffer.from(chunk.data!, "base64");
      expect(bytes.length).toBeLessThanOrEqual(CHUNK_BYTES);
      parts.push(bytes);
      offset += bytes.length;
    }
    execFileSync("git", ["--git-dir", mine, "index-pack", "--stdin", "--fix-thin"], { input: Buffer.concat(parts) });
    expect(execFileSync("git", ["--git-dir", mine, "cat-file", "-t", reply.refs![0]![1]], { encoding: "utf8" }).trim()).toBe("commit");
    // the last chunk released the spool
    expect(serveFetchChunk({ op: "fetch-chunk", packId: reply.packId!, offset: 0 }).ok).toBe(false);
    expect(serveFetchChunk({ op: "fetch-chunk", packId: "not-an-id", offset: 0 }).ok).toBe(false);
  }, 60_000);

  it("keeps small packs in the reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "kube-smallfetch-"));
    const remote = join(root, "remote");
    const project = join(root, "project");
    mkdirSync(remote);
    mkdirSync(project);
    sh(remote, "init", "-q", "-b", "main");
    writeFileSync(join(remote, "a.txt"), "hello\n");
    sh(remote, "add", ".");
    sh(remote, "commit", "-qm", "small");
    sh(project, "init", "-q", "-b", "main");
    const target = { id: "bbbbbbbbbbbbbbbb", podUrls: [], daemonUrl: remote, origin: true };
    const reply = await applyFetch(runGit, project, { op: "fetch", mirror: target.id, haves: [] }, [target]);
    expect(reply.ok).toBe(true);
    expect(reply.pack).toBeTruthy();
    expect(reply.packId).toBeUndefined();
  });
});

describe("other repositories", () => {
  const access = { enabled: true, hosts: ["github.com"], allow: [] as string[] };
  it("matches owner/* and owner/repo patterns, case-insensitively; empty allows all", () => {
    expect(repoAllowed("Acme/App", [])).toBe(true);
    expect(repoAllowed("acme/app", ["ACME/*"])).toBe(true);
    expect(repoAllowed("acme/app", ["acme/other"])).toBe(false);
    expect(repoAllowed("evil/app", ["acme/*"])).toBe(false);
  });

  it("builds ssh-then-https targets for allowed hosts and refuses the rest", () => {
    const ok = otherRepoTarget("x:github.com/anyshift-io/lfradin-lab", access);
    expect(ok).toMatchObject({ daemonUrl: "git@github.com:anyshift-io/lfradin-lab.git", fallbackUrls: ["https://github.com/anyshift-io/lfradin-lab.git"] });
    expect(otherRepoTarget("x:gitlab.com/o/r", access)).toHaveProperty("refused");
    expect(otherRepoTarget("x:github.com/o/r", { ...access, allow: ["acme/*"] })).toHaveProperty("refused");
    expect(otherRepoTarget("x:github.com/o/r", { ...access, enabled: false })).toHaveProperty("refused");
    for (const bad of ["x:github.com/o", "x:github.com/../r", "x:github.com/o/r --upload-pack=x", "github.com/o/r", "x:github.com/o/.hidden"]) {
      expect(otherRepoTarget(bad, access), bad).toHaveProperty("refused");
    }
  });
});


describe("submodule fetch backoff", () => {
  it("waits 30 minutes after the first failure, doubling up to 4 hours", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => submoduleBackoffMs(n) / 60_000)).toEqual([30, 60, 120, 240, 240, 240]);
    expect(parseSubmoduleMarker("1700000000000 3\n")).toEqual({ at: 1700000000000, attempts: 3 });
    expect(parseSubmoduleMarker("garbage")).toBeNull();
  });
});
