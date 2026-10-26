/**
 * Small scripts written into each pod at session start (no image dependency beyond Node and git).
 * They are plain strings so they ship inside the plugin bundle.
 */

/**
 * `serve` runs for the whole session over `kubectl exec` stdio, one JSON object per line: it relays
 * requests from pod-side helpers (a unix socket, used by the git hook) to the plugin on the daemon,
 * and tunnels loopback TCP ports to the daemon. `call` is the helper side used by the git hook.
 */
export const BRIDGE_SCRIPT = String.raw`import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

const [mode, ...args] = process.argv.slice(2);
const sock = (process.env.HOME || ".") + "/bridge.sock";

if (mode === "call") {
  const op = args[0];
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const msg = { op };
  if (op === "push") {
    msg.ref = args[1]; msg.old = args[2]; msg.new = args[3]; msg.base = args[4];
    if (args[5]) msg.mirror = args[5];
    msg.pack = Buffer.concat(chunks).toString("base64");
  }
  if (op === "fetch") {
    // args[1] is a mirror repository; send what it (and the checkout it borrows objects from) already has.
    const dir = path.resolve(args[1]);
    const git = (g, a, input) => execFileSync("git", ["--git-dir", g, ...a], { encoding: "utf8", input, maxBuffer: 1 << 28 });
    const tips = (g) => git(g, ["for-each-ref", "--format=%(objectname)"]).split("\n").filter(Boolean);
    const haves = new Set(tips(dir));
    try {
      for (const alt of fs.readFileSync(dir + "/objects/info/alternates", "utf8").split("\n").filter(Boolean)) {
        for (const h of tips(path.dirname(alt))) haves.add(h);
      }
    } catch {}
    let target = "";
    try { target = git(dir, ["config", "paseo.target"]).trim(); } catch {}
    // a mirror made on demand for any repository names it; the project's own mirrors are named by their directory
    msg.mirror = target ? "x:" + target : path.basename(dir, ".git");
    msg.haves = [...haves];
  }
  const conn = net.connect(sock);
  let out = "";
  conn.on("error", (e) => { console.error("kube-agents: bridge unavailable: " + e.message); process.exit(1); });
  conn.on("data", (d) => (out += d));
  conn.on("end", () => {
    let r;
    try { r = JSON.parse(out); } catch { console.error("kube-agents: bad bridge reply"); process.exit(1); }
    if (r.message) console.error(r.message);
    if (op === "fetch" && r.ok) {
      const dir = path.resolve(args[1]);
      const git = (a, input) => execFileSync("git", ["--git-dir", dir, ...a], { encoding: "utf8", input, maxBuffer: 1 << 28 });
      try {
        if (r.pack) execFileSync("git", ["--git-dir", dir, "index-pack", "--stdin", "--fix-thin"], { input: Buffer.from(r.pack, "base64"), stdio: ["pipe", "ignore", "inherit"] });
        const want = new Map(r.refs.map(([ref, sha]) => [ref, sha]));
        const cmds = [];
        for (const line of git(["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)) {
          if (!want.has(line)) cmds.push("delete " + line);
        }
        for (const [ref, sha] of want) cmds.push("update " + ref + " " + sha);
        if (cmds.length) git(["update-ref", "--stdin"], cmds.join("\n") + "\n");
        if (r.head) git(["symbolic-ref", "HEAD", r.head]);
      } catch (e) { console.error("kube-agents: could not store the fetched commits: " + e.message); process.exit(1); }
    }
    process.exit(r.ok ? 0 : 1);
  });
  conn.end(JSON.stringify(msg) + "\n");
} else if (mode === "serve") {
  const pending = new Map();
  let next = 1;
  const ask = (msg) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    process.stdout.write(JSON.stringify({ id, ...msg }) + "\n");
  });
  let tunnelIn = () => {};
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    try {
      const r = JSON.parse(line);
      if (r.tcp) { tunnelIn(r); return; }
      pending.get(r.id)?.(r); pending.delete(r.id);
    } catch {}
  }).on("close", () => process.exit(0));

  try { fs.unlinkSync(sock); } catch {}
  net.createServer({ allowHalfOpen: true }, (c) => {
    let buf = "";
    c.on("data", (d) => { buf += d; if (buf.includes("\n")) { const line = buf; buf = ""; handle(c, line); } });
    c.on("error", () => {});
  }).listen(sock);
  const handle = async (c, line) => {
    let reply;
    try { reply = await ask(JSON.parse(line)); } catch (e) { reply = { ok: false, message: "kube-agents: " + e.message }; }
    c.end(JSON.stringify(reply));
  };

  // Loopback TCP tunnels: listen on the same ports inside the pod and carry each connection to the
  // daemon's loopback port over this channel, so URLs and headers in the agent's config stay as they are.
  const conns = new Map();
  let cid = 0;
  const frame = (f) => process.stdout.write(JSON.stringify(f) + "\n");
  for (const port of (args[0] || "").split(",").map(Number).filter(Boolean)) {
    net.createServer((c) => {
      const id = ++cid;
      conns.set(id, c);
      frame({ tcp: "open", cid: id, port });
      c.on("data", (d) => frame({ tcp: "data", cid: id, b64: d.toString("base64") }));
      c.on("close", () => { if (conns.delete(id)) frame({ tcp: "end", cid: id }); });
      c.on("error", () => {});
    }).on("error", (e) => process.stderr.write("kube-agents bridge: port " + port + ": " + e.message + "\n")).listen(port, "127.0.0.1");
  }
  tunnelIn = (r) => {
    const c = conns.get(r.cid);
    if (!c) return;
    if (r.tcp === "data") c.write(Buffer.from(r.b64, "base64"));
    else if (r.tcp === "end") { conns.delete(r.cid); c.end(); }
  };
}
`;

