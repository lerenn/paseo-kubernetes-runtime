/**
 * The pod control other plugins reach on `globalThis` (the Factory suspends a run's worker pod through it). It is the same
 * path as the Pods screen's Suspend / Resume (volume kept, Paseo told), except that a workspace carrying one of the
 * `idleExemptLabels` is not suspended unless `force`, as the idle suspend would not either.
 */
export const POD_CONTROL_KEY = Symbol.for("paseo.kubernetes-runtime");

export interface PodControl {
  podAction(workspaceId: string, action: "suspend" | "resume", options: { force?: boolean }): Promise<{ ok: boolean; message?: string; busy?: string }>;
}

export interface PodControlSource {
  podControl(workspaceId: string, action: "suspend" | "resume", options: { force?: boolean }): Promise<{ ok: boolean; message?: string; busy?: string }>;
}

/** Offers the control on `globalThis`; the returned function removes it, and only if it is still this one (a newer load may have replaced it). */
export function registerPodControl(source: PodControlSource, target: Record<symbol, unknown> = globalThis as Record<symbol, unknown>): () => void {
  const control: PodControl = {
    podAction: (workspaceId, action, options) => source.podControl(workspaceId, action, { force: options?.force === true }),
  };
  target[POD_CONTROL_KEY] = control;
  return () => {
    if (target[POD_CONTROL_KEY] === control) delete target[POD_CONTROL_KEY];
  };
}
