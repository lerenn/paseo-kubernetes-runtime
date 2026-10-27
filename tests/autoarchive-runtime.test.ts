import { describe, expect, it } from "vitest";
import { KubernetesRuntime } from "../server/runtime.js";
import { PROBE_ANNOTATION, PROBE_SCRIPT, WARNED_ANNOTATION } from "../server/autoarchive.js";
import { PodRegistry } from "../server/registry.js";
import { ConfigSchema } from "../shared/settings.js";
import { FakeKube, fakeSeeder } from "./fakes.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const CLEAN = "HEAD abc123\nPROBE DONE\n";
const DIRTY = "BLOCK uncommitted or untracked files\nHEAD abc123\nPROBE DONE\n";
const repo = async () => ({ url: "https://github.com/lerenn/x.git", branch: "main" });
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Archived {
  id: string;
  options?: { reason?: string; ifIdle?: boolean };
}

function setup(autoArchive: object = {}, extra: object = {}, kube = new FakeKube(), clock = { t: 1_000_000 }, settings: object = {}) {
  const archived: Archived[] = [];
  const notices: [string, string | undefined][] = [];
  const runtime = new KubernetesRuntime({
    getConfig: async () => ConfigSchema.parse({ readyTimeoutSeconds: 1, podIdleMinutes: 30, autoArchive: { dryRun: false, ...autoArchive }, ...settings }),
    kubeFor: () => kube,
    daemonId: "srv_ME",
    registry: new PodRegistry(),
    seeder: fakeSeeder,
    detectRepo: repo,
    git: async () => ({ code: 1, stdout: "", stderr: "" }),
    sleep: async () => undefined,
    now: () => clock.t++,
    ticker: () => () => undefined,
    log: () => undefined,
    workspaceBusy: async () => false,
    workspaceLabels: async () => [{}],
    archiveWorkspace: async (id: string, options?: Archived["options"]) => void archived.push({ id, options }),
    ...extra,
  });
  const ctx = { notice: (m: string, l?: "info" | "warning" | "error") => void notices.push([m, l]), signal: new AbortController().signal };
  const prepare = (n = 1, over: object = {}) =>
    runtime.registration().prepare!({ workspaceId: `wks_${n}`, options: { cwd: `/home/me/repo${n}`, slug: `ws-${n}`, ref: null }, purpose: "session", argv: ["claude"], env: { PASEO_AGENT_ID: "a1" }, ...over } as never, ctx);
  return { runtime, kube, archived, notices, clock, prepare, advance: (ms: number) => void (clock.t += ms), check: async () => { await runtime.checkAutoArchive(); await flush(); } };
}

/** The probe answers from `answers` in turn (the last repeats); every other command succeeds. */
function scriptProbe(kube: FakeKube, ...answers: string[]) {
  const seen = { probes: 0 };
  const original = kube.exec.bind(kube);
  kube.exec = async (pod: string, argv: string[]) => {
    if (argv[0] === "sh" && argv[2] === PROBE_SCRIPT) return { code: 0, stdout: answers[Math.min(seen.probes++, answers.length - 1)]!, stderr: "" };
    return original(pod, argv);
  };
  return seen;
}

const annotations = (kube: FakeKube, name = 0) => kube.sandboxes[name]!.annotations;

