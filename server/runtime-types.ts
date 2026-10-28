// The workspace runtime contract of the Paseo fork (workspace runtimes), copied here because the
// published plugin SDK does not carry it yet. Delete this file and import from "@getpaseo/plugin/server" once it does.
import type { Readable, Writable } from "node:stream";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

/**
 * A workspace runtime owns where a workspace's agent processes execute. The verbs mirror the
 * workspace runtime contract proposed upstream in getpaseo/paseo#3360 (`describe`, `create`,
 * `inspect`, `exec`, `signal`, `pause`, `resume`, `destroy`, `reconcile`), so a runtime written
 * here can move to that contract. A plugin registers the runtime in-process instead of as a
 * daemon-config executable. `prepare`, `beforeInput` and `onActivity` are extensions for
 * runtimes that suspend and resume their sandbox.
 */

/** Opaque, trusted JSON the workspace's creator handed to the runtime. Paseo never reads it. */
export type WorkspaceRuntimeOptions = Record<string, unknown>;

export interface WorkspaceRuntimeCapabilities {
  /** `exec` supports piped stdin/stdout/stderr. Required for agent processes. */
  pipes: boolean;
  /** `exec` supports a pseudo-terminal. Reserved for terminals (a later phase). */
  pty: boolean;
}

export interface WorkspaceRuntimeDescription {
  /** 1 until the contract changes. */
  protocolVersion: number;
  capabilities: WorkspaceRuntimeCapabilities;
}

export interface WorkspaceRuntimeWorkspaceRequest {
  workspaceId: string;
  options?: WorkspaceRuntimeOptions;
  /** The workspace directory on the daemon. Sent with `create` and `mapCwd`. */
  cwd?: string;
  /**
   * The workspace directory on the daemon, on every call (`cwd` of an exec is the process's). A
   * workspace that inherited its runtime also inherited the caller's `options`, so recover the
   * directory from here, not from them.
   */
  workspaceCwd?: string;
}

export interface WorkspaceRuntimeReconcileRequest {
  workspaces: Array<{ workspaceId: string; options?: WorkspaceRuntimeOptions; cwd: string }>;
}

/**
 * What apps show about one workspace's sandbox: a short label next to the runtime's icon in the
 * sidebar row, a tooltip on hover, and a longer detail line in the workspace header. All optional.
 */
export interface WorkspaceRuntimeDisplay {
  /** Short, one word or so, such as an image name. Shown beside the runtime icon. */
  label?: string;
  /** Icon name for the host badge in the sidebar (the fork's `hostIcon`; a daemon without it ignores the field). */
  hostIcon?: string;
  /** Several lines of facts (full image reference, instance name, state), shown on hover. */
  tooltip?: string;
  /** One line for the workspace header. */
  detail?: string;
}

export interface WorkspaceRuntimeCommandRequest extends WorkspaceRuntimeWorkspaceRequest {
  command: string;
}

export interface WorkspaceRuntimeStatus {
  state: "running" | "suspended" | "resuming" | "error" | "absent";
  message?: string;
}

export type WorkspaceRuntimeProcessPurpose = "session" | "probe" | "command";

export interface WorkspaceRuntimeExecRequest extends WorkspaceRuntimeWorkspaceRequest {
  agentId?: string;
  /** Provider id that asked for the process, e.g. "claude". */
  provider?: string;
  /**
   * "session" drives an agent. "probe" only reads provider metadata (models, version) and must
   * not create or resume a sandbox. "command" is a short tool Paseo runs for the workspace (Git
   * today) and does not call `prepare` first.
   */
  purpose: WorkspaceRuntimeProcessPurpose;
  /**
   * For "command": the user is waiting on the result. Paseo sets it false for background
   * refreshes, which must not resume a suspended sandbox; reject them instead.
   */
  interactive?: boolean;
  /** Executable and arguments, exactly as the provider asked to run them. The image must contain it. */
  argv: [string, ...string[]];
  /** Working directory on the daemon. Map it to the runtime's own path. */
  cwd?: string;
  /** Complete environment the process must receive. Never extend it with the daemon's environment. */
  env: Record<string, string>;
}

export interface WorkspaceRuntimePrepareRequest extends WorkspaceRuntimeExecRequest {
  /** MCP servers of the agent's final configuration, so the runtime can tunnel loopback ports. */
  mcpServers?: Record<string, JsonValue>;
}

