import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SubmoduleReport, SubmoduleStatus, SubmoduleTracker } from "./submodule-status.js";

/** The longest `submodule_wait` may block, whatever the agent asks for. */
export const MAX_WAIT_SECONDS = 600;

export const TOOLS = [
  {
    name: "submodule_status",
    description:
      "State of this workspace's git submodules while the pod provisions them: per path pending, fetching, ready or failed, with progress (0 to 1) and an estimated number of seconds left. Check it before reading a submodule directory that looks empty.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "submodule_wait",
    description: "Waits until the submodule at `path` is ready (or failed), at most `timeout` seconds (default 120), then returns its state.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "The submodule path, as submodule_status lists it" }, timeout: { type: "number", description: "Seconds to wait, at most 600" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
] as const;

export interface McpSource {
  /** The tracker and daemon-side fallback list of the workspace behind a token; undefined for an unknown token. */
  lookup(token: string): { tracker: SubmoduleTracker; provisional: () => Promise<string[]> } | undefined;
}

const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

/** Answers one JSON-RPC message of the MCP streamable HTTP transport; undefined for a notification. */
export async function handleRpc(message: any, source: ReturnType<McpSource["lookup"]>): Promise<object | undefined> {
  const { id, method, params } = message ?? {};
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, msg: string) => ({ jsonrpc: "2.0", id, error: { code, message: msg } });
  if (id === undefined || id === null) return undefined;
  if (method === "initialize") {
    return ok({ protocolVersion: params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "submodules", version: "1.0.0" } });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method !== "tools/call") return fail(-32601, `unknown method ${method}`);
  if (!source) return ok({ ...text("No submodule information for this workspace."), isError: true });
  const name = params?.name;
  if (name === "submodule_status") {
    const report: SubmoduleReport = source.tracker.report(await source.provisional());
    return ok(text(report));
  }
  if (name === "submodule_wait") {
    const path = typeof params?.arguments?.path === "string" ? params.arguments.path : "";
    const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(params?.arguments?.timeout ?? 120) || 0));
    const state: SubmoduleStatus | undefined = await source.tracker.wait(path, seconds * 1000);
    if (!state) return ok({ ...text(`${path} is not a submodule of this workspace (or is not known yet); call submodule_status for the list.`), isError: true });
    return ok(text(state));
  }
  return fail(-32602, `unknown tool ${name}`);
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/** A loopback MCP server (`/mcp/<token>`) with the submodule tools; the pod reaches it through the bridge's loopback tunnel. */
export function startSubmoduleMcp(source: McpSource): Promise<{ server: Server; port: number; close(): void }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const token = /^\/mcp\/([A-Za-z0-9_-]{8,64})$/.exec(req.url ?? "")?.[1];
    if (!token || req.method !== "POST") {
      res.writeHead(token ? 405 : 404).end();
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const lookup = source.lookup(token);
      const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => handleRpc(m, lookup)))).filter((r) => r !== undefined);
      if (replies.length === 0) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ server, port: (server.address() as { port: number }).port, close: () => server.close() });
    });
  });
}
