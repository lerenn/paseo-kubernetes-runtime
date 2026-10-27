import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AutoArchiveConfig } from "../shared/settings.js";

/** Annotations on the Sandbox: they survive a plugin restart and a pod suspend. */
export const LAST_ACTIVITY_ANNOTATION = "paseo.sh/last-activity";
export const WARNED_ANNOTATION = "paseo.sh/archive-warned-at";
/** Set by the Keep action on the screen: the workspace is never auto-archived. */
export const KEEP_ANNOTATION = "paseo.sh/keep";
/** The safety probe's result, taken while the pod was still up at suspend; a resume clears it. */
export const PROBE_ANNOTATION = "paseo.sh/archive-probe";

/** The last activity is written to the Sandbox at most this often. */
export const ACTIVITY_PERSIST_MS = 10 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Looks inside the pod for work that exists nowhere else: run with the checkout's path as its argument, it prints one
 * line per finding (`BLOCK`, `UNKNOWN`, `SEED`), `HEAD <sha>` and `PROBE DONE`. It fetches first, so "pushed" is judged
 * against the remote as it is now. The same checks run in every initialised submodule. Never fails: a probe that cannot
 * look says UNKNOWN, which blocks the archive just like a finding does.
 */
export const PROBE_SCRIPT = String.raw`
to() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }
LANDED='
# the branch changes are already in a remote default branch (squash-merged): merging it there changes nothing. A conflict, an old git without --write-tree or anything unclear says no.
landed() {
  defaults=$(for h in $(git for-each-ref --format="%(refname)" "refs/remotes/*/HEAD" "refs/remotes/*/main" "refs/remotes/*/master" 2>/dev/null); do git rev-parse --verify -q "$h^{commit}" >/dev/null 2>&1 && echo "$h"; done)
  for d in $defaults; do
    t=$(git merge-tree --write-tree "$d" "$1" 2>/dev/null) || continue
    [ "$(printf "%s" "$t" | head -n 1)" = "$(git rev-parse "$d^{tree}" 2>/dev/null)" ] && return 0
  done
  return 1
}
'
CHECK='
p="$1"
fail() { printf "BLOCK %s%s\n" "$p" "$1"; }
unk() { printf "UNKNOWN %s%s\n" "$p" "$1"; }
gd=$(git rev-parse --git-dir 2>/dev/null) || { unk "not a git repository"; exit 0; }
for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  [ -e "$gd/$f" ] && fail "a $f is in progress"
done
if [ -n "$(git remote 2>/dev/null)" ]; then
  if command -v timeout >/dev/null 2>&1; then timeout 120 git fetch --prune -q >/dev/null 2>&1 || unk "git fetch failed, so the remote cannot be compared"
  else git fetch --prune -q >/dev/null 2>&1 || unk "git fetch failed, so the remote cannot be compared"; fi
else
  unk "no remote"
fi
[ -n "$(git status --porcelain=v2 --untracked-files=all 2>/dev/null | head -n 1)" ] && fail "uncommitted or untracked files"
[ -n "$(git stash list 2>/dev/null | head -n 1)" ] && fail "stash entries"
# commits on no remote; a branch whose upstream is gone (deleted after its PR) is fine once it has landed in the default branch
blocking() {
  [ -z "$(git rev-list -n 1 "$1" --not --remotes 2>/dev/null)" ] && return 1
  case "$(git for-each-ref --format="%(upstream:track)" "$1" 2>/dev/null)" in *gone*) landed "$1" && return 1 ;; esac
  return 0
}
for b in $(git for-each-ref --format="%(refname)" refs/heads 2>/dev/null); do
  blocking "$b" && { fail "a local branch has commits that are on no remote"; break; }
done
blocking "$(git symbolic-ref -q HEAD 2>/dev/null || echo HEAD)" && fail "HEAD has commits that are on no remote"
exit 0
'
CHECK="$LANDED$CHECK"
eval "$LANDED"
export CHECK
root="$1"
cd "$root" 2>/dev/null || { echo "UNKNOWN no checkout at $root"; echo "PROBE DONE"; exit 0; }
[ -n "$(ls -A /workspace/.seeded 2>/dev/null)" ] && echo "SEED the volume holds seed data (profile.seed)"
sh -c "$CHECK" sh ""
echo "HEAD $(git rev-parse HEAD 2>/dev/null)"
git submodule foreach --quiet --recursive 'sh -c "$CHECK" sh "submodule $displaypath: "' 2>/dev/null
subs=$(git submodule foreach --quiet --recursive 'echo "$toplevel/$sm_path"' 2>/dev/null)
# what was pushed through the outbox and the mirrors must be on a remote too (the checkout or a submodule has it)
confirm() {
  git --git-dir="$1" for-each-ref --format='%(refname) %(objectname)' refs/heads refs/tags 2>/dev/null | while read -r ref sha; do
    seen=0; ok=0
    for r in "$root" $subs; do
      if git -C "$r" cat-file -e "$sha^{commit}" 2>/dev/null; then
        seen=1
        if [ -z "$(git -C "$r" rev-list -n 1 "$sha" --not --remotes 2>/dev/null)" ]; then ok=1; break; fi
        # a branch whose PR was squash-merged and deleted: its work is in the default branch there
        case "$ref" in refs/heads/*) if (cd "$r" && landed "$sha"); then ok=1; break; fi ;; esac
      fi
    done
    if [ "$seen" = 1 ] && [ "$ok" = 0 ]; then echo "BLOCK $2$ref is on no remote"; fi
  done
}
[ -d "$HOME/outbox.git" ] && confirm "$HOME/outbox.git" "outbox.git: "
for m in "$HOME"/mirrors/*.git; do [ -d "$m" ] && confirm "$m" "mirror $(basename "$m"): "; done
echo "PROBE DONE"
exit 0
`;

