import { Readable } from "node:stream";
import { HOME_DIR } from "./sandbox.js";
import { BRIDGE_SCRIPT, FS_SCRIPT, INSTALLABLE_CLIS, GIT_REMOTE_HELPER, MIRROR_PRE_RECEIVE, PRE_RECEIVE_HOOK, UPLOAD_PACK_WRAPPER, envFile } from "./pod-assets.js";
import { MIRROR_SETUP_SCRIPT, mirrorSetupArgs, type FetchTarget } from "./mirrors.js";
import type { Kube } from "./kube.js";
import type { Seed } from "./seed.js";

const write = async (kube: Kube, pod: string, rel: string, content: string, mode: string) => {
  const r = await kube.execInput(
    pod,
    ["sh", "-c", 'p="$HOME/$1"; mkdir -p "$(dirname "$p")" && cat > "$p" && chmod "$2" "$p"', "sh", rel, mode],
    Readable.from([Buffer.from(content)]),
  );
  if (r.code !== 0) throw new Error(`could not write ${rel} in the pod: ${r.stderr.trim()}`);
};

/** Writes the bridge and the push hook into the pod. Safe to repeat. */
export async function installAssets(kube: Kube, pod: string): Promise<void> {
  await write(kube, pod, "bridge.mjs", BRIDGE_SCRIPT, "644");
  await write(kube, pod, "fs.mjs", FS_SCRIPT, "644");
  await write(kube, pod, "outbox.git/hooks/pre-receive", PRE_RECEIVE_HOOK, "755");
  await write(kube, pod, "bin/paseo-upload-pack", UPLOAD_PACK_WRAPPER, "755");
  await write(kube, pod, "bin/git-remote-paseo", GIT_REMOTE_HELPER, "755");
  await write(kube, pod, "mirror-pre-receive", MIRROR_PRE_RECEIVE, "755");
}

/** Points git in the pod at local mirrors of the project's remote and its submodules, refreshed through the bridge. */
export async function setupMirrors(kube: Kube, pod: string, cwd: string, identity: { name: string; email: string }, targets: readonly FetchTarget[], hosts: readonly string[] = []): Promise<void> {
  const r = await kube.exec(pod, ["sh", "-c", MIRROR_SETUP_SCRIPT, "sh", ...mirrorSetupArgs(cwd, identity, targets, hosts)]);
  if (r.code !== 0) throw new Error(`could not set up fetching in the pod: ${r.stderr.trim()}`);
}

