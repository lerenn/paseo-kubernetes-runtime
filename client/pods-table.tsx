import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { PINNED_TEXT, actionsFor, ago, reaperLine } from "../shared/pods-view.js";
import { type PodRow, kubeKeep, kubePodAction, kubeReconcile, kubeStatus } from "../shared/status.js";

type Colors = PluginScreenProps["theme"]["colors"];

const LABELS = { suspend: "Suspend", resume: "Resume", restart: "Restart", delete: "Delete" } as const;

function Badge({ state, colors }: { state: PodRow["state"]; colors: Colors }) {
  const color = state === "running" ? colors.statusSuccess : state === "error" ? colors.statusDanger : state === "creating" ? colors.statusWarning : colors.foregroundMuted;
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 12 }}>{state}</Text>
    </View>
  );
}

function ArchiveBadge({ row, colors }: { row: PodRow; colors: Colors }) {
  if (!row.autoArchive) return null;
  const color = row.autoArchive === "blocked" ? colors.statusWarning : row.autoArchive === "scheduled" ? colors.statusDanger : colors.foregroundMuted;
  return (
    <View accessibilityLabel={`Auto-archive: ${row.autoArchiveText ?? row.autoArchive}`} style={{ borderWidth: 1, borderColor: color, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 12 }} numberOfLines={1}>
        {row.autoArchive === "scheduled" ? "archiving" : row.autoArchive === "blocked" ? "not archivable" : "kept"}
      </Text>
    </View>
  );
}