export interface ProbeResult {
  /** `clean`: nothing is lost by archiving. `seed`: the volume holds profile.seed data, never archived. */
  state: "clean" | "blocked" | "unknown" | "seed";
  /** Why, one line per finding. */
  reasons: string[];
  head?: string;
  /** Epoch ms the probe ran. */
  at: number;
}

/** Reads the probe's output. Anything but a complete run with no findings is not clean. */
export function parseProbe(code: number, stdout: string, at: number): ProbeResult {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const reasons: string[] = [];
  let unknown = false;
  let seed = false;
  let head: string | undefined;
  for (const line of lines) {
    if (line.startsWith("BLOCK ")) reasons.push(line.slice(6));
    else if (line.startsWith("UNKNOWN ")) (unknown = true), reasons.push(line.slice(8));
    else if (line.startsWith("SEED ")) (seed = true), reasons.push(line.slice(5));
    else if (line.startsWith("HEAD ")) head = line.slice(5) || undefined;
  }
  const done = lines.includes("PROBE DONE");
  if (code !== 0 || !done) return { state: "unknown", reasons: [...reasons, `the probe did not finish (exit ${code})`], ...(head ? { head } : {}), at };
  const state = seed ? "seed" : reasons.length === 0 ? "clean" : unknown && !lines.some((l) => l.startsWith("BLOCK ")) ? "unknown" : "blocked";
  return { state, reasons, ...(head ? { head } : {}), at };
}

export const stringifyProbe = (p: ProbeResult) => JSON.stringify({ at: new Date(p.at).toISOString(), state: p.state, reasons: p.reasons.slice(0, 8), head: p.head });

export function readStoredProbe(annotation: string | undefined): ProbeResult | undefined {
  if (!annotation) return undefined;
  try {
    const v = JSON.parse(annotation) as { at?: string; state?: string; reasons?: string[]; head?: string };
    const at = Date.parse(v.at ?? "");
    if (!Number.isFinite(at) || !["clean", "blocked", "unknown", "seed"].includes(v.state ?? "")) return undefined;
    return { state: v.state as ProbeResult["state"], reasons: v.reasons ?? [], ...(v.head ? { head: v.head } : {}), at };
  } catch {
    return undefined;
  }
}

