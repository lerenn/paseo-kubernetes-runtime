import type { PodRow } from "./status.js";

export function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function reaperLine(r: { lastRunAt?: string; removed: number; error?: string; unlabelled: string[] }): string {
  if (r.error && !r.lastRunAt) return `Orphan cleanup: ${r.error}`;
  if (!r.lastRunAt) return "Orphan cleanup: not run yet";
  const unlabelled = r.unlabelled.length ? `; ${r.unlabelled.length} unlabelled left alone` : "";
  return `Last reconcile: ${r.removed} orphan${r.removed === 1 ? "" : "s"} removed (${ago(r.lastRunAt)})${unlabelled}${r.error ? `; failed: ${r.error}` : ""}`;
}

/** Which actions a pod in this state offers. */
export function actionsFor(state: PodRow["state"], workspaceId = ""): ("suspend" | "resume" | "restart" | "delete")[] {
  if (workspaceId.startsWith("warm:")) return ["delete"]; // a warm pod has no workspace: remove it, the pool starts another
  if (state === "running") return ["suspend", "restart", "delete"];
  if (state === "suspended") return ["resume", "delete"];
  return ["delete"]; // creating or error: the only way out is to remove it (a restart needs a running pod)
}
