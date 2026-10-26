import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { PassThrough, type Readable } from "node:stream";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Raw stdout, only with the `binary` option (for pack data). */
  stdoutBuffer?: Buffer;
  /** Bytes written to `outFile`, only with that option. */
  stdoutBytes?: number;
}

/** Runs git on the daemon with the daemon's own credentials, never prompting. */
export type GitRunner = (args: string[], options?: { cwd?: string; input?: Buffer; binary?: boolean; /** Write stdout to this file instead of keeping it in memory (large packs). */ outFile?: string }) => Promise<GitResult>;

// never wait for a prompt: ssh would stop at an unknown host or a passphrase
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=20" };

export const runGit: GitRunner = (args, { cwd, input, binary, outFile } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] });
    if (outFile) {
      const out = createWriteStream(outFile, { mode: 0o600 });
      let bytes = 0;
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (bytes += d.length));
      child.stdout.pipe(out);
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => out.end(() => resolve({ code: code ?? 1, stdout: "", stderr, stdoutBytes: bytes })));
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
      return;
    }
    let stdout = "";
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (binary ? chunks.push(d) : (stdout += d)));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr, ...(binary ? { stdoutBuffer: Buffer.concat(chunks) } : {}) }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });

/**
 * Starts git and hands back its stdout as a stream (for `git bundle create -`), plus its exit.
 * Output is piped into a PassThrough right away: an unread child stdout can lose data once the
 * process exits, and the consumer (a `kubectl exec` upload) may start a little later.
 */
export function streamGit(
  args: string[],
  cwd: string,
): { stdout: Readable; exit: Promise<{ code: number; stderr: string }> } {
  const child = spawn("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = new PassThrough();
  child.stdout!.pipe(stdout);
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const exit = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
  return { stdout, exit };
}

/** Removes credentials from URLs in text that may reach a user or a log. */
export function scrub(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@:]+(:[^\s/@]*)?@/g, "$1***@");
}
