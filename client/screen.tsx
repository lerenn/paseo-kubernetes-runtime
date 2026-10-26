import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import * as hostUi from "@getpaseo/plugin/client/ui";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { CREDENTIAL_KEYS, type CredentialKey, credentialsRemove, credentialsSet, credentialsStatus } from "../shared/credentials.js";
import { type KubernetesRuntimeConfig, kubeSettings } from "../shared/settings.js";
import { PodsTable } from "./pods-table.js";

/** Optional host components; older apps may not provide them, so never render an undefined element. */
const optionalUi = hostUi as unknown as Partial<{
  ExternalLink: typeof hostUi.ExternalLink;
  copyText(text: string): Promise<void>;
}>;

function Link({ href, color, children }: { href: string; color: string; children: string }) {
  const HostLink = optionalUi.ExternalLink;
  if (HostLink) return <HostLink href={href}>{children}</HostLink>;
  return (
    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(href).catch(() => undefined)}>
      <Text style={{ color, textDecorationLine: "underline" }}>{children}</Text>
    </Pressable>
  );
}

/** Plain-View status marker: filled check when set, empty ring when not, dashed when unknown. */
function StatusMark({ state, theme }: { state: boolean | null; theme: PluginScreenProps["theme"] }) {
  const { colors } = theme;
  const color = state ? colors.statusSuccess : colors.foregroundMuted;
  return (
    <View
      accessible
      accessibilityLabel={state === null ? "unknown" : state ? "set" : "not set"}
      style={{
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 1.5,
        borderColor: color,
        borderStyle: state === null ? "dashed" : "solid",
        backgroundColor: state ? colors.statusSuccess : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {state ? <Text style={{ color: colors.surface0, fontSize: 10, lineHeight: 12 }}>✓</Text> : null}
    </View>
  );
}

const CREDENTIAL_LABELS: Record<CredentialKey, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: "Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN)",
};

export const parseSelector = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(",")
      .map((pair) => pair.split("=").map((part) => part.trim()))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== "" && kv[1] !== ""),
  );

const CREDENTIAL_HINTS: Record<CredentialKey, { text: string; link?: { href: string; label: string }; command?: string }> = {
  CLAUDE_CODE_OAUTH_TOKEN: {
    text: "Run on your machine, then paste the token:",
    command: "claude setup-token",
  },
};

const intOr = (text: string, fallback: number) => {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : fallback;
};

