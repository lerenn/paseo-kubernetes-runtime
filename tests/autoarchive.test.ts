import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutoArchiveLog, decide, parseProbe, readStoredProbe, stringifyProbe, type Facts } from "../server/autoarchive.js";
import { parseArchiveHelp } from "../server/runtime.js";
import { AutoArchiveSchema, ConfigSchema } from "../shared/settings.js";

const H = 3_600_000;
const D = 24 * H;
const NOW = 100 * D;
const cfg = (over: object = {}) => AutoArchiveSchema.parse({ dryRun: false, ...over });
const facts = (over: Partial<Facts> = {}): Facts => ({ now: NOW, lastActivity: NOW - 3 * D, createdAt: NOW - 20 * D, pinned: false, seed: false, labels: [{}], busy: false, ...over });

describe("auto-archive settings", () => {
  it("defaults to a dry run, 2 idle days, a 12 h warning, 3 per run", () => {
    expect(AutoArchiveSchema.parse({})).toMatchObject({ enabled: true, dryRun: true, idleDays: 2, warnHours: 12, exemptLabels: ["paseo.keep=1"], maxPerRun: 3, ephemeral: { label: "paseo.ephemeral=1", idleHours: 6 } });
    expect(AutoArchiveSchema.parse({}).maxAgeDays).toBeUndefined();
    expect(ConfigSchema.parse({}).autoArchive.dryRun).toBe(true);
  });

  it("refuses an idle time that is not longer than the pod idle suspension", () => {
    expect(() => ConfigSchema.parse({ podIdleMinutes: 3000 })).toThrow(/longer than podIdleMinutes/);
    expect(() => ConfigSchema.parse({ podIdleMinutes: 400, autoArchive: { ephemeral: { idleHours: 6 } } })).toThrow(/ephemeral/);
    expect(ConfigSchema.parse({ podIdleMinutes: 3000, autoArchive: { idleDays: 0, ephemeral: { idleHours: 0 } } }).podIdleMinutes).toBe(3000);
    expect(ConfigSchema.parse({ podIdleMinutes: 3000, autoArchive: { enabled: false } }).podIdleMinutes).toBe(3000);
  });
});

describe("the decision table", () => {
  it("does nothing when disabled or when both idle limits are 0", () => {
    expect(decide(facts(), cfg({ enabled: false }))).toEqual({ kind: "off" });
    expect(decide(facts(), cfg({ idleDays: 0, ephemeral: { idleHours: 0 } }))).toEqual({ kind: "off" });
  });

  it("leaves a recently used workspace alone", () => {
    expect(decide(facts({ lastActivity: NOW - D }), cfg())).toMatchObject({ kind: "active" });
  });

  it("warns first when idle for idleDays, then schedules, then is due after warnHours", () => {
    const warn = decide(facts(), cfg());
    expect(warn).toMatchObject({ kind: "warn", archiveAt: NOW + 12 * H, reason: "auto-archived: idle 3d" });
    expect(decide(facts({ warnedAt: NOW - 3 * H }), cfg())).toMatchObject({ kind: "scheduled", archiveAt: NOW + 9 * H });
    expect(decide(facts({ warnedAt: NOW - 12 * H }), cfg())).toMatchObject({ kind: "due", reason: "auto-archived: idle 3d" });
  });

  it("archives at once with a 0 h warning", () => {
    expect(decide(facts(), cfg({ warnHours: 0 }))).toMatchObject({ kind: "due" });
  });

  it("ignores a warning older than the last activity (any input clears it)", () => {
    expect(decide(facts({ lastActivity: NOW - 3 * D, warnedAt: NOW - 4 * D }), cfg())).toMatchObject({ kind: "warn" });
  });

  it("exempts labelled, pinned and seeded workspaces", () => {
    expect(decide(facts({ labels: [{}, { "paseo.keep": "1" }] }), cfg())).toMatchObject({ kind: "exempt", why: "exempt label" });
    expect(decide(facts({ pinned: true }), cfg())).toMatchObject({ kind: "exempt", why: "kept" });
    expect(decide(facts({ seed: true }), cfg())).toMatchObject({ kind: "exempt" });
    expect(decide(facts({ labels: [{ "paseo.keep": "0" }] }), cfg())).toMatchObject({ kind: "warn" });
    expect(decide(facts({ labels: [{ team: "x" }] }), cfg({ exemptLabels: ["team"] }))).toMatchObject({ kind: "exempt" });
  });

  it("never decides on what it cannot read: unknown labels, unknown activity, unknown busy", () => {
    expect(decide(facts({ labels: null }), cfg())).toMatchObject({ kind: "blocked" });
    expect(decide(facts({ lastActivity: undefined }), cfg())).toMatchObject({ kind: "blocked" });
    expect(decide(facts({ busy: null }), cfg())).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/could not say/) });
  });

  it("treats a busy workspace as active", () => {
    expect(decide(facts({ busy: true }), cfg())).toMatchObject({ kind: "active" });
  });

  it("archives throwaway workspaces after ephemeral.idleHours", () => {
    const f = facts({ lastActivity: NOW - 7 * H, labels: [{ "paseo.ephemeral": "1" }] });
    expect(decide(f, cfg())).toMatchObject({ kind: "warn", reason: "auto-archived: idle 7h" });
    expect(decide({ ...f, labels: [{}] }, cfg())).toMatchObject({ kind: "active" });
    expect(decide({ ...f, lastActivity: NOW - 5 * H }, cfg())).toMatchObject({ kind: "active" });
  });

  it("applies maxAgeDays as a ceiling whatever the activity", () => {
    const f = facts({ lastActivity: NOW - 60_000, createdAt: NOW - 15 * D });
    expect(decide(f, cfg())).toMatchObject({ kind: "active" }); // off by default
    expect(decide(f, cfg({ maxAgeDays: 14 }))).toMatchObject({ kind: "warn", reason: "auto-archived: older than 15d" });
    expect(decide({ ...f, createdAt: NOW - 10 * D }, cfg({ maxAgeDays: 14 }))).toMatchObject({ kind: "active" });
    expect(decide({ ...f, busy: true }, cfg({ maxAgeDays: 14 }))).toMatchObject({ kind: "active" });
  });

  it("keeps the idle clock from the Sandbox annotation across a plugin restart: the clock is the persisted time, not the restart", () => {
    // a restarted plugin passes the annotation's time as lastActivity; a restart at NOW does not reset it
    expect(decide(facts({ lastActivity: NOW - 3 * D }), cfg())).toMatchObject({ kind: "warn", idleMs: 3 * D });
  });
});

