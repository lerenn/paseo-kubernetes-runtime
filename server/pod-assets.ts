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
    msg.mirror = path.basename(dir, ".git");
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
node "$HOME/bridge.mjs" call fetch "$dir" </dev/null >&2 || exit 1
exec git-upload-pack "$dir"
`;

/** Mirrors only serve fetches; pushes (for example from a submodule) must not silently land in them. */
export const MIRROR_PRE_RECEIVE = String.raw`#!/bin/sh
echo "kube-agents: pushing to this remote is not supported from a pod; only the project's own branches can be pushed" >&2
exit 1
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
    echo "kube-agents: deleting remote branches from a pod is not supported" >&2
    exit 1
  fi
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
