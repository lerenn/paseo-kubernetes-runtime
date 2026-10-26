import { homedir } from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { credentialsRemove, credentialsSet, credentialsStatus } from "./shared/credentials.js";
import { ConfigSchema, kubeSettings } from "./shared/settings.js";
import { kubePodAction, kubeReconcile, kubeStatus } from "./shared/status.js";
import { paseoWorkspaces } from "./server/orphans.js";
import { paseoAgents, readPodRows } from "./server/status.js";
import { readDaemonId } from "./server/daemon.js";
import { readStatus, removeCredential, setCredential } from "./server/credentials.js";
import { Kubectl } from "./server/kube.js";
import { migrateLegacyData } from "./server/migrate.js";
import { OrphanReaper } from "./server/orphans.js";
import { podOnlyAgent, podOnlyWorkspace } from "./server/pod-only.js";
import { LABELS_REF_ENV, LabelHandoff, withAgentLabels } from "./server/label-handoff.js";
import { labelsOfAgent, workspaceAgentsBusy, type AgentListApi } from "./server/agent-activity.js";
import { PodRegistry } from "./server/registry.js";
import { KubernetesRuntime } from "./server/runtime.js";
import { RUNTIME_ID } from "./shared/runtime-options.js";
import type { WorkspaceRuntimeRegistration } from "./server/runtime-types.js";

export default function contribute(server: PluginServerContext) {
  // Before the settings are read: bring over what the plugin kept under its former id, `kube-agents`.
  try {
    const moved = migrateLegacyData();
    if (moved.copied.length) console.log(`[kubernetes-runtime] migrated ${moved.copied.join(", ")} from kube-agents (backup: ${moved.backup})`);
  } catch (error) {
    console.log(`[kubernetes-runtime] could not migrate data from kube-agents: ${(error as Error).message}`);
  }

  const settings = server.registerSettings(kubeSettings);
  const getConfig = async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Kubernetes Runtime settings are invalid: ${state.error}`);
    return ConfigSchema.parse(state.values);
  };
  const kubeFor = (c: { context?: string; namespace: string }) => new Kubectl({ context: c.context, namespace: c.namespace });
  const registry = new PodRegistry();
  const daemonId = readDaemonId();

  // The Paseo API only reaches a plugin through hook, event and RPC contexts: keep the first one seen, for the idle check.
  let paseoApi: AgentListApi | null = null;
  const capture = (ctx: { paseo?: unknown } | undefined) => {
    if (ctx?.paseo && !paseoApi) paseoApi = ctx.paseo as AgentListApi;
  };
  const runtime = new KubernetesRuntime({ getConfig, kubeFor, daemonId, registry, agentsBusy: (workspaceId) => workspaceAgentsBusy(paseoApi, workspaceId),
    recoveryStateFile: path.join(process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"), "plugin-data", "kubernetes-runtime", "interruptions.json"),
    // the fork's `skip` (never steer a running turn) is not in the published SDK's types
    messenger: {
      async send(agentId, text, behavior) {
        if (!paseoApi) throw new Error("Paseo's API has not reached the plugin yet");
        await (paseoApi as unknown as { agents: { ref(id: string): { send(text: string, o: { activeTurnBehavior: string }): Promise<void> } } }).agents.ref(agentId).send(text, { activeTurnBehavior: behavior });
      },
    },
  });
  // The workspace runtime API is in Paseo's fork; on a Paseo without it the plugin still loads (settings, credentials) and says why it does nothing.
  const registerRuntime = (server as unknown as { registerWorkspaceRuntime?: (r: WorkspaceRuntimeRegistration) => void }).registerWorkspaceRuntime;
  if (typeof registerRuntime === "function") {
    registerRuntime.call(server, runtime.registration());
    void runtime.start();
  } else {
    console.log("[kubernetes-runtime] this Paseo has no workspace runtimes; update Paseo to run workspaces in pods");
  }

  // The first agent of a workspace picks its pod's ServiceAccount by label. Its session opens before the pod is
  // launched, so the labels are recorded then; the published SDK's hook payload has none, so they are read from
  // the agent list (a fork that puts `labels` on the request is used directly).
  const handoff = new LabelHandoff();
  server.before("agent.session_open", async ({ request }, { paseo }) => {
    capture({ paseo });
    try {
      if (!request.workspaceId) return;
      let labels = handoff.find(request.env?.[LABELS_REF_ENV]) ?? (request as { labels?: Record<string, string> }).labels;
      labels ??= await labelsOfAgent(paseo as AgentListApi, request.agentId);
      runtime.noteAgent(request.workspaceId, labels);
    } catch {
      // labels are an optimisation of access, never a reason to stop a session
    }
  });

  for (const name of ["agent.created", "agent.turn_started", "agent.turn_ended"] as const) server.on(name, (_event, ctx) => capture(ctx));

  // Pod-only mode (off by default). A refusal is the hook's error, shown to whoever made the request.
  server.before("workspace.create", async ({ request }) => {
    const { podOnly } = await getConfig();
    return withAgentLabels(podOnlyWorkspace(request as never, podOnly), RUNTIME_ID) as never;
  });
  server.before("agent.create", async ({ request }) => {
    const { podOnly } = await getConfig();
    podOnlyAgent(request as never, podOnly);
    // leave the agent's labels for its session hook (see LabelHandoff); only when the daemon gives them
    const labels = (request as { labels?: Record<string, string> }).labels;
    if (!labels || Object.keys(labels).length === 0) return;
    return { ...request, env: { ...(request.env ?? {}), [LABELS_REF_ENV]: handoff.issue(labels) } } as never;
  });

  const reaper = new OrphanReaper({
    getConfig,
    kubeFor,
    daemonId,
    activeSandboxes: () => new Set(registry.list().map((p) => p.sandbox)),
    onNames: (names) => runtime.syncNames(names),
  });
  reaper.start();

  server.handle(credentialsStatus, () => ({ set: readStatus() }));
  server.handle(credentialsSet, async ({ key, value }) => {
    const config = await getConfig();
    return { set: await setCredential(kubeFor(config), config.credentialsSecret, key, value) };
  });
  server.handle(credentialsRemove, async ({ key }) => {
    const config = await getConfig();
    return { set: await removeCredential(kubeFor(config), config.credentialsSecret, key) };
  });
  server.handle(kubeStatus, async () => {
    const config = await getConfig();
    const [titles, agents] = await Promise.all([paseoWorkspaces(), paseoAgents()]);
    const pods = await readPodRows(kubeFor(config), daemonId, registry.list(), titles, agents);
    return { reaper: reaper.current(), pods };
  });
  server.handle(kubePodAction, ({ workspaceId, action, force, archive }) => runtime.podAction(workspaceId, action, { force, archive }));
  server.handle(kubeReconcile, async () => ({ reaper: await reaper.run() }));


  return async () => {
    await runtime.stop();
    reaper.stop();
  };
}
