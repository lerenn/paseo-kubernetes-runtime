import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Kubectl, guardChild, ndjsonStream } from "../server/kube.js";

const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

describe("a dead exec never takes the plugin down", () => {
  it("guardChild leaves no stream or child without an error listener", () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    guardChild(child as never);
    expect(() => {
      child.stdin.emit("error", epipe());
      child.stdout.emit("error", epipe());
      child.stderr.emit("error", epipe());
      child.emit("error", epipe());
    }).not.toThrow();
  });

  it("ndjsonStream survives an EPIPE on stdin after the exec was killed, and the writer sees the failure", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stream = ndjsonStream({ stdin, stdout, kill: () => true } as never);
    const writer = stream.writable.getWriter();
    stdin.destroy(epipe()); // emits 'error' on the stream
    await new Promise((r) => setImmediate(r));
    await expect(writer.write({ id: 1 } as never)).rejects.toBeDefined();
    stdout.emit("error", epipe());
  });

  it("spawnExec and execStream of a real process killed with 137 survive writes to its stdin", async () => {
    const dir = await import("node:fs").then((fs) => fs.mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/kubectl-`));
    const fake = `${dir}/kubectl`;
    // behaves like a `kubectl exec` whose pod processes were killed: exits 137 without reading stdin
    await import("node:fs").then((fs) => fs.writeFileSync(fake, "#!/bin/sh\nexit 137\n", { mode: 0o755 }));
    const kube = new Kubectl({ namespace: "ns", binary: fake });
    const uncaught: Error[] = [];
    const onUncaught = (e: Error) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const proc = kube.spawnExec("pod", ["cat"]);
      const exit = await proc.exit;
      expect(exit.code).toBe(137);
      for (let i = 0; i < 5; i++) proc.stdin.write("x".repeat(65536));
      const stream = kube.execStream("pod", ["cat"]);
      const writer = stream.writable.getWriter();
      await new Promise((r) => setTimeout(r, 200));
      await writer.write({ id: 1 } as never).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      const res = await kube.execInput("pod", ["cat"], PassThrough.from([Buffer.alloc(1 << 20)]));
      expect(res.code).toBe(137);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    void spawn;
  });
});