/**
 * Stands in for `git-upload-pack` (the global `remote.origin.uploadpack`) on the pod's local mirrors of the
 * project's remote and its submodules: asks the plugin to refresh the mirror from the real remote with the
 * daemon's credentials, then serves it as usual. `git fetch`, `git pull` and `git submodule update` just work.
 */
export const UPLOAD_PACK_WRAPPER = String.raw`#!/bin/sh
dir="$1"
# remote.origin.uploadpack is global, so it also runs for a repository that has nothing to do with the daemon (a bare
# repository a test made in /tmp): only the plugin's own mirrors are refreshed through the bridge
case "$dir" in
  "$HOME"/mirrors/*|"$HOME"/gh/*) node "$HOME/bridge.mjs" call fetch "$dir" </dev/null >&2 || exit 1 ;;
esac
exec git-upload-pack "$dir"
`;

/**
 * pre-receive hook of a mirror (the pod's copy of a submodule's remote). A branch pushed there is sent to the
 * real remote by the plugin, like the project's own pushes; deletions are refused.
 */
export const MIRROR_PRE_RECEIVE = String.raw`#!/bin/sh
ZERO=0000000000000000000000000000000000000000
id=$(git config paseo.target 2>/dev/null)
if [ -n "$id" ]; then id="x:$id"; else id=$(basename "$(pwd)" .git); fi
while read old new ref; do
  if [ "$new" = "$ZERO" ]; then
    echo "kube-agents: deleting remote branches or tags from a pod is not supported" >&2
    exit 1
  fi
  case "$ref" in
    refs/tags/*)
      if [ "$old" != "$ZERO" ]; then
        echo "kube-agents: moving an existing tag from a pod is not supported" >&2
        exit 1
      fi ;;
  esac
  { echo "$new"; git for-each-ref --format='^%(objectname)'; } | git pack-objects --revs --stdout --thin 2>/dev/null \
    | node "$HOME/bridge.mjs" call push "$ref" "$old" "$new" "$old" "$id" || exit 1
done
exit 0
`;

