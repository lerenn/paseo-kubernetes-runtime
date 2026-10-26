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
import { PodRegistry } from "./server/registry.js";
import { KubernetesRuntime } from "./server/runtime.js";
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

  const runtime = new KubernetesRuntime({ getConfig, kubeFor, daemonId, registry });
  // The workspace runtime API is in Paseo's fork; on a Paseo without it the plugin still loads (settings, credentials) and says why it does nothing.
  const registerRuntime = (server as unknown as { registerWorkspaceRuntime?: (r: WorkspaceRuntimeRegistration) => void }).registerWorkspaceRuntime;
  if (typeof registerRuntime === "function") {
    registerRuntime.call(server, runtime.registration());
    void runtime.start();
  } else {
    console.log("[kubernetes-runtime] this Paseo has no workspace runtimes; update Paseo to run workspaces in pods");
  }

  // Pod-only mode (off by default). A refusal is the hook's error, shown to whoever made the request.
  server.before("workspace.create", async ({ request }) => {
    const { podOnly } = await getConfig();
    return podOnlyWorkspace(request as never, podOnly) as never;
  });
  server.before("agent.create", async ({ request }) => {
    const { podOnly } = await getConfig();
    podOnlyAgent(request as never, podOnly);
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
