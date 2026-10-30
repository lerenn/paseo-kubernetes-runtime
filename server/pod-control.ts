import { RUNTIME_ID } from "../shared/runtime-options.js";

/**
 * The workspace control other plugins reach on `globalThis` (the Factory suspends and wakes a run's worker pod through it). It
 * is the same path as the Pods screen's Suspend / Resume (volume kept, Paseo told), except that a workspace carrying one of the
 * `idleExemptLabels` is not suspended unless `force`, as the idle suspend would not either.
 *
 * The capability is generic: `globalThis[Symbol.for("paseo.workspace-control")]` is a registry keyed by runtime id, and this
 * Runtime registers itself under `kubernetes` with `{ suspend, wake }`.
 */
export const WORKSPACE_CONTROL_KEY = Symbol.for("paseo.workspace-control");

/**
 * Legacy, still offered for one release so a Factory that predates the registry keeps working: this Runtime's own key with
 * `podAction(workspaceId, "suspend" | "resume", { force })`. Remove once every Factory reads WORKSPACE_CONTROL_KEY.
 */
export const POD_CONTROL_KEY = Symbol.for("paseo.kubernetes-runtime");

export interface ControlResult {
  ok: boolean;
  message?: string;
  busy?: string;
}

export interface WorkspaceControl {
  suspend(workspaceId: string, options?: { force?: boolean }): Promise<ControlResult>;
  wake(workspaceId: string): Promise<ControlResult>;
}

export interface PodControl {
  podAction(workspaceId: string, action: "suspend" | "resume", options: { force?: boolean }): Promise<ControlResult>;
}

export interface PodControlSource {
  podControl(workspaceId: string, action: "suspend" | "resume", options: { force?: boolean }): Promise<ControlResult>;
}

type Registry = Record<string, WorkspaceControl | undefined>;

/**
 * Offers the control on `globalThis`, under the workspace-control registry and the legacy key; the returned function removes
 * both, each only if it is still this one (a newer load may have replaced it).
 */
export function registerPodControl(source: PodControlSource, target: Record<symbol, unknown> = globalThis as Record<symbol, unknown>): () => void {
  const forward = (workspaceId: string, action: "suspend" | "resume", force: unknown) => source.podControl(workspaceId, action, { force: force === true });
  const control: WorkspaceControl = {
    suspend: (workspaceId, options) => forward(workspaceId, "suspend", options?.force),
    wake: (workspaceId) => forward(workspaceId, "resume", false),
  };
  const legacy: PodControl = {
    podAction: (workspaceId, action, options) => forward(workspaceId, action, options?.force),
  };
  const registry = (target[WORKSPACE_CONTROL_KEY] ??= {}) as Registry;
  registry[RUNTIME_ID] = control;
  target[POD_CONTROL_KEY] = legacy;
  return () => {
    const current = target[WORKSPACE_CONTROL_KEY] as Registry | undefined;
    if (current?.[RUNTIME_ID] === control) delete current[RUNTIME_ID];
    if (target[POD_CONTROL_KEY] === legacy) delete target[POD_CONTROL_KEY];
  };
}
