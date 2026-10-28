import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPush, type BridgeReply, type PushRequest } from "./bridge.js";
import { type GitRunner, scrub } from "./git.js";
import { type MirrorGate, type RemoteListing, mirrorGate } from "./mirror-gate.js";
import { toHttpsRemote } from "./workspace.js";

/**
 * A remote the pod may fetch from: the project's origin and its submodules. The pod sees each one as a local
 * mirror repository (git rewrites the remote's URL to it); the daemon refreshes the mirror from `daemonUrl`
 * with its own credentials when the pod asks, so the pod never holds a GitHub credential.
 */
export interface FetchTarget {
  /** Directory name of the mirror in the pod (`$HOME/mirrors/<id>.git`). */
  id: string;
  /** URLs git in the pod may use for this remote. */
  podUrls: string[];
  /** URL the daemon fetches from. */
  daemonUrl: string;
  /** The project's origin: its mirror borrows objects from the pod's checkout. */
  origin: boolean;
  /** Tried in turn when `daemonUrl` fails (a repository made on demand is first tried over ssh, then https). */
  fallbackUrls?: string[];
}

/** What a pod may reach besides the project's own remotes (the "Other repositories" setting). */
export interface RepoAccess {
  enabled: boolean;
  hosts: string[];
  allow: string[];
  /** Hosts (lower case) where only these owners are reachable, from the git proxy's `allowOrgs`. */
  scoped?: Record<string, string[]>;
}

/**
 * What a pod may clone through the daemon: the "Other repositories" setting, with the git proxy's org list narrowing
 * github.com (and turning the feature on for it). `prefixes` are the `host` or `host/org` entries the pod's `insteadOf`
 * rules are made from.
 */
export function repoPolicy(
  otherRepos: { enabled: boolean; hosts: string[]; allow: string[] },
  gitProxy: { enabled: boolean; allowOrgs: string[] },
): { access: RepoAccess; prefixes: string[] } {
  const hosts = otherRepos.enabled ? [...otherRepos.hosts] : [];
  if (gitProxy.enabled && !hosts.some((h) => h.toLowerCase() === "github.com")) hosts.push("github.com");
  const scoped = gitProxy.enabled ? { "github.com": gitProxy.allowOrgs.map((o) => o.toLowerCase()) } : undefined;
  const prefixes = hosts.flatMap((h) => (scoped && h.toLowerCase() === "github.com" ? scoped["github.com"]!.map((o) => `github.com/${o}`) : [h]));
  return { access: { enabled: hosts.length > 0, hosts, allow: otherRepos.enabled ? otherRepos.allow : [], ...(scoped ? { scoped } : {}) }, prefixes };
}

const REPO_PART = /^[A-Za-z0-9_.-]+$/;

/** Whether `owner/repo` matches one of the `owner/*` or `owner/repo` patterns (an empty list allows all). */
export function repoAllowed(ownerRepo: string, allow: readonly string[]): boolean {
  if (allow.length === 0) return true;
  const [owner, repo] = ownerRepo.toLowerCase().split("/");
  return allow.some((pattern) => {
    const [o, r] = pattern.toLowerCase().split("/");
    return o === owner && (r === "*" || r === repo);
  });
}

/** The target for a repository a pod asked for by name (`x:host/owner/repo`), or why it is refused. */
export function otherRepoTarget(id: string, access: RepoAccess): FetchTarget | { refused: string } {
  if (!access.enabled) return { refused: "fetching other repositories from a pod is turned off in the Kubernetes Runtime settings" };
  const m = /^x:([A-Za-z0-9.-]+)\/([^/]+)\/([^/]+)$/.exec(id);
  if (!m) return { refused: "malformed repository name" };
  const [, host, owner, repo] = m as unknown as [string, string, string, string];
  if (!REPO_PART.test(owner) || !REPO_PART.test(repo) || owner.startsWith(".") || repo.startsWith(".")) return { refused: "malformed repository name" };
  if (!access.hosts.some((h) => h.toLowerCase() === host.toLowerCase())) return { refused: `${host} is not one of the hosts pods may reach (${access.hosts.join(", ") || "none"})` };
  const orgs = access.scoped?.[host.toLowerCase()];
  if (orgs && !orgs.includes(owner.toLowerCase())) return { refused: `${owner} is not one of the orgs pods may clone from through the daemon (${orgs.join(", ") || "none"}; the git proxy's allowOrgs)` };
  if (!repoAllowed(`${owner}/${repo}`, access.allow)) return { refused: `${owner}/${repo} is not in the allowed repositories` };
  return {
    id,
    podUrls: [],
    // the daemon's ssh key first (it is the one that reaches a user's own repositories), then its https credentials
    daemonUrl: `git@${host}:${owner}/${repo}.git`,
    fallbackUrls: [`https://${host}/${owner}/${repo}.git`],
    origin: false,
  };
}

