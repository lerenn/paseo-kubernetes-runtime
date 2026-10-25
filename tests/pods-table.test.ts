import { describe, expect, it } from "vitest";
import { actionsFor, ago, reaperLine } from "../shared/pods-view.js";
import { agentsIn, buildPodRows, shortImage } from "../server/status.js";

const sandbox = (name: string, extra: object = {}) => ({
  name,
  labels: { "paseo.sh/daemon": "srv_ME", "paseo.sh/workspace-id": `wks_${name}`, "paseo.sh/workspace": `label-${name}` },
  annotations: { "paseo.sh/cwd": `/w/${name}`, "paseo.sh/workspace-name": `Full name ${name}` },
  operatingMode: "Running" as const,
  image: "ghcr.io/lerenn/paseo-kubernetes-runtime-default@sha256:f4aedb1145658527f3e43dd1ae6d95a917b39e94799491eae6f9c400ccd8e3b5",
  ...extra,
});

describe("the pods table rows", () => {
  it("shortens images to name@digest or name:tag", () => {
    expect(shortImage("ghcr.io/lerenn/paseo-kubernetes-runtime-default@sha256:f4aedb1145658527f3e43dd1ae6d95a917b39e94799491eae6f9c400ccd8e3b5")).toBe("paseo-kubernetes-runtime-default@f4aedb114565");
    expect(shortImage("node:22-bookworm")).toBe("node:22-bookworm");
    expect(shortImage(undefined)).toBeUndefined();
  });

  it("matches agents to a workspace by directory, including subdirectories but not siblings", () => {
    const agents = [
      { id: "a", title: "in", status: "running", cwd: "/w/x" },
      { id: "b", title: "sub", status: "idle", cwd: "/w/x/sub" },
      { id: "c", title: "sibling", status: "idle", cwd: "/w/xy" },
    ];
    expect(agentsIn(agents, "/w/x").map((a) => a.id)).toEqual(["a", "b"]);
    expect(agentsIn(agents, undefined)).toEqual([]);
  });

  it("builds a row per workspace with state, title, image, size and agents", () => {
    const rows = buildPodRows({
      sandboxes: [
        sandbox("run"),
        sandbox("sus", { operatingMode: "Suspended" }),
        sandbox("new"),
        sandbox("bad"),
        { ...sandbox("nolabel"), labels: { "paseo.sh/daemon": "srv_ME" } },
      ],
      claims: [{ name: "workspace-run", labels: {}, size: "10Gi" }],
      pods: new Map([
        ["run", { uid: "u", ready: true, terminating: false }],
        ["sus", null],
        ["new", { uid: "u", ready: false, terminating: false }],
        ["bad", { uid: "u", ready: false, terminating: false, problem: "Pod cannot be scheduled: no capacity" }],
      ]),
      entries: [{ workspaceId: "wks_run", sandbox: "run", state: "running", since: Date.parse("2026-10-25T00:00:00Z") }],
      titles: new Map([["wks_run", "My workspace"]]),
      agents: [{ id: "ag", title: "claude", status: "running", cwd: "/w/run" }],
    });
    expect(rows.map((r) => [r.sandbox, r.state])).toEqual([["bad", "error"], ["new", "creating"], ["sus", "suspended"], ["run", "running"]]); // sorted by title
    const run = rows.find((r) => r.sandbox === "run")!;
    expect(run).toMatchObject({ title: "My workspace", size: "10Gi", image: "paseo-kubernetes-runtime-default@f4aedb114565", since: "2026-10-25T00:00:00.000Z" });
    expect(run.agents).toEqual([{ id: "ag", title: "claude", status: "running" }]);
    expect(rows.find((r) => r.sandbox === "bad")!.problem).toMatch(/no capacity/);
    expect(rows.find((r) => r.sandbox === "sus")!.title).toBe("Full name sus"); // no Paseo title: the annotation
  });

  it("offers the right actions per state and words the reconcile line", () => {
    expect(actionsFor("running")).toEqual(["suspend", "restart", "delete"]);
    expect(actionsFor("suspended")).toEqual(["resume", "delete"]);
    expect(actionsFor("creating")).toEqual(["delete"]);
    expect(actionsFor("error")).toEqual(["delete"]);
    expect(reaperLine({ removed: 0, unlabelled: [] })).toBe("Orphan cleanup: not run yet");
    expect(reaperLine({ removed: 2, unlabelled: ["a"], lastRunAt: new Date().toISOString() })).toBe("Last reconcile: 2 orphans removed (just now); 1 unlabelled left alone");
    expect(ago(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3 h ago");
  });
});
