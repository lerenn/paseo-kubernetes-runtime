import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ago, until } from "../shared/pods-view.js";
import { kubeKeep, kubeStatus } from "../shared/status.js";

type Colors = PluginScreenProps["theme"]["colors"];

/**
 * Auto-archive: what is scheduled (with a countdown), what is idle but cannot be archived (with the reason and how long it has
 * been idle), and what was done lately. Refreshes while visible.
 */
export function AutoArchiveSection({ theme }: Pick<PluginScreenProps, "theme">) {
  const load = useRpc(kubeStatus);
  const keep = useRpc(kubeKeep);
  const [state, setState] = useState<Awaited<ReturnType<typeof load>>["autoArchive"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    load({}).then(
      (s) => (setState(s.autoArchive ?? null), setError(null)),
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { colors } = theme;
  const muted = { color: colors.foregroundMuted, fontSize: 12 } as const;
  const row = { borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 14, paddingVertical: 8, gap: 2 } as const;
  const title = (text: string) => <Text style={{ color: colors.foreground, fontSize: 13, paddingHorizontal: 14, paddingTop: 10 }}>{text}</Text>;
  const keepButton = (workspaceId: string) => (
    <Pressable accessibilityRole="button" accessibilityLabel="Keep" onPress={() => void keep({ workspaceId, keep: true }).then(refresh, (e: Error) => setError(e.message))}>
      <Text style={{ color: colors.accent, fontSize: 12 }}>Keep</Text>
    </Pressable>
  );

  return (
    <SettingsSection title="Auto-archive">
      <SettingsCard>
        <Text style={{ ...muted, paddingHorizontal: 14, paddingTop: 10 }}>
          {state ? (state.enabled ? (state.dryRun ? "On, dry run: warns and logs, archives nothing." : "On: idle workspaces are archived after a warning.") : "Off.") : "Loading..."}
        </Text>
        {error ? <Text style={{ color: colors.statusDanger, fontSize: 12, paddingHorizontal: 14 }}>Status unavailable: {error}</Text> : null}
        {state?.enabled ? (
          <>
            {title(`Scheduled (${state.scheduled.length})`)}
            {state.scheduled.length === 0 ? <Text style={{ ...muted, paddingHorizontal: 14, paddingBottom: 8 }}>Nothing is waiting to be archived.</Text> : null}
            {state.scheduled.map((e) => (
              <View key={e.workspaceId} style={row}>
                <Text style={{ color: colors.foreground, fontSize: 13 }} numberOfLines={1}>{e.title}</Text>
                <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                  <Text style={muted}>{state.dryRun ? "would be archived" : "archived"} {until(e.archiveAt)} unless used</Text>
                  {keepButton(e.workspaceId)}
                </View>
              </View>
            ))}
            {title(`Blocked (${state.blocked.length})`)}
            {state.blocked.length === 0 ? <Text style={{ ...muted, paddingHorizontal: 14, paddingBottom: 8 }}>Every idle workspace is clean.</Text> : null}
            {state.blocked.map((e) => (
              <View key={e.workspaceId} style={row}>
                <Text style={{ color: colors.foreground, fontSize: 13 }} numberOfLines={1}>{e.title}</Text>
                <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{e.reason}</Text>
                <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                  <Text style={muted}>{e.idleSince ? `idle since ${ago(e.idleSince)}` : ""}</Text>
                  {keepButton(e.workspaceId)}
                </View>
              </View>
            ))}
            {title("Recent")}
            {state.recent.length === 0 ? <Text style={{ ...muted, paddingHorizontal: 14, paddingBottom: 10 }}>Nothing yet.</Text> : null}
            {state.recent.map((e) => (
              <View key={`${e.at}-${e.workspaceId}`} style={row}>
                <Text style={{ color: colors.foreground, fontSize: 13 }} numberOfLines={1}>
                  {e.title} · {e.outcome === "archived" ? "archived" : e.outcome === "would-archive" ? "would be archived (dry run)" : "archive failed"}
                </Text>
                <Text style={muted}>{[e.reason, ago(e.at), e.detail].filter(Boolean).join(" · ")}</Text>
              </View>
            ))}
          </>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