export interface WorkspaceRuntimeInputRequest extends WorkspaceRuntimeWorkspaceRequest {
  agentId: string;
}

export type WorkspaceRuntimeActivity =
  | "turn_started"
  | "turn_ended"
  | "permission_requested"
  | "permission_resolved"
  | "input";

export interface WorkspaceRuntimeActivityEvent extends WorkspaceRuntimeInputRequest {
  activity: WorkspaceRuntimeActivity;
}

/**
 * Why an exec ended. `runtime-lost` means the sandbox went away unexpectedly (evicted, node
 * failure) rather than the process finishing; Paseo then reconciles the runtime and the next input
 * relaunches. `suspended` is the runtime's own planned stop of an idle workspace: nothing went
 * wrong, so an idle agent shows no error and the next input relaunches. `interrupted` is the platform cutting the
 * process (a Spot reclaim, a node loss): not a failure either, even for a turn that was open, which ends as interrupted. A turn that is running
 * when its process ends is a failure whatever the reason.
 */
export type WorkspaceRuntimeExitReason = "exited" | "runtime-lost" | "suspended" | "interrupted";

export interface WorkspaceRuntimeExit {
  code: number | null;
  signal: string | null;
  reason: WorkspaceRuntimeExitReason;
  /** Shown to the user when the process did not exit cleanly. */
  message?: string;
}

/** Why a runtime stops an agent's process on purpose (the fork's `WorkspaceRuntimeHandle`). */
export type WorkspaceRuntimeSuspendReason = "idle" | "quota-eviction" | "manual" | "node-removal";

/**
 * Returned by `registerWorkspaceRuntime` on a Paseo that has suspended agents. Report a planned stop before the
 * process stops, so the exit that follows is no error: the agent shows as suspended and its timeline gets `message`.
 * A Paseo without it returns nothing.
 */
export interface WorkspaceRuntimeHandle {
  reportSuspended(report: { workspaceId: string; agentId?: string; reason: WorkspaceRuntimeSuspendReason; message?: string }): void;
  reportResumed(report: { workspaceId: string; agentId?: string }): void;
}

export interface WorkspaceRuntimeProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exit: Promise<WorkspaceRuntimeExit>;
  signal(signal: string): void | Promise<void>;
}

export interface WorkspaceRuntimeContext {
  /** Shows progress or a problem to the user ("pod pending", "resuming"). */
  notice(message: string, level?: "info" | "warning" | "error"): void;
}

export interface WorkspaceRuntimeFsStat {
  /** `stat` follows symlinks, so a link to a file reports "file". */
  kind: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
  /** Unix permission bits, kept when a file is rewritten. */
  mode?: number;
}

export interface WorkspaceRuntimeFsEntry extends WorkspaceRuntimeFsStat {
  name: string;
}

export interface WorkspaceRuntimeFsRequest extends WorkspaceRuntimeWorkspaceRequest {
  /** An absolute path inside the runtime, under the directory `mapCwd` returned. */
  path: string;
}

/**
 * The files of a workspace inside the runtime. Every method must confine its path to the
 * workspace directory and reject a symlink that leaves it. Errors start with the POSIX code
 * (`ENOENT: ...`, `EEXIST: ...`) so Paseo can tell "missing" and "exists" from a failure.
 */
export interface WorkspaceRuntimeFileSystem {
  /** Null when the path does not exist. */
  stat(
    request: WorkspaceRuntimeFsRequest,
  ): WorkspaceRuntimeFsStat | null | Promise<WorkspaceRuntimeFsStat | null>;
  /** The entries of a directory with their stats; skip entries that vanish or dangle. */
  readdir(
    request: WorkspaceRuntimeFsRequest,
  ): WorkspaceRuntimeFsEntry[] | Promise<WorkspaceRuntimeFsEntry[]>;
  /** `length` omitted reads to the end. */
  read(
    request: WorkspaceRuntimeFsRequest & { offset?: number; length?: number },
  ): Uint8Array | Promise<Uint8Array>;
  /**
   * Replace or create a file atomically, keeping `mode` (default 0o644 for a new file). With
   * `exclusive` it fails with EEXIST instead of replacing. With `expectedMtimeMs` it fails with
   * `ECONFLICT` when the file changed since.
   */
  write(
    request: WorkspaceRuntimeFsRequest & {
      data: Uint8Array;
      mode?: number;
      exclusive?: boolean;
      expectedMtimeMs?: number;
    },
  ): WorkspaceRuntimeFsStat | Promise<WorkspaceRuntimeFsStat>;
  /** Fails with EEXIST when the path exists. */
  mkdir(request: WorkspaceRuntimeFsRequest): void | Promise<void>;
  rename(request: WorkspaceRuntimeFsRequest & { to: string }): void | Promise<void>;
  remove(request: WorkspaceRuntimeFsRequest & { recursive?: boolean }): void | Promise<void>;
  copy(request: WorkspaceRuntimeFsRequest & { to: string }): void | Promise<void>;
}

