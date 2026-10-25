import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { KubernetesRuntimeScreen } from "./client/screen.js";
import { contributePodLocation } from "./client/pod-location.js";

function KubernetesRuntimeItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ShipWheel"
      active={currentScreen?.screenId === "settings"}
      onPress={() => openScreen({ screenId: "settings" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    contributePodLocation(client),
    client.addScreen({ id: "settings", title: "Kubernetes Runtime", Component: KubernetesRuntimeScreen }),
    client.addSidebarHeaderItem({ id: "kubernetes-runtime", title: "Kubernetes Runtime", Component: KubernetesRuntimeItem }),
  ];
  return () => removers.forEach((remove) => remove());
}