/** The URL that worked last for a target, so the next fetch and a push use it directly. */
const workingUrls = new Map<string, string>();

/** Packs up to this size travel inside the fetch reply; bigger ones are spooled to a file and pulled in chunks. */
const INLINE_PACK_BYTES = 4 * 1024 * 1024;
/** One chunk of a spooled pack (about 8 MB as base64 in one bridge message). */
export const CHUNK_BYTES = 6 * 1024 * 1024;
/** The most one fetch relays; a bigger repository needs a shallower fetch, not a longer wait. */
const MAX_FETCH_BYTES = 4 * 1024 * 1024 * 1024;
const SPOOL_TTL_MS = 30 * 60_000;
const SHA = /^[0-9a-f]{40}$/;

export const mirrorId = (url: string): string => createHash("sha1").update(url).digest("hex").slice(0, 16);

const normalize = (url: string) => toHttpsRemote(url).replace(/\.git$/, "").replace(/\/$/, "");

/** Resolves a submodule URL (possibly relative, like `../other.git`) against the project's remote. */
export function resolveSubmoduleUrl(base: string, url: string): string {
  if (!url.startsWith("./") && !url.startsWith("../")) return url;
  const parts = base.replace(/\.git$/, "").replace(/\/$/, "").split("/");
  for (const seg of url.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** `.gitmodules` URLs recorded at the given commits of the daemon's checkout. */
async function submoduleUrls(git: GitRunner, cwd: string, shas: readonly string[]): Promise<string[]> {
  const urls = new Set<string>();
  for (const sha of shas) {
    if (!SHA.test(sha)) continue;
    const r = await git(["config", "--blob", `${sha}:.gitmodules`, "--get-regexp", "^submodule\\..*\\.url$"], { cwd });
    if (r.code !== 0) continue;
    for (const line of r.stdout.split("\n")) {
      const url = line.replace(/^\S+\s+/, "").trim();
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

/** Each submodule recorded at the given commits (path and the fetch target serving its remote), the first commit that names a path wins. */
export async function submoduleTargets(git: GitRunner, cwd: string, originUrl: string, shas: readonly string[]): Promise<{ path: string; targetId: string }[]> {
  const found = new Map<string, string>();
  for (const sha of shas) {
    if (!SHA.test(sha)) continue;
    const r = await git(["config", "--blob", `${sha}:.gitmodules`, "--get-regexp", "^submodule\\..*\\.(path|url)$"], { cwd });
    if (r.code !== 0) continue;
    const byName = new Map<string, { path?: string; url?: string }>();
    for (const line of r.stdout.split("\n")) {
      const m = /^submodule\.(.+)\.(path|url)\s+(.+)$/.exec(line.trim());
      if (m) byName.set(m[1]!, { ...byName.get(m[1]!), [m[2] as "path" | "url"]: m[3]!.trim() });
    }
    for (const { path, url } of byName.values()) {
      if (path && url && !found.has(path)) found.set(path, mirrorId(normalize(resolveSubmoduleUrl(originUrl, url))));
    }
  }
  return [...found].map(([path, targetId]) => ({ path, targetId }));
}

/** Everything the pod may fetch from: the project's origin, plus the submodules recorded at `shas`. */
export async function fetchTargets(
  git: GitRunner,
  cwd: string,
  originUrl: string,
  shas: readonly string[],
): Promise<FetchTarget[]> {
  const originHttps = toHttpsRemote(originUrl);
  const targets: FetchTarget[] = [
    { id: mirrorId(normalize(originUrl)), podUrls: [...new Set([originHttps, originUrl])], daemonUrl: originUrl, origin: true },
  ];
  for (const raw of await submoduleUrls(git, cwd, shas)) {
    // the daemon fetches the way the project is configured (ssh stays ssh, so the right key is used); the pod
    // may name the submodule either way
    const resolved = resolveSubmoduleUrl(originUrl, raw);
    const id = mirrorId(normalize(resolved));
    if (targets.some((t) => t.id === id)) continue;
    const viaHttps = resolveSubmoduleUrl(originHttps, raw);
    targets.push({ id, podUrls: [...new Set([resolved, toHttpsRemote(resolved), viaHttps])], daemonUrl: resolved, origin: false });
  }
  return targets;
}

/**
 * Shell run in the pod to (re)create the mirrors and point git at them. Idempotent. `HOME` is the volume, so the
 * global config survives pod restarts and applies to submodules too.
 */
export const MIRROR_SETUP_SCRIPT = `set -e
mkdir -p "$HOME/mirrors"
git config --global protocol.file.allow always
git config --global push.autoSetupRemote true
git config --global remote.origin.uploadpack "$HOME/bin/paseo-upload-pack"
cwd="$1"; name="$2"; email="$3"; hosts="$4"; shift 4
# pods made before the outbox hook packed from the checkout learn where it is
[ -d "$HOME/outbox.git" ] && git config --file "$HOME/outbox.git/config" paseo.checkout "$cwd"
# every URL of an allowed host (or of one of its orgs, "host/org") goes through git-remote-paseo, which serves a mirror
# of that repository; the longer rules for the project's own remotes below win over these. Rules of an earlier setup
# (a whole host before it was narrowed to orgs) are dropped first.
for k in $(git config --global --name-only --get-regexp '^url\\.paseo://.*\\.insteadof$' 2>/dev/null || true); do git config --global --unset-all "$k" || true; done
for h in $hosts; do
  host=$(printf %s "$h" | cut -d/ -f1)
  org=$(printf %s "$h" | cut -s -d/ -f2)
  if [ -n "$org" ]; then org="$org/"; fi
  for prefix in "https://$host/$org" "git@$host:$org" "ssh://git@$host/$org"; do git config --global --add "url.paseo://$host/$org.insteadOf" "$prefix"; done
done
git config --global user.name "$name"
git config --global user.email "$email"
while [ $# -gt 0 ]; do
  id="$1"; origin="$2"; shift 2
  urls=""
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do urls="$urls $1"; shift; done
  [ "$1" = "--" ] && shift
  d="$HOME/mirrors/$id.git"
  [ -d "$d" ] || git init -q --bare "$d"
  mkdir -p "$d/hooks" "$d/objects/info"
  cp "$HOME/mirror-pre-receive" "$d/hooks/pre-receive"
  if [ "$origin" = "1" ]; then echo "$cwd/.git/objects" > "$d/objects/info/alternates"; fi
  # file:// (not a bare path) so clones go through upload-pack instead of copying the still-empty mirror
  git config --global --unset-all "url.file://$d.insteadOf" || true
  for u in $urls; do git config --global --add "url.file://$d.insteadOf" "$u"; done
done
`;

/** Arguments of `MIRROR_SETUP_SCRIPT` after `sh -c <script> sh`. */
export function mirrorSetupArgs(
  cwd: string,
  identity: { name: string; email: string },
  targets: readonly FetchTarget[],
  /** `host` or `host/org` entries (see `repoPolicy`). */
  hosts: readonly string[] = [],
): string[] {
  return [cwd, identity.name, identity.email, hosts.join(" "), ...targets.flatMap((t) => [t.id, t.origin ? "1" : "0", ...t.podUrls, "--"])];
}

export type FetchRequest = { op: "fetch"; mirror: string; haves: string[] };
/** The pod asks for the next part of a spooled pack. */
export type FetchChunkRequest = { op: "fetch-chunk"; /** Not `id`: the bridge numbers its messages with that. */ packId: string; offset: number };

interface Spool {
  file: string;
  size: number;
  at: number;
}
const spools = new Map<string, Spool>();

const dropSpool = (id: string) => {
  const spool = spools.get(id);
  if (spool) rmSync(spool.file, { force: true });
  spools.delete(id);
};
const sweepSpools = (now = Date.now()) => {
  for (const [id, spool] of spools) if (now - spool.at > SPOOL_TTL_MS) dropSpool(id);
};

/** The next chunk of a spooled pack; the last one releases the file. */
export function serveFetchChunk(request: FetchChunkRequest): BridgeReply & { data?: string; eof?: boolean } {
  const spool = /^[0-9a-f]{12}$/.test(request.packId) ? spools.get(request.packId) : undefined;
  if (!spool || !Number.isInteger(request.offset) || request.offset < 0 || request.offset > spool.size) {
    return { ok: false, message: "kube-agents: that fetch is no longer available; run the command again" };
  }
  const length = Math.min(CHUNK_BYTES, spool.size - request.offset);
  const buffer = Buffer.alloc(length);
  const fd = openSync(spool.file, "r");
  try {
    readSync(fd, buffer, 0, length, request.offset);
  } finally {
    closeSync(fd);
  }
  const eof = request.offset + length >= spool.size;
  spool.at = Date.now();
  if (eof) dropSpool(request.packId);
  return { ok: true, data: buffer.toString("base64"), eof };
}

export interface FetchReply {
  ok: boolean;
  message?: string;
  refs?: [string, string][];
  /** The remote's default branch (`refs/heads/...`), so `origin/HEAD` resolves in the pod. */
  head?: string;
  pack?: string;
  /** A pack too big for the reply: pull `packBytes` bytes of it with `fetch-chunk` requests. */
  packId?: string;
  packBytes?: number;
}

/** The daemon-side cache a target is fetched into (a bare repository next to the project's git dir). */
export async function cacheDir(git: GitRunner, cwd: string, target: FetchTarget): Promise<string> {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (common.code !== 0) throw new Error(`not a git checkout: ${scrub(common.stderr.trim())}`);
  const dir = join(common.stdout.trim(), "kube-mirrors", `${target.id.startsWith("x:") ? `x-${mirrorId(target.id)}` : target.id}.git`);
  const exists = await git(["rev-parse", "--git-dir"], { cwd: dir }).then((r) => r.code === 0, () => false);
  if (!exists) {
    await mkdir(dir, { recursive: true });
    const init = await git(["init", "-q", "--bare", dir]);
    if (init.code !== 0) throw new Error(`could not create the fetch cache: ${scrub(init.stderr.trim())}`);
  }
  if (target.origin) {
    // borrow the checkout's objects so the first fetch only transfers what the checkout lacks
    await mkdir(join(dir, "objects", "info"), { recursive: true });
    await writeFile(join(dir, "objects", "info", "alternates"), `${join(common.stdout.trim(), "objects")}\n`);
  }
  return dir;
}

/** Whether the mirror's branches and tags are exactly what the remote listed, so a fetch would change nothing. */
async function mirrorMatches(git: GitRunner, dir: string, listing: RemoteListing): Promise<boolean> {
  const local = await git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"], { cwd: dir });
  if (local.code !== 0) return false;
  const lines = local.stdout.split("\n").filter(Boolean);
  if (lines.length !== listing.refs.size) return false;
  return lines.every((l) => {
    const [sha, ref] = l.split(" ");
    return listing.refs.get(ref!) === sha;
  });
}

/**
 * Brings the daemon's cache of a target up to date with its real remote (the part of a fetch that talks to GitHub): shared
 * listing, no fetch when nothing changed, at most a few at once. `error` is the reply to give the pod when it failed.
 */
export async function refreshMirror(
  git: GitRunner,
  cwd: string,
  target: FetchTarget,
  gate: MirrorGate = mirrorGate,
): Promise<{ dir: string; listing: RemoteListing | undefined; error?: FetchReply }> {
  // pods asking at once must not all try to create the same bare repository
  const dir = await gate.serialized(`dir:${target.id}`, () => cacheDir(git, cwd, target));

  const candidates = [workingUrls.get(target.id), target.daemonUrl, ...(target.fallbackUrls ?? [])].filter((u, i, all): u is string => !!u && all.indexOf(u) === i);
  gate.stats.fetches += 1;
  // what the remote has now (shared with the other pods asking within a few seconds); a mirror that already has it is not fetched
  const listing = await gate.list(target.id, candidates, git, dir);
  const refreshed = await gate.serialized(target.id, async (): Promise<FetchReply | undefined> => {
    if (listing && (await mirrorMatches(git, dir, listing))) {
      gate.stats.skipped += 1;
      return undefined;
    }
    try {
      return await gate.withSlot(async () => {
        // a refresh that ran while this one waited may have brought the mirror up to date
        if (listing && (await mirrorMatches(git, dir, listing))) {
          gate.stats.skipped += 1;
          return undefined;
        }
        let fetched = { code: 1, stdout: "", stderr: "" };
        const failures: string[] = [];
        for (const candidate of candidates) {
          fetched = await gate.timed(() =>
            git(["fetch", "--prune", "--force", "--no-tags", candidate, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], { cwd: dir }),
          );
          if (fetched.code === 0) {
            workingUrls.set(target.id, candidate);
            return undefined;
          }
          failures.push(`${scrub(candidate)}: ${scrub(fetched.stderr.trim())}`);
        }
        return { ok: false, message: `kube-agents: fetch failed on the daemon:\n${failures.join("\n")}` };
      });
    } catch (error) {
      return { ok: false, message: `kube-agents: ${scrub((error as Error).message)}` };
    }
  });
  return { dir, listing, error: refreshed };
}

/**
 * Refreshes the target in the daemon's cache from the real remote (daemon credentials), then answers the pod
 * with every branch and tag plus a thin pack of what the pod does not have yet.
 */
export async function applyFetch(
  git: GitRunner,
  cwd: string,
  request: FetchRequest,
  targets: readonly FetchTarget[],
  gate: MirrorGate = mirrorGate,
): Promise<FetchReply> {
  const target = targets.find((t) => t.id === request.mirror);
  if (!target) return { ok: false, message: "kube-agents: this remote is not part of the project (only its origin and submodules can be fetched from a pod)" };
  if (!Array.isArray(request.haves) || !request.haves.every((h) => SHA.test(h))) return { ok: false, message: "kube-agents: malformed fetch request" };
  const cache = await refreshMirror(git, cwd, target, gate);
  if (cache.error) return cache.error;
  const { dir } = cache;
  const head = cache.listing?.head;
  const listed = await git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"], { cwd: dir });
  if (listed.code !== 0) return { ok: false, message: `kube-agents: ${scrub(listed.stderr.trim())}` };
  const refs: [string, string][] = listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ") as [string, string])
    .map(([sha, ref]) => [ref!, sha!]);

  // only the haves that exist here can be used as pack bases
  const known = request.haves.length
    ? (await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: dir, input: Buffer.from(request.haves.join("\n") + "\n") })).stdout
        .split("\n")
        .filter((l) => l && !l.includes("missing"))
        .map((l) => l.split(" ")[0]!)
    : [];
  const wanted = [...new Set(refs.map(([, sha]) => sha))].filter((sha) => !known.includes(sha));
  let pack = "";
  if (wanted.length) {
    const input = Buffer.from([...wanted, ...known.map((h) => `^${h}`)].join("\n") + "\n");
    sweepSpools();
    // to a file: a monorepo's history does not belong in the daemon's memory, nor in one message
    const file = join(tmpdir(), `paseo-fetch-${randomBytes(6).toString("hex")}.pack`);
    const made = await git(["pack-objects", "--revs", "--thin", "--stdout", "-q"], { cwd: dir, input, outFile: file });
    if (made.code !== 0) {
      rmSync(file, { force: true });
      return { ok: false, message: `kube-agents: could not pack the fetched commits: ${scrub(made.stderr.trim())}` };
    }
    const size = made.stdoutBytes ?? 0;
    if (size > MAX_FETCH_BYTES) {
      rmSync(file, { force: true });
      return { ok: false, message: `kube-agents: the fetch is ${Math.round(size / 1048576)} MB, over the ${MAX_FETCH_BYTES / 1048576} MB the relay carries` };
    }
    if (size <= INLINE_PACK_BYTES) {
      pack = readFileSync(file).toString("base64");
      rmSync(file, { force: true });
    } else {
      const id = randomBytes(6).toString("hex");
      spools.set(id, { file, size, at: Date.now() });
      return { ok: true, refs, ...(head ? { head } : {}), packId: id, packBytes: size };
    }
  }
  return { ok: true, refs, ...(head ? { head } : {}), ...(pack ? { pack } : {}) };
}

/** A pod's push to a submodule's mirror: applied in the daemon's cache of that remote and pushed from there. */
export async function pushToMirror(
  git: GitRunner,
  cwd: string,
  request: PushRequest,
  targets: readonly FetchTarget[],
): Promise<BridgeReply> {
  const target = targets.find((t) => t.id === request.mirror);
  if (!target) return { ok: false, message: "kube-agents: this remote is not part of the project (only its origin and submodules can be pushed to from a pod)" };
  const dir = await cacheDir(git, cwd, target);
  return applyPush(git, cwd, request, { dir, remote: workingUrls.get(target.id) ?? target.daemonUrl });
}