describe("auto-archive: warn, then archive", () => {
  it("warns an idle workspace, and archives it with a reason once the warning is old enough", async () => {
    const t = setup();
    scriptProbe(t.kube, CLEAN);
    await t.prepare();
    t.advance(3 * D);
    await t.check();
    expect(t.archived).toEqual([]);
    expect(annotations(t.kube)[WARNED_ANNOTATION]).toBeTruthy();
    expect(t.notices.some(([m, l]) => /archived in 12h unless it is used/.test(m) && l === "warning")).toBe(true);
    expect(t.runtime.describeWorkspace({ workspaceId: "wks_1" } as never)!.tooltip).toMatch(/archives in 12h unless activity/);

    t.advance(6 * H);
    await t.check();
    expect(t.archived).toEqual([]); // 6 h into the 12 h warning
    t.advance(7 * H);
    await t.check();
    expect(t.archived).toEqual([{ id: "wks_1", options: { reason: "auto-archived: idle 3d", ifIdle: true } }]);
    expect(t.runtime.autoArchiveStatus(ConfigSchema.parse({})).recent[0]).toMatchObject({ outcome: "archived", workspaceId: "wks_1", dryRun: false });
  });

  it("any input clears the warning and restarts the clock", async () => {
    const t = setup();
    scriptProbe(t.kube, CLEAN);
    await t.prepare();
    t.advance(3 * D);
    await t.check();
    expect(annotations(t.kube)[WARNED_ANNOTATION]).toBeTruthy();
    await t.runtime.registration().beforeInput!({ workspaceId: "wks_1", options: { cwd: "/home/me/repo1", slug: "ws-1", ref: null } } as never, { notice: () => undefined, signal: new AbortController().signal } as never);
    await flush();
    expect(annotations(t.kube)[WARNED_ANNOTATION]).toBeNull();
    expect(t.runtime.describeWorkspace({ workspaceId: "wks_1" } as never)!.tooltip).not.toMatch(/archives in/);
    t.advance(13 * H);
    await t.check();
    expect(t.archived).toEqual([]);
  });

  it("in a dry run it warns and logs what it would do, and archives nothing", async () => {
    const t = setup({ dryRun: true });
    scriptProbe(t.kube, CLEAN);
    await t.prepare();
    t.advance(3 * D);
    await t.check();
    expect(t.notices.some(([m]) => /dry run/.test(m))).toBe(true);
    t.advance(13 * H);
    await t.check();
    await t.check();
    expect(t.archived).toEqual([]);
    const recent = t.runtime.autoArchiveStatus(ConfigSchema.parse({})).recent;
    expect(recent).toHaveLength(1); // logged once
    expect(recent[0]).toMatchObject({ outcome: "would-archive", dryRun: true, reason: "auto-archived: idle 3d" });
  });

  it("is a no-op when disabled", async () => {
    const t = setup({ enabled: false });
    await t.prepare();
    t.advance(30 * D);
    await t.check();
    expect(t.archived).toEqual([]);
    expect(annotations(t.kube)[WARNED_ANNOTATION]).toBeUndefined();
  });

  it("does not archive when the final re-check under the workspace queue fails", async () => {
    // an agent is idle at the decision and working a moment later
    let calls = 0;
    const t = setup({}, { agentsBusy: async () => calls++ >= 2 });
    scriptProbe(t.kube, CLEAN);
    await t.prepare();
    t.advance(3 * D);
    await t.check(); // warn (call 0)
    t.advance(13 * H);
    await t.check(); // decision (call 1), re-check (call 2: busy)
    expect(t.archived).toEqual([]);
  });

  it("does not archive when the final probe finds work that is on no remote", async () => {
    const t = setup();
    const seen = scriptProbe(t.kube, CLEAN, CLEAN, DIRTY);
    await t.prepare();
    t.advance(3 * D);
    await t.check(); // probe 1
    t.advance(13 * H);
    await t.check(); // probe 2 (look), probe 3 (final): dirty
    expect(seen.probes).toBe(3);
    expect(t.archived).toEqual([]);
  });

  it("never warns or archives a workspace that is not clean, and lists it with the reason and age", async () => {
    const t = setup();
    scriptProbe(t.kube, DIRTY);
    await t.prepare();
    t.advance(3 * D);
    await t.check();
    expect(t.notices.some(([m]) => /archived in/.test(m))).toBe(false);
    const status = t.runtime.autoArchiveStatus(ConfigSchema.parse({}));
    expect(status.blocked).toEqual([expect.objectContaining({ workspaceId: "wks_1", reason: "uncommitted or untracked files", idleSince: expect.any(String) })]);
    expect(t.runtime.autoArchiveBadge("wks_1")).toMatchObject({ autoArchive: "blocked" });
    t.advance(2 * D);
    await t.check();
    expect(t.archived).toEqual([]);
  });

  it("does not archive when the probe cannot run (unknown)", async () => {
    const t = setup();
    scriptProbe(t.kube, "");
    await t.prepare();
    t.advance(3 * D);
    await t.check();
    t.advance(13 * H);
    await t.check();
    expect(t.archived).toEqual([]);
    expect(t.runtime.autoArchiveStatus(ConfigSchema.parse({})).blocked).toHaveLength(1);
  });

  it("leaves exempt-labelled, kept and seeded workspaces alone", async () => {
    const labelled = setup({}, { workspaceLabels: async () => [{ "paseo.keep": "1" }] });
    await labelled.prepare();
    labelled.advance(30 * D);
    await labelled.check();
    expect(labelled.archived).toEqual([]);
    expect(labelled.runtime.autoArchiveBadge("wks_1")).toMatchObject({ autoArchive: "kept" });

    const kept = setup();
    scriptProbe(kept.kube, CLEAN);
    await kept.prepare();
    expect(await kept.runtime.setKeep("wks_1", true)).toEqual({ ok: true });
    expect(annotations(kept.kube)["paseo.sh/keep"]).toBe("true");
    kept.advance(30 * D);
    await kept.check();
    expect(kept.archived).toEqual([]);
    expect(kept.runtime.autoArchiveBadge("wks_1")).toMatchObject({ autoArchive: "kept" });

    const seeded = setup({}, {}, new FakeKube(), { t: 1_000_000 }, { profiles: { big: { seed: [{ from: "/data", to: "data" }] } } });
    scriptProbe(seeded.kube, CLEAN);
    await seeded.prepare(1, { options: { cwd: "/home/me/repo1", slug: "ws-1", ref: null, profile: "big" } });
    seeded.advance(30 * D);
    await seeded.check();
    seeded.advance(2 * D);
    await seeded.check();
    expect(seeded.archived).toEqual([]);
  });

  it("does not decide when Paseo cannot say whether an agent is working", async () => {
    const t = setup({}, { workspaceBusy: async () => null });
    await t.prepare();
    t.advance(30 * D);
    await t.check();
    expect(t.archived).toEqual([]);
    expect(t.runtime.autoArchiveStatus(ConfigSchema.parse({})).blocked[0]!.reason).toMatch(/could not say/);
  });

  it("treats an agent at work as activity", async () => {
    const t = setup({}, { workspaceBusy: async () => true });
    await t.prepare();
    t.advance(30 * D);
    await t.check();
    t.advance(30 * D);
    await t.check();
    expect(t.archived).toEqual([]);
    expect(annotations(t.kube)[WARNED_ANNOTATION]).toBeUndefined();
  });

  it("archives at most maxPerRun a run, oldest first", async () => {
    const t = setup({ maxPerRun: 2, warnHours: 0 });
    scriptProbe(t.kube, CLEAN);
    for (const n of [1, 2, 3, 4]) {
      await t.prepare(n);
      t.advance(H);
    }
    t.advance(3 * D);
    await t.check();
    expect(t.archived.map((a) => a.id)).toEqual(["wks_1", "wks_2"]);
    await t.check();
    expect(t.archived.map((a) => a.id)).toEqual(["wks_1", "wks_2", "wks_1", "wks_2"]); // the fake never destroys them; a real archive removes the Sandbox
  });

  it("archives throwaway workspaces sooner", async () => {
    const t = setup({ warnHours: 0 }, { workspaceLabels: async () => [{ "paseo.ephemeral": "1" }] });
    scriptProbe(t.kube, CLEAN);
    await t.prepare();
    t.advance(7 * H);
    await t.check();
    expect(t.archived).toEqual([{ id: "wks_1", options: { reason: "auto-archived: idle 7h", ifIdle: true } }]);
  });

  it("reports a failed archive in the log", async () => {
    const t = setup({ warnHours: 0 }, { archiveWorkspace: async () => { throw new Error("Workspace wks_1 is not idle"); } });
    scriptProbe(t.kube, CLEAN);
    await t.prepare();
    t.advance(3 * D);
    await t.check();
    expect(t.runtime.autoArchiveStatus(ConfigSchema.parse({})).recent[0]).toMatchObject({ outcome: "failed", detail: expect.stringMatching(/not idle/) });
  });
});