/**
 * pre-receive hook of the pod's local "outbox" repository, which is the checkout's push URL. A
 * `git push` there asks the plugin to push the new commits for real, with the daemon's credentials;
 * the answer decides whether the push is accepted, so the agent sees ordinary git results.
 */
export const PRE_RECEIVE_HOOK = String.raw`#!/bin/sh
ZERO=0000000000000000000000000000000000000000
while read old new ref; do
  if [ "$new" = "$ZERO" ]; then
    echo "kube-agents: deleting remote branches or tags from a pod is not supported" >&2
    exit 1
  fi
  case "$ref" in
    refs/tags/*)
      if [ "$old" != "$ZERO" ]; then
        echo "kube-agents: moving an existing tag from a pod is not supported" >&2
        exit 1
      fi ;;
  esac
  base="$old"
  [ "$old" = "$ZERO" ] && base=$(cat "$HOME/seed.sha")
  { echo "$new"; echo "^$base"; } | git pack-objects --revs --stdout --thin 2>/dev/null \
    | node "$HOME/bridge.mjs" call push "$ref" "$old" "$new" "$base" || exit 1
done
exit 0
`;

/**
 * Starts a provider process: loads its env file (then deletes it), moves to the workspace directory, puts the
 * shims and installed CLIs on PATH, and runs the command exactly as the provider asked.
 * Arguments: env file, directory, then the command and its arguments.
 */
export const LAUNCH_SCRIPT = `. "$1" || exit 1; rm -f "$1"; cd "$2" || exit 1; shift 2; export PATH="$HOME/bin:$HOME/.npm-global/bin:$PATH"; exec "$@"`;

/** An env file for the provider process: the env delta Paseo asked for, and nothing from the daemon. */
export function envFile(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'\n`)
    .join("");
}

/** Provider commands the runtime can install on first use when the image lacks them. */
export const INSTALLABLE_CLIS: Readonly<Record<string, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

/**
 * File operations for the Files panel, run in the pod with one JSON request on stdin and one JSON answer on stdout.
 * Every path is confined to the workspace directory (symlinks that leave it are refused). Errors begin with the
 * POSIX code, as Paseo expects (ENOENT, EEXIST, ECONFLICT).
 */