/** Checks out the submodules recorded in the seeded commit (their commits come through the fetch bridge). */
export async function initSubmodules(
  kube: Kube,
  pod: string,
  cwd: string,
  targets: readonly FetchTarget[],
  concurrency = 6,
): Promise<{ ok: boolean; message: string }> {
  const present = await kube.exec(pod, ["test", "-f", `${cwd}/.gitmodules`]);
  if (present.code !== 0) return { ok: true, message: "" };
  // `git clone` does not run the fetch wrapper, so fill the submodules' mirrors first, several at a time
  const queue = targets.filter((t) => !t.origin);
  let failure = "";
  const worker = async () => {
    for (let target = queue.shift(); target && !failure; target = queue.shift()) {
      const r = await kube.exec(pod, ["sh", "-c", 'node "$HOME/bridge.mjs" call fetch "$HOME/mirrors/$1.git" </dev/null', "sh", target.id]);
      if (r.code !== 0) failure = r.stderr.trim() || "fetch failed";
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  if (failure) return { ok: false, message: failure };
  const r = await kube.exec(pod, ["git", "-C", cwd, "submodule", "update", "--init", "--jobs", String(concurrency + 2)]);
  return { ok: r.code === 0, message: r.code === 0 ? "" : r.stderr.trim() };
}

/** Whether the checkout has submodules that are not checked out yet (`git submodule status` marks them with `-`). */
export async function submodulesPending(kube: Kube, pod: string, cwd: string): Promise<boolean> {
  const r = await kube.exec(pod, ["sh", "-c", 'test -f "$1/.gitmodules" && git -C "$1" submodule status', "sh", cwd]);
  return r.code === 0 && r.stdout.split("\n").some((line) => line.startsWith("-"));
}

const SEED_SCRIPT = `set -e
dir="$1"
git init -q "$dir"
git -C "$dir" fetch -q "$HOME/seed.bundle" "$2:refs/heads/$3"
git -C "$dir" checkout -q "$3"
git -C "$dir" remote add origin "$4"
git init -q --bare "$HOME/outbox.git"
git -C "$dir" config remote.origin.pushurl "$HOME/outbox.git"
git -C "$dir" config user.name "$5"
git -C "$dir" config user.email "$6"
echo "$7" > "$HOME/seed.sha"
# a seeded branch tracks its remote branch, so a plain git pull works; a PR seed or a new branch has none yet
if [ -z "$8" ]; then
  case "$3" in pr-*) ;; *) git -C "$dir" config "branch.$3.remote" origin; git -C "$dir" config "branch.$3.merge" "refs/heads/$3" ;; esac
fi
if [ -n "$8" ]; then git -C "$dir" checkout -q -b "$8"; fi
rm -f "$HOME/seed.bundle"
`;

export interface SeedTarget {
  dir: string;
  originUrl: string;
  identity: { name: string; email: string };
  /** New branch to create from the seed (branch-off). */
  newBranch?: string;
}

/** Copies the bundle in over the Kubernetes API and builds the workspace from it: no GitHub access. */
export async function seedWorkspace(
  kube: Kube,
  pod: string,
  seed: Seed,
  bundle: Readable,
  target: SeedTarget,
): Promise<void> {
  const copied = await kube.execInput(pod, ["sh", "-c", 'mkdir -p "$HOME" && cat > "$HOME/seed.bundle"'], bundle);
  if (copied.code !== 0) throw new Error(`could not copy the seed bundle into the pod: ${copied.stderr.trim()}`);
  const built = await kube.exec(pod, [
    "sh",
    "-c",
    SEED_SCRIPT,
    "sh",
    target.dir,
    seed.ref,
    seed.branch,
    target.originUrl,
    target.identity.name,
    target.identity.email,
    seed.sha,
    target.newBranch ?? "",
  ]);
  if (built.code !== 0) throw new Error(`could not build the workspace in the pod: ${built.stderr.trim()}`);
}

/** Writes the env file of one provider process and returns its path inside the pod. */
export async function writeEnvFile(kube: Kube, pod: string, id: string, env: Readonly<Record<string, string>>): Promise<string> {
  const rel = `.exec-env/${id}`;
  await write(kube, pod, rel, envFile(env), "600");
  return `${HOME_DIR}/${rel}`;
}

/** Makes sure the provider's command exists in the pod, installing claude or codex once (on the volume) if not. */
export async function ensureCommand(kube: Kube, pod: string, command: string): Promise<void> {
  const present = await kube.exec(pod, ["sh", "-c", 'export PATH="$HOME/bin:$HOME/.npm-global/bin:$PATH"; command -v "$1" >/dev/null 2>&1', "sh", command]);
  if (present.code === 0) return;
  const pkg = INSTALLABLE_CLIS[command];
  if (!pkg) throw new Error(`${command} is not in the pod image and cannot be installed automatically; use an image that contains it`);
  const installed = await kube.exec(pod, ["sh", "-c", 'npm install -g --prefix "$HOME/.npm-global" "$1" >/dev/null 2>&1', "sh", pkg]);
  if (installed.code !== 0) throw new Error(`could not install ${pkg} in the pod: ${installed.stderr.trim() || "npm failed"}`);
}

const JQ_VERSION = "1.7.1";
/** SHA-256 of the jq release binaries, so the download is verified. */
const JQ_SHA256 = {
  amd64: "5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5",
  arm64: "4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5",
};

const JQ_SCRIPT = `command -v jq >/dev/null 2>&1 && exit 0
[ -x "$HOME/bin/jq" ] && exit 0
case "$(uname -m)" in x86_64) a=amd64; s=${JQ_SHA256.amd64};; aarch64|arm64) a=arm64; s=${JQ_SHA256.arm64};; *) exit 0;; esac
mkdir -p "$HOME/bin"
t="$HOME/bin/jq.download"
curl -fsSL -o "$t" "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/jq-linux-$a" || { rm -f "$t"; exit 0; }
echo "$s  $t" | sha256sum -c - >/dev/null 2>&1 || { rm -f "$t"; exit 0; }
chmod 755 "$t" && mv "$t" "$HOME/bin/jq"
`;

/**
 * `jq` for the `gh --jq` shim and for agents: a stock image such as node:22 lacks it, so a verified static binary is
 * put in the volume's `bin` once. Best effort: a pod without internet access simply stays without.
 */
export async function ensureJq(kube: Kube, pod: string): Promise<void> {
  await kube.exec(pod, ["sh", "-c", JQ_SCRIPT]).catch(() => undefined);
}