function Credential({
  name,
  theme,
  isSet,
  statusError,
  onSaved,
}: {
  name: CredentialKey;
  theme: PluginScreenProps["theme"];
  isSet: boolean | null;
  statusError: string | null;
  onSaved(set: Record<string, boolean>): void;
}) {
  const setCredential = useRpc(credentialsSet);
  const removeCredential = useRpc(credentialsRemove);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await setCredential({ key: name, value: draft });
      onSaved(result.set);
      setDraft("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [setCredential, name, draft]);

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved((await removeCredential({ key: name })).set);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [removeCredential, name, onSaved]);

  const { colors } = theme;
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 12, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StatusMark state={isSet} theme={theme} />
        <Text style={{ color: colors.foreground, flex: 1 }}>{CREDENTIAL_LABELS[name]}</Text>
        {isSet ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${CREDENTIAL_LABELS[name]}`}
            disabled={busy}
            onPress={() => void remove()}
          >
            <Text style={{ color: colors.statusDanger, fontSize: 12 }}>Remove</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 2, paddingLeft: 24 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{CREDENTIAL_HINTS[name].text}</Text>
        {CREDENTIAL_HINTS[name].command ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text selectable style={{ color: colors.foreground, fontFamily: "monospace", fontSize: 12 }}>
                {CREDENTIAL_HINTS[name].command}
              </Text>
            </View>
            {optionalUi.copyText ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Copy ${CREDENTIAL_HINTS[name].command}`}
                onPress={() => void optionalUi.copyText!(CREDENTIAL_HINTS[name].command!).catch(() => undefined)}
              >
                <Text style={{ color: colors.accent, fontSize: 12 }}>Copy</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {CREDENTIAL_HINTS[name].link ? (
          <Link href={CREDENTIAL_HINTS[name].link!.href} color={colors.accent}>
            {CREDENTIAL_HINTS[name].link!.label}
          </Link>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          placeholder={isSet ? "New value" : "Value"}
          placeholderTextColor={colors.foregroundMuted}
          accessibilityLabel={`${CREDENTIAL_LABELS[name]} value`}
          style={{
            flex: 1,
            marginLeft: 24,
            color: colors.foreground,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 5,
          }}
        />
        {draft.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Save ${CREDENTIAL_LABELS[name]}`}
            disabled={busy}
            onPress={() => void save()}
            style={{ backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, opacity: busy ? 0.6 : 1 }}
          >
            <Text style={{ color: colors.accentForeground }}>{busy ? "Saving..." : "Save"}</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={{ color: colors.statusDanger, paddingLeft: 24 }}>{error}</Text> : null}
      {statusError ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, paddingLeft: 24 }}>Status unavailable, retrying: {statusError}</Text> : null}
    </View>
  );
}

function CredentialsSection({ theme }: { theme: PluginScreenProps["theme"] }) {
  const status = useRpc(credentialsStatus);
  const [open, setOpen] = useState(false);
  const [set, setSet] = useState<Record<string, boolean> | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    // The plugin can be restarting (update, daemon restart); retry instead of staying unknown.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      status({}).then(
        (r) => {
          if (cancelled) return;
          setSet(r.set);
          setStatusError(null);
        },
        (e: Error) => {
          if (cancelled) return;
          setStatusError(e.message);
          timer = setTimeout(() => load(attempt + 1), Math.min(30_000, 2_000 * 2 ** attempt));
        },
      );
    };
    load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { colors } = theme;
  const total = CREDENTIAL_KEYS.length;
  const count = set ? CREDENTIAL_KEYS.filter((k) => set[k] === true).length : null;
  const missing = count !== null && count < total;
  const summary = count === null ? "status unavailable" : missing ? `${count}/${total} set, ${total - count} missing` : `${count}/${total} set`;
  return (
    <>
      <SettingsCard>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`Credentials, ${summary}`}
          onPress={() => setOpen(!open)}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12 }}
        >
          <Text style={{ color: colors.foregroundMuted, width: 12 }}>{open ? "▾" : "▸"}</Text>
          <Text style={{ color: missing ? colors.statusWarning : colors.foreground, flex: 1 }}>
            {missing ? "⚠ " : ""}Credentials · {summary}
          </Text>
        </Pressable>
        {open
          ? CREDENTIAL_KEYS.map((key) => (
              <Credential
                key={key}
                name={key}
                theme={theme}
                isSet={set ? set[key] === true : null}
                statusError={statusError}
                onSaved={setSet}
              />
            ))
          : null}
      </SettingsCard>
    </>
  );
}

export function KubernetesRuntimeScreen({ theme, layout, navigation }: PluginScreenProps) {
  const settings = useSettings(kubeSettings);
  const [draft, setDraft] = useState<KubernetesRuntimeConfig | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (settings.status === "ready" && draft === null) {
      setDraft(settings.values);
      setRevision(settings.revision);
    }
  }, [settings, draft]);

  const pad = layout.compact ? 16 : 24;
  const message = (text: string, color: string) => (
    <View style={{ flex: 1, padding: pad, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color }}>{text}</Text>
    </View>
  );
  if (settings.status === "loading") return message("Loading...", theme.colors.foregroundMuted);
  if (settings.status === "error" || settings.status === "invalid") {
    return message(`Settings unavailable: ${settings.error}`, theme.colors.foreground);
  }
  if (!draft || !revision) return message("Loading...", theme.colors.foregroundMuted);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.values);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>Runs the workspaces you start with the Pod location in their own pods.</Text>

      <SettingsSection title="Cluster">
        <SettingsCard>
          <SettingsInput label="Namespace" initialValue={draft.namespace} onChangeText={(namespace) => setDraft({ ...draft, namespace: namespace.trim() })} />
          <SettingsInput label="Image" initialValue={draft.image} onChangeText={(image) => setDraft({ ...draft, image: image.trim() })} />
          <SettingsAction label="Advanced" actionLabel={advanced ? "Hide" : "Show"} onPress={() => setAdvanced(!advanced)} />
          {advanced ? (
            <>
              <SettingsInput label="kubectl context" hint="Empty uses the current context." initialValue={draft.context ?? ""} onChangeText={(t) => setDraft({ ...draft, context: t.trim() || undefined })} />
              <SettingsInput
                label="Node selector"
                hint="label=value, comma separated."
                initialValue={Object.entries(draft.nodeSelector).map(([k, v]) => `${k}=${v}`).join(",")}
                onChangeText={(t) => setDraft({ ...draft, nodeSelector: parseSelector(t) })}
              />
              <SettingsInput
                label="Tolerated taint keys"
                hint="Comma separated."
                initialValue={draft.tolerationKeys.join(",")}
                onChangeText={(t) => setDraft({ ...draft, tolerationKeys: t.split(",").map((k) => k.trim()).filter(Boolean) })}
              />
              <SettingsSelect
                label="Workspace storage"
                hint="Persistent keeps the clone across pod restarts."
                value={draft.storage.mode}
                options={[
                  { label: "Persistent", value: "persistent" },
                  { label: "Ephemeral", value: "ephemeral" },
                ]}
                onValueChange={(mode) => setDraft({ ...draft, storage: { ...draft.storage, mode } })}
              />
              {draft.storage.mode === "persistent" ? (
                <>
                  <SettingsInput
                    label="Storage size"
                    hint="A Kubernetes quantity, e.g. 10Gi."
                    initialValue={draft.storage.size}
                    onChangeText={(t) => {
                      if (/^[1-9][0-9]*(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.test(t.trim())) {
                        setDraft({ ...draft, storage: { ...draft.storage, size: t.trim() } });
                      }
                    }}
                  />
                  <SettingsInput
                    label="Storage class"
                    hint="Empty uses the cluster's default."
                    initialValue={draft.storage.storageClassName ?? ""}
                    onChangeText={(t) => setDraft({ ...draft, storage: { ...draft.storage, storageClassName: t.trim() || undefined } })}
                  />
                </>
              ) : null}
              <SettingsInput
                label="Suspend idle workspaces after (minutes)"
                hint="Deletes the pod of a workspace whose agents are all idle and keeps its files; the next message resumes it. 0 = never."
                initialValue={String(draft.podIdleMinutes)}
                onChangeText={(t) => {
                  const n = Number.parseInt(t, 10);
                  if (Number.isFinite(n) && n >= 0) setDraft({ ...draft, podIdleMinutes: n });
                }}
              />
              <SettingsSwitch
                label="Other repositories"
                hint="Lets pods clone, fetch and push branches to other repositories through the daemon, with its git credentials."
                value={draft.otherRepos.enabled}
                onValueChange={(enabled) => setDraft({ ...draft, otherRepos: { ...draft.otherRepos, enabled } })}
              />
              {draft.otherRepos.enabled ? (
                <SettingsInput
                  label="Allowed repositories"
                  hint="Comma-separated owner/* or owner/repo. Empty allows every repository the daemon can reach."
                  initialValue={draft.otherRepos.allow.join(",")}
                  onChangeText={(t) => setDraft({ ...draft, otherRepos: { ...draft.otherRepos, allow: t.split(",").map((k) => k.trim()).filter(Boolean) } })}
                />
              ) : null}
              <SettingsSwitch
                label="Remove unlabelled leftovers"
                hint="Also delete this plugin's old sandboxes that match no agent. Turn off if daemons share a namespace."
                value={draft.sweepUnlabelled}
                onValueChange={(sweepUnlabelled) => setDraft({ ...draft, sweepUnlabelled })}
              />
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <PodsTable theme={theme} layout={layout} navigation={navigation} />

      <CredentialsSection theme={theme} />

      <SettingsCard>
        <SettingsAction
          label={settings.saveError ? "Not saved" : dirty ? "Unsaved changes" : "Saved"}
          hint={settings.saveError ?? undefined}
          actionLabel={settings.saving ? "Saving..." : "Save"}
          disabled={!dirty || settings.saving}
          onPress={() => {
            void settings.save(draft, revision).then((ok) => {
              if (ok) setDraft(null);
            });
          }}
        />
      </SettingsCard>
    </ScrollView>
  );
}
