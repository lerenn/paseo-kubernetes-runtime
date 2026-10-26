import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyStop, ResumeGuard, RESUME_MIN_GAP_MS } from "../server/interruption.js";

const pod = (over: object = {}) => ({ uid: "u1", ready: true, terminating: false, ...over });

describe("classifyStop", () => {
  it("calls a gone, replaced, deleted, disrupted or not-ready pod an interruption, and a healthy one a failure", () => {
    expect(classifyStop(null, "u1").kind).toBe("interrupted");
    expect(classifyStop(pod({ uid: "u2" }), "u1")).toMatchObject({ kind: "interrupted", why: "the pod was replaced" });
    expect(classifyStop(pod({ terminating: true }), "u1").kind).toBe("interrupted");
    expect(classifyStop(pod({ disrupted: "DeletionByTaintManager" }), "u1").why).toContain("DeletionByTaintManager");
    expect(classifyStop(pod({ ready: false, problem: "Pod cannot be scheduled: no capacity" }), "u1").why).toContain("no capacity");
    expect(classifyStop(pod(), "u1")).toMatchObject({ kind: "failed", why: "the pod is healthy" });
    expect(classifyStop(pod({ oomKilled: true }), "u1").why).toContain("memory");
    expect(classifyStop(pod(), undefined).kind).toBe("failed"); // no known uid to compare with: the pod is healthy
  });
});

describe("ResumeGuard", () => {
  const MIN = 60_000;
  it("allows one resume, then waits ten minutes, and three an hour at most", () => {
    const g = new ResumeGuard(null);
    expect(g.allow("a", 0)).toEqual({ ok: true });
    g.sent("a", 0);
    expect(g.allow("a", 5 * MIN)).toMatchObject({ ok: false, reason: expect.stringContaining("10 minutes") });
    expect(g.allow("a", RESUME_MIN_GAP_MS + 1).ok).toBe(true);
    g.sent("a", RESUME_MIN_GAP_MS + 1);
    expect(g.allow("a", 21 * MIN).ok).toBe(true);
    g.sent("a", 21 * MIN);
    expect(g.allow("a", 40 * MIN)).toMatchObject({ ok: false, reason: expect.stringContaining("3 times") });
    expect(g.allow("a", 62 * MIN).ok).toBe(true); // the first resume is more than an hour old
  });

  it("stops after two interruptions that come right after a resume, until a turn completes", () => {
    const g = new ResumeGuard(null);
    g.sent("a", 0);
    expect(g.allow("a", 1 * MIN).ok).toBe(false); // right after a resume: failure 1 (and the gap)
    g.sent("a", 20 * MIN);
    expect(g.allow("a", 21 * MIN)).toMatchObject({ ok: false, reason: expect.stringContaining("not trying again") }); // failure 2
    g.healthy("a");
    expect(g.allow("a", 40 * MIN).ok).toBe(true);
  });

  it("keeps its state in a file", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "guard-")), "state.json");
    const g = new ResumeGuard(file);
    g.sent("a", 1000);
    expect(new ResumeGuard(file).allow("a", 2000)).toMatchObject({ ok: false });
  });
});