describe("the probe's output", () => {
  const at = 5;
  it("is clean only for a finished run with no findings", () => {
    expect(parseProbe(0, "HEAD abc\nPROBE DONE\n", at)).toEqual({ state: "clean", reasons: [], head: "abc", at });
    expect(parseProbe(0, "HEAD abc\n", at).state).toBe("unknown");
    expect(parseProbe(1, "HEAD abc\nPROBE DONE\n", at).state).toBe("unknown");
    expect(parseProbe(0, "", at).state).toBe("unknown");
  });
  it("reports findings, seed data and unknowns", () => {
    expect(parseProbe(0, "BLOCK uncommitted or untracked files\nPROBE DONE", at)).toMatchObject({ state: "blocked", reasons: ["uncommitted or untracked files"] });
    expect(parseProbe(0, "UNKNOWN git fetch failed\nPROBE DONE", at).state).toBe("unknown");
    expect(parseProbe(0, "UNKNOWN git fetch failed\nBLOCK stash entries\nPROBE DONE", at).state).toBe("blocked");
    expect(parseProbe(0, "SEED the volume holds seed data\nPROBE DONE", at).state).toBe("seed");
  });
  it("round-trips through the annotation", () => {
    const p = { state: "blocked" as const, reasons: ["stash entries"], head: "abc", at: Date.parse("2026-10-27T00:00:00Z") };
    expect(readStoredProbe(stringifyProbe(p))).toEqual(p);
    expect(readStoredProbe("nonsense")).toBeUndefined();
    expect(readStoredProbe(undefined)).toBeUndefined();
  });
});

describe("the log and the CLI feature detection", () => {
  it("keeps the last 100 entries in a file, newest first", () => {
    const file = join(mkdtempSync(join(tmpdir(), "aa-log-")), "log.json");
    const log = new AutoArchiveLog(file);
    for (let i = 0; i < 105; i++) log.add({ at: String(i), workspaceId: `w${i}`, title: "t", reason: "r", outcome: "archived", dryRun: false });
    expect(log.list()).toHaveLength(100);
    expect(log.list()[0]!.workspaceId).toBe("w104");
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(100);
    expect(new AutoArchiveLog(file).list()[0]!.workspaceId).toBe("w104");
  });
  it("detects --reason and --if-idle in the archive help", () => {
    expect(parseArchiveHelp("Usage: paseo workspace archive [options] <workspace-id>\n  --json\n")).toEqual({ reason: false, ifIdle: false });
    expect(parseArchiveHelp("  --reason <text>  Why\n  --if-idle  Refuse")).toEqual({ reason: true, ifIdle: true });
  });
});