export interface WorkspaceRuntimeRegistration {
  /** Lowercase letters, digits, ".", "_" and "-". Workspaces reference the runtime by this id. */
  id: string;
  label: string;
  /** SVG file inside the plugin directory. Apps show it wherever a workspace shows its location. */
  icon?: string;
  describe(): WorkspaceRuntimeDescription | Promise<WorkspaceRuntimeDescription>;
  /**
   * Where the workspace directory is inside the runtime. Paseo rewrites the daemon path to this
   * one in the process's argv, environment, working directory and protocol lines, and rewrites
   * it back in what the process prints, so the UI keeps seeing daemon paths. Omit it when the
   * runtime shows the workspace at the daemon's own path.
   */
  mapCwd?(request: WorkspaceRuntimeWorkspaceRequest & { cwd: string }): string | Promise<string>;
  /**
   * The workspace's files inside the runtime. Without it the workspace's Files panel is
   * unavailable. Paseo polls for changes, since a runtime has no watch.
   */
  fs?: WorkspaceRuntimeFileSystem;
  /**
   * Display details for one workspace. Called when an app shows the workspace and again after the
   * runtime's state changes; the answer is cached briefly. It must not create or resume the
   * sandbox: answer from what the runtime already knows.
   */
  describeWorkspace?(
    request: WorkspaceRuntimeWorkspaceRequest,
  ): WorkspaceRuntimeDisplay | null | Promise<WorkspaceRuntimeDisplay | null>;
  /** Materialize the workspace. Idempotent. */
  create?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  inspect?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): WorkspaceRuntimeStatus | Promise<WorkspaceRuntimeStatus>;
  pause?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  resume?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  /** Delete the workspace's sandbox. Runs when the workspace is archived, never on disconnect. */
  destroy?(
    request: WorkspaceRuntimeWorkspaceRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  /**
   * Re-adopt sandboxes after a daemon restart, a plugin reload or a `runtime-lost` exit. The
   * request lists every live workspace of this runtime; a sandbox for any other workspace is an
   * orphan (its workspace was archived while the runtime was away) and may be deleted.
   */
  reconcile?(
    request: WorkspaceRuntimeReconcileRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  /**
   * Whether `command` exists in the runtime's image. Paseo checks the provider's binary before
   * a session starts and the stdio MCP servers of the agent in `prepare`, and tells the user
   * which one is missing. Omit it to skip the check.
   */
  checkCommand?(request: WorkspaceRuntimeCommandRequest): boolean | Promise<boolean>;
  /**
   * Runs before every session launch with the final command, environment and MCP servers.
   * Idempotent: a resume prepares again.
   */
  prepare?(
    request: WorkspaceRuntimePrepareRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  /** Awaited before Paseo delivers a prompt or permission answer, so a suspended sandbox resumes first. */
  beforeInput?(
    request: WorkspaceRuntimeInputRequest,
    context: WorkspaceRuntimeContext,
  ): void | Promise<void>;
  onActivity?(event: WorkspaceRuntimeActivityEvent): void;
  /**
   * Start the process. May be slow and may report progress through `context.notice`. Abort the
   * start through `signal`. Execs of one workspace are serialized.
   */
  exec(
    request: WorkspaceRuntimeExecRequest,
    context: WorkspaceRuntimeContext & { signal: AbortSignal },
  ): WorkspaceRuntimeProcess | Promise<WorkspaceRuntimeProcess>;
}