export const FS_SCRIPT = String.raw`import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

let input = "";
for await (const c of process.stdin) input += c;
const req = JSON.parse(input);

const fail = (code, message) => { const e = new Error(code + ": " + message); e.code = code; throw e; };
const rootReal = fs.realpathSync(req.root);
const inside = (p) => p === rootReal || p.startsWith(rootReal + path.sep);

// Resolves a path through its deepest existing ancestor, so a new file can be checked before it exists.
const confine = (p) => {
  if (typeof p !== "string" || !path.isAbsolute(p)) fail("EINVAL", "paths must be absolute");
  const abs = path.resolve(p);
  let existing = abs;
  const rest = [];
  while (!fs.existsSync(existing) && !isLink(existing)) {
    rest.unshift(path.basename(existing));
    const up = path.dirname(existing);
    if (up === existing) break;
    existing = up;
  }
  let real;
  try { real = fs.realpathSync(existing); } catch { fail("ENOENT", abs); }
  const out = path.join(real, ...rest);
  if (!inside(out)) fail("EACCES", abs + " is outside the workspace");
  return out;
};
function isLink(p) { try { fs.lstatSync(p); return true; } catch { return false; } }

const statOf = (s) => ({ kind: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other", size: s.size, mtimeMs: s.mtimeMs, mode: s.mode & 0o7777 });
const statPath = (p) => { try { return statOf(fs.statSync(p)); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; } };

try {
const target = confine(req.path);
let result = null;
switch (req.op) {
  case "stat":
    result = statPath(target);
    break;
  case "readdir": {
    const entries = [];
    let names;
    try { names = fs.readdirSync(target); } catch (e) { fail(e.code || "EIO", req.path); }
    for (const name of names) {
      const full = path.join(target, name);
      try {
        if (!inside(fs.realpathSync(full))) continue;
        entries.push({ name, ...statOf(fs.statSync(full)) });
      } catch { /* vanished or dangling */ }
    }
    result = entries;
    break;
  }
  case "read": {
    let fd;
    try { fd = fs.openSync(target, "r"); } catch (e) { fail(e.code || "EIO", req.path); }
    try {
      const size = fs.fstatSync(fd).size;
      const offset = req.offset ?? 0;
      const length = req.length ?? Math.max(0, size - offset);
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, length, offset);
      result = { data: buf.subarray(0, n).toString("base64") };
    } finally { fs.closeSync(fd); }
    break;
  }
  case "write": {
    const data = Buffer.from(req.data, "base64");
    const before = statPath(target);
    if (req.exclusive && before) fail("EEXIST", req.path);
    if (req.expectedMtimeMs !== undefined && before && Math.abs(before.mtimeMs - req.expectedMtimeMs) > 1) fail("ECONFLICT", req.path + " changed since it was read");
    const mode = req.mode ?? (before ? before.mode : 0o644);
    if (req.exclusive) {
      fs.writeFileSync(target, data, { flag: "wx", mode });
    } else {
      const tmp = path.join(path.dirname(target), "." + path.basename(target) + "." + crypto.randomBytes(4).toString("hex") + ".tmp");
      fs.writeFileSync(tmp, data, { mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, target);
    }
    result = statPath(target);
    break;
  }
  case "mkdir":
    try { fs.mkdirSync(target); } catch (e) { fail(e.code || "EIO", req.path); }
    break;
  case "rename": {
    const to = confine(req.to);
    try { fs.renameSync(target, to); } catch (e) { fail(e.code || "EIO", req.path); }
    break;
  }
  case "copy": {
    const to = confine(req.to);
    try { fs.cpSync(target, to, { recursive: true, errorOnExist: true, force: false }); } catch (e) { fail(e.code || "EIO", req.path); }
    break;
  }
  case "remove":
    if (target === rootReal) fail("EACCES", "the workspace directory itself cannot be removed");
    try { fs.rmSync(target, { recursive: !!req.recursive, force: false }); } catch (e) { fail(e.code || "EIO", req.path); }
    break;
  default:
    fail("EINVAL", "unknown operation " + req.op);
}
process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e) }));
}
`;

/**
 * `git-remote-paseo`: the remote helper behind `paseo://host/owner/repo` URLs, which global `insteadOf` rules make
 * of every URL for an allowed host. It keeps a bare mirror per repository, asks the plugin (over the bridge) to refresh
 * it with the daemon's credentials before serving a fetch or clone, and serves git's protocol from it; a push lands in
 * the mirror, whose pre-receive hook has the plugin push the branch for real.
 */
export const GIT_REMOTE_HELPER = String.raw`#!/bin/sh
url="$2"
target=$(printf '%s' "$url" | sed -e 's|^paseo://||' -e 's|\.git$||')
dir="$HOME/gh/$target.git"
while read -r cmd arg; do
  case "$cmd" in
    capabilities) printf 'connect\n\n' ;;
    connect)
      if [ ! -d "$dir" ]; then
        mkdir -p "$dir" && git init -q --bare "$dir" || exit 1
        git --git-dir "$dir" config paseo.target "$target"
        mkdir -p "$dir/hooks" && cp "$HOME/mirror-pre-receive" "$dir/hooks/pre-receive"
      fi
      if [ "$arg" = git-upload-pack ]; then
        node "$HOME/bridge.mjs" call fetch "$dir" </dev/null >&2 || exit 1
      fi
      printf '\n'
      exec "$arg" "$dir"
      ;;
    "") exit 0 ;;
  esac
done
`;