function Button({ label, onPress, colors, danger, disabled }: { label: string; onPress(): void; colors: Colors; danger?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{ borderWidth: 1, borderColor: danger ? colors.statusDanger : colors.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, opacity: disabled ? 0.5 : 1 }}
    >
      <Text style={{ color: danger ? colors.statusDanger : colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

interface Pending {
  row: PodRow;
  action: "suspend" | "restart" | "delete";
  /** What is running in the pod, once the server has said so. */
  busy?: string;
  archive: boolean;
}

/**
 * The pods this plugin runs, one row each, with the last orphan cleanup above. Refreshes while visible. Each row
 * is a stacked block that also reads as a table on wide layouts (title, state, agents, image and size side by side).
 */
export function PodsTable({ theme, layout, navigation }: Pick<PluginScreenProps, "theme" | "layout" | "navigation">) {
  const load = useRpc(kubeStatus);
  const act = useRpc(kubePodAction);
  const reconcile = useRpc(kubeReconcile);
  const keep = useRpc(kubeKeep);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof load>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () =>
    load({}).then(
      (s) => (setStatus(s), setError(null)),
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      load({}).then(
        (s) => !cancelled && (setStatus(s), setError(null)),
        (e: Error) => !cancelled && setError(e.message),
      );
    void tick();
    const timer = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { colors } = theme;
  const muted = { color: colors.foregroundMuted, fontSize: 12 } as const;

  const run = async (row: PodRow, action: "suspend" | "resume" | "restart" | "delete", force: boolean, archive: boolean) => {
    setWorking(row.workspaceId);
    setNotice(null);
    try {
      const r = await act({ workspaceId: row.workspaceId, action, force, archive });
      if (r.busy && !force) {
        setPending({ row, action: action as Pending["action"], busy: r.busy, archive });
        return;
      }
      setPending(null);
      setNotice(r.ok ? `${LABELS[action]}: done${r.message ? ` (${r.message})` : ""}` : `${LABELS[action]} failed: ${r.message ?? "unknown error"}`);
      await refresh();
    } catch (e) {
      setNotice(`${LABELS[action]} failed: ${(e as Error).message}`);
    } finally {
      setWorking(null);
    }
  };

  const onAction = (row: PodRow, action: "suspend" | "resume" | "restart" | "delete") => {
    if (action === "delete") setPending({ row, action, archive: false });
    else if (action === "resume") void run(row, action, false, false);
    else void run(row, action, false, false);
  };

  const wide = !layout.compact;
  return (
    <SettingsSection title="Pods">
      <SettingsCard>
        <View style={{ paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 13, flex: 1 }}>{status ? reaperLine(status.reaper) : "Loading..."}</Text>
          <Button
            label="Reconcile now"
            colors={colors}
            disabled={working === "reconcile"}
            onPress={() => {
              setWorking("reconcile");
              void reconcile({})
                .then((r) => setStatus((s) => (s ? { ...s, reaper: r.reaper } : s)))
                .catch((e: Error) => setNotice(`Reconcile failed: ${e.message}`))
                .finally(() => setWorking(null));
            }}
          />
        </View>
        {error ? <Text style={{ color: colors.statusDanger, fontSize: 13, paddingHorizontal: 14, paddingBottom: 8 }}>Status unavailable: {error}</Text> : null}
        {notice ? <Text style={{ color: colors.foregroundMuted, fontSize: 13, paddingHorizontal: 14, paddingBottom: 8 }}>{notice}</Text> : null}
        {status && status.pods.length === 0 ? <Text style={{ ...muted, paddingHorizontal: 14, paddingBottom: 12 }}>No workspaces running.</Text> : null}
        {(status?.pods ?? []).map((row) => {
          const open = navigation?.openWorkspace;
          const confirm = pending?.row.workspaceId === row.workspaceId ? pending : null;
          return (
            <View key={row.workspaceId} style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 14, paddingVertical: 10, gap: 6 }}>
              <View style={{ flexDirection: wide ? "row" : "column", gap: wide ? 12 : 6, alignItems: wide ? "center" : "flex-start" }}>
                <View style={{ flex: wide ? 3 : undefined, gap: 2 }}>
                  <Pressable
                    accessibilityRole={open ? "link" : "text"}
                    disabled={!open}
                    onPress={() => open?.({ workspaceId: row.workspaceId })}
                  >
                    <Text style={{ color: open ? colors.accent : colors.foreground, fontSize: 14 }} numberOfLines={1}>
                      {row.title}
                    </Text>
                  </Pressable>
                  <Text style={muted} numberOfLines={1} selectable>
                    {row.sandbox}
                  </Text>
                </View>
                <View style={{ flex: wide ? 2 : undefined, flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Badge state={row.state} colors={colors} />
                  <ArchiveBadge row={row} colors={colors} />
                  <Text style={muted}>{row.since ? ago(row.since) : ""}</Text>
                </View>
                <Text style={{ ...muted, flex: wide ? 3 : undefined }} numberOfLines={wide ? 2 : undefined}>
                  {row.agents.length ? row.agents.map((a) => `${a.title}${a.status === "running" ? " (running)" : ""}`).join(", ") : "no agents"}
                </Text>
                <Text style={{ ...muted, flex: wide ? 3 : undefined }} numberOfLines={1} selectable>
                  {[row.image, row.size].filter(Boolean).join(" · ")}
                </Text>
              </View>
              {row.problem ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{row.problem}</Text> : null}
              {confirm ? (
                <View style={{ gap: 8, paddingVertical: 4 }}>
                  <Text style={{ color: confirm.busy ? colors.statusWarning : colors.foreground, fontSize: 13 }}>
                    {confirm.busy
                      ? `${confirm.busy.charAt(0).toUpperCase()}${confirm.busy.slice(1)}. ${LABELS[confirm.action]} anyway?`
                      : `Delete the pod and its ${row.size ?? ""} volume? The checkout in it is lost.`}
                  </Text>
                  {confirm.action === "delete" ? (
                    <SettingsSwitch
                      label="Also archive the workspace"
                      value={confirm.archive}
                      onValueChange={(archive) => setPending({ ...confirm, archive })}
                    />
                  ) : null}
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button label={confirm.busy ? `${LABELS[confirm.action]} anyway` : "Confirm delete"} danger colors={colors} disabled={working === row.workspaceId} onPress={() => void run(row, confirm.action, Boolean(confirm.busy), confirm.archive)} />
                    <Button label="Cancel" colors={colors} onPress={() => setPending(null)} />
                  </View>
                </View>
              ) : (
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  {actionsFor(row.state, row.workspaceId).map((a) => (
                    <Button key={a} label={LABELS[a]} danger={a === "delete"} colors={colors} disabled={working === row.workspaceId} onPress={() => onAction(row, a)} />
                  ))}
                  {!row.workspaceId.startsWith("warm:") ? (
                    <Button
                      label={row.autoArchiveText === PINNED_TEXT ? "Unkeep" : "Keep"}
                      colors={colors}
                      disabled={working === row.workspaceId}
                      onPress={() => {
                        setWorking(row.workspaceId);
                        void keep({ workspaceId: row.workspaceId, keep: row.autoArchiveText !== PINNED_TEXT })
                          .then((r) => setNotice(r.ok ? null : `Keep failed: ${r.message ?? "unknown error"}`))
                          .catch((e: Error) => setNotice(`Keep failed: ${e.message}`))
                          .then(refresh)
                          .finally(() => setWorking(null));
                      }}
                    />
                  ) : null}
                </View>
              )}
            </View>
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}
