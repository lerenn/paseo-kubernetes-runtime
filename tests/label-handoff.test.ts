import { describe, expect, it } from "vitest";
import { LabelHandoff, withAgentLabels } from "../server/label-handoff.js";

describe("LabelHandoff", () => {
  it("returns the labels left under a reference, and nothing for an unknown or missing one", () => {
    const h = new LabelHandoff();
    const ref = h.issue({ "paseo.scoped-daemon-access": "1" });
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(h.find(ref)).toEqual({ "paseo.scoped-daemon-access": "1" });
    expect(h.find("nope")).toBeUndefined();
    expect(h.find(undefined)).toBeUndefined();
    expect(h.issue({})).not.toBe(ref);
  });

  it("forgets the oldest references past its limit", () => {
    const h = new LabelHandoff(2);
    const a = h.issue({ n: "1" });
    h.issue({ n: "2" });
    h.issue({ n: "3" });
    expect(h.find(a)).toBeUndefined();
  });
});

describe("withAgentLabels", () => {
  const labels = { "paseo.scoped-daemon-access": "1", "paseo.role": "ops" };
  it("hands the first agent's labels to the Kubernetes runtime as its labels option", () => {
    const out = withAgentLabels({ runtime: { id: "kubernetes", options: { cwd: "/x" } }, agent: { labels } }, "kubernetes");
    expect(out.runtime).toEqual({ id: "kubernetes", options: { cwd: "/x", labels } });
  });
  it("keeps labels the creator set, other runtimes and requests without an agent", () => {
    const set = { runtime: { id: "kubernetes", options: { labels: { a: "b" } } }, agent: { labels } };
    expect(withAgentLabels(set, "kubernetes")).toBe(set);
    const other = { runtime: { id: "ssh" }, agent: { labels } };
    expect(withAgentLabels(other, "kubernetes")).toBe(other);
    const bare = { runtime: { id: "kubernetes" } };
    expect(withAgentLabels(bare, "kubernetes")).toBe(bare);
  });
});