describe("auto-archive: suspended workspaces", () => {
  const suspendIt = async (t: ReturnType<typeof setup>) => {
    await t.prepare();
    t.advance(31 * MIN);
    await t.runtime.checkIdle();
  };

  it("runs the probe as the pod is suspended and stores the result and the idle clock on the Sandbox; a resume clears the result", async () => {
    const t = setup();
    scriptProbe(t.kube, DIRTY);
    await suspendIt(t);
    expect(t.kube.sandboxes[0]!.operatingMode).toBe("Suspended");
    const stored = JSON.parse(annotations(t.kube)[PROBE_ANNOTATION]!);
    expect(stored).toMatchObject({ state: "blocked", reasons: ["uncommitted or untracked files"], head: "abc123" });
    expect(annotations(t.kube)["paseo.sh/last-activity"]).toBeTruthy();
    await t.prepare();
    await flush();
    expect(annotations(t.kube)[PROBE_ANNOTATION] ?? null).toBeNull();
  });

  it("judges a suspended workspace by its stored result, without touching the pod", async () => {
    const dirty = setup();
    scriptProbe(dirty.kube, DIRTY);
    await suspendIt(dirty);
    dirty.advance(3 * D);
    const calls = dirty.kube.calls.length;
    await dirty.check();
    expect(dirty.kube.calls.slice(calls).filter((c) => !c.startsWith("patch:") && !c.startsWith("pod:"))).toEqual([]);
    expect(dirty.runtime.autoArchiveStatus(ConfigSchema.parse({})).blocked[0]!.reason).toBe("uncommitted or untracked files");

    const clean = setup({ warnHours: 0 });
    scriptProbe(clean.kube, CLEAN);
    await suspendIt(clean);
    clean.advance(3 * D);
    await clean.check();
    expect(clean.archived.map((a) => a.id)).toEqual(["wks_1"]);
  });

  it("keeps the idle clock across a plugin restart: the new plugin reads it from the Sandbox", async () => {
    const first = setup();
    scriptProbe(first.kube, CLEAN);
    await suspendIt(first);
    first.advance(3 * D);
    // a new plugin process: nothing in memory, the same cluster and the same wall clock
    const second = setup({}, {}, first.kube, first.clock);
    await second.runtime.start();
    await second.check();
    expect(annotations(first.kube)[WARNED_ANNOTATION]).toBeTruthy(); // idle for 3 days, not for 0
  });

  it("resumes a legacy suspended workspace briefly to take the check, one at a time, then suspends it again", async () => {
    const first = setup();
    const seen = scriptProbe(first.kube, CLEAN);
    await suspendIt(first);
    delete annotations(first.kube)[PROBE_ANNOTATION]; // suspended before the check existed
    first.advance(3 * D);
    const second = setup({}, {}, first.kube, first.clock);
    await second.runtime.start();
    const before = seen.probes;
    await second.check();
    expect(seen.probes).toBe(before + 1);
    const modes = first.kube.patches2.map((p) => p.patch.spec?.operatingMode).filter(Boolean);
    expect(modes.slice(-2)).toEqual(["Running", "Suspended"]);
    expect(first.kube.sandboxes[0]!.operatingMode).toBe("Suspended");
    expect(JSON.parse(annotations(first.kube)[PROBE_ANNOTATION]!).state).toBe("clean");
    expect(annotations(first.kube)[WARNED_ANNOTATION]).toBeTruthy();
  });

  it("skips the brief resume when the namespace is nearly out of pods", async () => {
    const first = setup();
    const seen = scriptProbe(first.kube, CLEAN);
    await suspendIt(first);
    delete annotations(first.kube)[PROBE_ANNOTATION];
    first.advance(3 * D);
    const second = setup({ podQuota: 2 }, {}, first.kube, first.clock);
    await second.runtime.start();
    const before = seen.probes;
    await second.check();
    expect(seen.probes).toBe(before);
    expect(first.kube.sandboxes[0]!.operatingMode).toBe("Suspended");
    expect(second.runtime.autoArchiveStatus(ConfigSchema.parse({})).blocked[0]!.reason).toMatch(/pod quota/);
  });
});