export const readTime = (annotation: string | undefined): number | undefined => {
  const t = annotation ? Date.parse(annotation) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

export const ruleMatches = (rule: string, labels: Readonly<Record<string, string>>): boolean => {
  const i = rule.indexOf("=");
  return i < 0 ? rule in labels : labels[rule.slice(0, i)] === rule.slice(i + 1);
};

export interface Facts {
  now: number;
  createdAt?: number;
  /** The idle clock's start: the last activity. Undefined when it is not known. */
  lastActivity?: number;
  warnedAt?: number;
  /** The Keep action. */
  pinned: boolean;
  /** The workspace's profile has seed data. */
  seed: boolean;
  /** Labels of the workspace's agents; null when they cannot be read. */
  labels: Record<string, string>[] | null;
  /** Whether an agent works in the workspace (turn, permission, background work); null when unknown. */
  busy: boolean | null;
}

export type Verdict =
  | { kind: "off" }
  | { kind: "exempt"; why: string }
  | { kind: "blocked"; reason: string }
  | { kind: "active"; idleMs: number }
  /** Idle long enough: warn now, archive at `archiveAt`. */
  | { kind: "warn"; archiveAt: number; idleMs: number; reason: string }
  | { kind: "scheduled"; archiveAt: number; idleMs: number; reason: string }
  | { kind: "due"; idleMs: number; reason: string };

const spell = (ms: number) => (ms >= DAY ? `${Math.floor(ms / DAY)}d` : `${Math.max(1, Math.floor(ms / HOUR))}h`);

/** Whether the workspace is old or idle enough, and where it is in the warn-then-archive sequence. Pure. */
export function decide(f: Facts, cfg: AutoArchiveConfig): Verdict {
  if (!cfg.enabled) return { kind: "off" };
  if (f.seed) return { kind: "exempt", why: "profile with seed data" };
  if (f.pinned) return { kind: "exempt", why: "kept" };
  if (f.labels === null) return { kind: "blocked", reason: "the agents' labels cannot be read" };
  const exempt = f.labels.find((l) => cfg.exemptLabels.some((r) => ruleMatches(r, l)));
  if (exempt) return { kind: "exempt", why: "exempt label" };
  const ephemeral = f.labels.some((l) => ruleMatches(cfg.ephemeral.label, l));
  const limit = ephemeral && cfg.ephemeral.idleHours > 0 ? cfg.ephemeral.idleHours * HOUR : cfg.idleDays > 0 ? cfg.idleDays * DAY : 0;
  const maxAge = (cfg.maxAgeDays ?? 0) * DAY;
  const aged = maxAge > 0 && f.createdAt !== undefined && f.now - f.createdAt >= maxAge;
  if (limit === 0 && !aged) return { kind: "off" };
  if (f.lastActivity === undefined) return { kind: "blocked", reason: "the last activity is not known" };
  const idleMs = Math.max(0, f.now - f.lastActivity);
  const idle = limit > 0 && idleMs >= limit;
  if (!idle && !aged) return { kind: "active", idleMs };
  if (f.busy === null) return { kind: "blocked", reason: "Paseo could not say whether an agent is working" };
  if (f.busy) return { kind: "active", idleMs };
  const reason = idle ? `auto-archived: idle ${spell(idleMs)}` : `auto-archived: older than ${spell(f.now - (f.createdAt ?? f.now))}`;
  // a warning older than the last activity was cleared by it
  const warnedAt = f.warnedAt !== undefined && f.warnedAt >= f.lastActivity ? f.warnedAt : undefined;
  const waitMs = cfg.warnHours * HOUR;
  if (waitMs === 0) return { kind: "due", idleMs, reason };
  if (warnedAt === undefined) return { kind: "warn", archiveAt: f.now + waitMs, idleMs, reason };
  if (f.now - warnedAt >= waitMs) return { kind: "due", idleMs, reason };
  return { kind: "scheduled", archiveAt: warnedAt + waitMs, idleMs, reason };
}

export interface LogEntry {
  /** ISO time. */
  at: string;
  workspaceId: string;
  title: string;
  reason: string;
  outcome: "archived" | "would-archive" | "failed";
  dryRun: boolean;
  detail?: string;
}

export const LOG_LIMIT = 100;

/** The last auto-archive decisions, kept in a JSON file so the screen still shows them after a restart. */
export class AutoArchiveLog {
  private entries: LogEntry[];

  constructor(private readonly file: string | null) {
    this.entries = this.load();
  }

  private load(): LogEntry[] {
    if (!this.file) return [];
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v.slice(-LOG_LIMIT) : [];
    } catch {
      return [];
    }
  }

  add(entry: LogEntry): void {
    this.entries = [...this.entries, entry].slice(-LOG_LIMIT);
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(this.entries));
      renameSync(temp, this.file);
    } catch {
      // kept in memory
    }
  }

  /** Newest first. */
  list(): LogEntry[] {
    return [...this.entries].reverse();
  }
}
