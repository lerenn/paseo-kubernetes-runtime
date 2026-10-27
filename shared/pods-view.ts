import type { PodRow } from "./status.js";

export function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** "in 5 h" / "in 20 min" / "now" for a time ahead. */
export function until(iso: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
}

/** The text of the pinned-by-Keep badge: the Keep button toggles it. */
export const PINNED_TEXT = "kept: never auto-archived";

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
