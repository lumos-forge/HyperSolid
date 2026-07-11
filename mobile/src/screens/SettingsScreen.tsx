import React, { useMemo, useState, useEffect } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Alert, Linking } from "react-native";
import appJson from "../../app.json";
import * as Clipboard from "expo-clipboard";
import * as LocalAuthentication from "expo-local-authentication";
import { useToastStore } from "../state/toastStore";
import { useTheme } from "../theme/useTheme";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore, type Network } from "../state/envStore";
import { useThemeStore } from "../state/themeStore";
import { useLocaleStore } from "../state/localeStore";
import { useLockPrefsStore, AUTO_LOCK_OPTIONS } from "../state/lockPrefsStore";
import { usePushPrefsStore } from "../state/pushPrefsStore";
import { useRuntimeConfigStore } from "../state/runtimeConfigStore";
import { StrategyApi } from "../services/strategyApi";
import { openStrategySession } from "../wallet/walletSession";
import { applyPushPreference, unregisterForSignOut } from "../services/pushToggle";
import { fetchPushCategoryPrefs, setPushCategoryPrefs, type PushCategoryPrefs } from "../services/pushCategoryPrefs";
import type { LocalWalletService } from "../wallet/localWallet";
import { useT } from "../i18n/useT";
import type { Locale } from "../i18n/messages";
import { WalletManager } from "../wallet/walletManager";
import { SecureStoreKeyStore } from "../wallet/secureKeyStore";
import { PinStore } from "../wallet/pinStore";
import { BiometricGate } from "../wallet/biometricGate";
import { Icon, type IconName } from "../components/Icon";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { SurfaceCard } from "../components/SurfaceCard";
import { SectionLabel } from "../components/SectionLabel";
import { SheetSelect } from "../components/SheetSelect";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";
import type { ThemeName, ThemeTokens } from "../theme/tokens";

export interface SettingsScreenDeps {
  manager?: WalletManager;
  pinStore?: PinStore;
  gate?: BiometricGate;
}

const THEME_ORDER: ThemeName[] = ["electrum", "daylight", "oscilloscope"];
const THEME_LABEL: Record<ThemeName, string> = { electrum: "Electrum", daylight: "Daylight", oscilloscope: "Oscilloscope" };
const LOCALE_LABEL: Record<Locale, string> = { en: "English", zh: "中文" };
const APP_VERSION = (appJson as { expo?: { version?: string } }).expo?.version ?? "1.0.0";
const PRIVACY_URL = "https://hypersolid.app/privacy";
const TERMS_URL = "https://hypersolid.app/terms";

type Picker = "none" | "network" | "theme" | "locale" | "autolock";

/** Wallet settings sub-page (Wallet › gear): grouped app prefs + security + backup + sign-out. */
export function SettingsScreen({ deps }: { deps?: SettingsScreenDeps } = {}) {
  const theme = useTheme();
  const t = useT();
  const mode = useWalletStore((s) => s.mode);
  const reset = useWalletStore((s) => s.reset);
  const network = useEnvStore((s) => s.network);
  const setNetwork = useEnvStore((s) => s.setNetwork);
  const themeName = useThemeStore((s) => s.name);
  const setTheme = useThemeStore((s) => s.setTheme);
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const biometricEnabled = useLockPrefsStore((s) => s.biometricEnabled);
  const setBiometricEnabled = useLockPrefsStore((s) => s.setBiometricEnabled);
  const autoLockMinutes = useLockPrefsStore((s) => s.autoLockMinutes);
  const setAutoLockMinutes = useLockPrefsStore((s) => s.setAutoLockMinutes);
  const wallet = useWalletStore((s) => s.wallet);
  const address = useWalletStore((s) => s.address);
  const pushEnabled = usePushPrefsStore((s) => s.enabled);
  const pushToken = usePushPrefsStore((s) => s.token);
  const setPushEnabled = usePushPrefsStore((s) => s.setEnabled);
  const setPushToken = usePushPrefsStore((s) => s.setToken);
  const baseUrl = useRuntimeConfigStore((s) => s.strategyApiBaseUrl);

  const manager = useMemo(() => deps?.manager ?? new WalletManager(new SecureStoreKeyStore()), [deps]);
  const pinStore = useMemo(() => deps?.pinStore ?? new PinStore(), [deps]);
  const gate = useMemo(() => deps?.gate ?? new BiometricGate(LocalAuthentication), [deps]);

  const [picker, setPicker] = useState<Picker>("none");
  const [sheet, setSheet] = useState<"none" | "changepin">("none");
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{ kind: "mnemonic" | "key"; value: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [categoryPrefs, setCategoryPrefs] = useState<PushCategoryPrefs | null>(null);

  const autoLockLabel = (m: number) => (m === 0 ? t("account.autoLockImmediate") : t("account.autoLockMin", { min: m }));

  async function onToggleBiometric() {
    try {
      if (!biometricEnabled) {
        const avail = await gate.isAvailable();
        if (!avail.hasHardware || !avail.isEnrolled) {
          Alert.alert(t("account.faceIdUnavailable"), t("account.faceIdUnavailableBody"));
          return;
        }
      }
      await setBiometricEnabled(!biometricEnabled);
    } catch {
      Alert.alert(t("account.faceIdUnavailable"), t("account.faceIdUnavailableBody"));
    }
  }

  const makeAuthedApi = async () => {
    const local = wallet as Partial<LocalWalletService> | null;
    if (mode !== "local" || !local || typeof local.getViemAccount !== "function" || !baseUrl || !address) return null;
    const tok = await openStrategySession(new StrategyApi(baseUrl, null), local.getViemAccount(), address);
    return new StrategyApi(baseUrl, tok);
  };

  async function onToggleNotifications() {
    const { expoPushEnv } = await import("../services/pushEnv");
    const r = await applyPushPreference(!pushEnabled, { env: expoPushEnv(), makeAuthedApi, prevToken: pushToken });
    if (!pushEnabled) {
      if (r.ok) {
        await setPushEnabled(true);
        if (r.token) await setPushToken(r.token);
        useToastStore.getState().show(t("settings.pushEnabled"), "success");
      } else {
        const key =
          r.reason === "no_session" ? "settings.pushNoSession" :
          r.reason === "permission_denied" ? "settings.pushPermission" :
          "settings.pushFailed";
        useToastStore.getState().show(t(key), "error");
      }
    } else {
      await setPushEnabled(false);
      await setPushToken(null);
      useToastStore.getState().show(t("settings.pushDisabled"), "success");
    }
  }

  useEffect(() => {
    let alive = true;
    if (!pushEnabled) {
      setCategoryPrefs(null);
      return;
    }
    void fetchPushCategoryPrefs(makeAuthedApi).then((p) => {
      if (alive) setCategoryPrefs(p);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushEnabled]);

  async function onToggleCategory(cat: "fills" | "alerts") {
    if (!categoryPrefs) return;
    const next = !categoryPrefs[cat];
    setCategoryPrefs({ ...categoryPrefs, [cat]: next });
    const ok = await setPushCategoryPrefs(makeAuthedApi, { [cat]: next });
    if (!ok) {
      setCategoryPrefs((p) => (p ? { ...p, [cat]: !next } : p));
      useToastStore.getState().show(t("settings.pushPrefsFailed"), "error");
    }
  }

  function openChangePin() {
    setOldPin("");
    setNewPin("");
    setConfirmPin("");
    setSheet((s) => (s === "changepin" ? "none" : "changepin"));
  }
  async function onConfirmChangePin() {
    if (newPin.length < 6 || newPin !== confirmPin) {
      Alert.alert(t("account.changePinMismatch"));
      return;
    }
    setPinBusy(true);
    try {
      const res = await pinStore.change(oldPin, newPin);
      if (res.ok) {
        useToastStore.getState().show(t("account.changePinDone"), "success");
        setSheet("none");
      } else Alert.alert(t("account.changePinWrong"));
    } finally {
      setPinBusy(false);
    }
  }

  async function onExportBackup() {
    try {
      const mnemonic = await manager.exportMnemonic();
      if (!mnemonic) return Alert.alert(t("account.exportFailed"), t("account.exportFailedBody"));
      setCopied(false);
      setRevealedSecret({ kind: "mnemonic", value: mnemonic });
    } catch {
      Alert.alert(t("account.exportFailed"), t("account.exportFailedBody"));
    }
  }
  async function onExportKey() {
    try {
      const key = await manager.exportPrivateKey();
      if (!key) return Alert.alert(t("account.exportFailed"), t("account.exportFailedBody"));
      setCopied(false);
      setRevealedSecret({ kind: "key", value: key });
    } catch {
      Alert.alert(t("account.exportFailed"), t("account.exportFailedBody"));
    }
  }
  async function onCopySecret() {
    if (!revealedSecret) return;
    try {
      await Clipboard.setStringAsync(revealedSecret.value);
      setCopied(true);
    } catch {
      /* clipboard unavailable — non-fatal, the secret is still shown on screen to copy manually */
    }
  }
  async function onSignOut() {
    Alert.alert(t("account.signOutTitle"), t("account.signOutConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("account.signOutSwitch"),
        style: "destructive",
        onPress: async () => {
          await unregisterForSignOut(makeAuthedApi, pushToken);
          await setPushEnabled(false);
          await setPushToken(null);
          try {
            await manager.signOut();
            reset();
          } catch {
            reset();
          }
        },
      },
    ]);
  }

  return (
    <ScreenScaffold theme={theme} heading={t("settings.title")}>
      {sheet === "changepin" ? (
        <SurfaceCard theme={theme} style={styles.card}>
          <Text style={[styles.sheetTitle, { color: theme.text }]}>{t("account.changePinTitle")}</Text>
          <PinField theme={theme} label={t("account.changePinOld")} value={oldPin} onChange={setOldPin} testID="changepin-old" />
          <PinField theme={theme} label={t("account.changePinNew")} value={newPin} onChange={setNewPin} testID="changepin-new" />
          <PinField theme={theme} label={t("account.changePinConfirm")} value={confirmPin} onChange={setConfirmPin} testID="changepin-confirm" />
          <View style={styles.btnRow}>
            <Pressable disabled={pinBusy} onPress={onConfirmChangePin} accessibilityRole="button" testID="changepin-confirm-btn" style={[styles.btn, { backgroundColor: theme.brand }]}>
              <Text style={[styles.btnText, { color: theme.bg }]}>{t("account.changePinSave")}</Text>
            </Pressable>
            <Pressable onPress={() => setSheet("none")} accessibilityRole="button" style={[styles.btn, styles.btnOutline, { borderColor: theme.lineStrong }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>{t("account.close")}</Text>
            </Pressable>
          </View>
        </SurfaceCard>
      ) : null}

      {revealedSecret ? (
        <SurfaceCard theme={theme} style={[styles.card, { borderColor: theme.warn }]}>
          <View style={styles.warnRow}>
            <Icon name="alert" color={theme.warn} size={16} />
            <Text style={[styles.warn, { color: theme.warn }]}>{revealedSecret.kind === "key" ? t("account.exportKeyWarn") : t("account.backupWarn")}</Text>
          </View>
          <Text style={[styles.secret, { color: theme.text }]} testID="revealed-secret">{revealedSecret.value}</Text>
          <View style={styles.btnRow}>
            <Pressable onPress={onCopySecret} accessibilityRole="button" testID="copy-secret" style={[styles.btn, styles.btnOutline, { borderColor: theme.lineStrong }]}>
              <Text style={[styles.btnText, { color: theme.text }]}>{copied ? t("account.copied") : t("account.copyAddress")}</Text>
            </Pressable>
            <Pressable onPress={() => setRevealedSecret(null)} accessibilityRole="button" style={[styles.btn, { backgroundColor: theme.brand }]}>
              <Text style={[styles.btnText, { color: theme.bg }]}>{t("account.backedUp")}</Text>
            </Pressable>
          </View>
        </SurfaceCard>
      ) : null}

      <SectionLabel theme={theme}>{t("settings.prefs")}</SectionLabel>
      <SettingRow theme={theme} icon="swap" name={t("account.network")} value={network} onPress={() => setPicker("network")} />
      <SettingRow theme={theme} icon="grid" name={t("account.theme")} value={THEME_LABEL[themeName]} onPress={() => setPicker("theme")} />
      <SettingRow theme={theme} icon="repeat" name={t("settings.language")} value={LOCALE_LABEL[locale]} onPress={() => setPicker("locale")} />

      {mode === "local" ? (
        <>
          <SectionLabel theme={theme}>{t("settings.security")}</SectionLabel>
          <SettingRow theme={theme} icon="shield" name={t("account.security")} value={biometricEnabled ? t("account.faceIdOn") : t("account.faceIdOff")} onPress={onToggleBiometric} />
          <SettingRow theme={theme} icon="alert" name={t("settings.notifications")} value={pushEnabled ? t("settings.notificationsOn") : t("settings.notificationsOff")} onPress={onToggleNotifications} />
          {pushEnabled && categoryPrefs && (
            <>
              <SettingRow theme={theme} icon="alert" name={t("settings.notifyFills")} value={categoryPrefs.fills ? t("settings.notificationsOn") : t("settings.notificationsOff")} onPress={() => onToggleCategory("fills")} />
              <SettingRow theme={theme} icon="alert" name={t("settings.notifyAlerts")} value={categoryPrefs.alerts ? t("settings.notificationsOn") : t("settings.notificationsOff")} onPress={() => onToggleCategory("alerts")} />
            </>
          )}
          <SettingRow theme={theme} icon="lock" name={t("account.autoLock")} value={autoLockLabel(autoLockMinutes)} onPress={() => setPicker("autolock")} />
          <SettingRow theme={theme} icon="key" name={t("account.changePin")} value="" onPress={openChangePin} />

          <SectionLabel theme={theme}>{t("settings.backup")}</SectionLabel>
          <SettingRow theme={theme} icon="key" name={t("account.exportBackup")} value="" danger onPress={onExportBackup} />
          <SettingRow theme={theme} icon="key" name={t("account.exportKey")} value="" danger onPress={onExportKey} />
        </>
      ) : null}

      <SectionLabel theme={theme}>{t("settings.about")}</SectionLabel>
      <SettingRow theme={theme} icon="bolt" name={t("settings.version")} value={APP_VERSION} onPress={() => {}} />
      <SettingRow theme={theme} icon="shield" name={t("settings.privacy")} value="" onPress={() => void Linking.openURL(PRIVACY_URL)} />
      <SettingRow theme={theme} icon="grid" name={t("settings.terms")} value="" onPress={() => void Linking.openURL(TERMS_URL)} />

      <SectionLabel theme={theme}>{t("settings.danger")}</SectionLabel>
      <Pressable onPress={onSignOut} accessibilityRole="button" style={[styles.signOut, { borderColor: theme.down }]}>
        <Text style={[styles.signOutText, { color: theme.down }]}>{t("account.signOutSwitch")}</Text>
      </Pressable>

      <SheetSelect<Network>
        visible={picker === "network"}
        onClose={() => setPicker("none")}
        title={t("settings.networkTitle")}
        value={network}
        onSelect={(v) => { setNetwork(v); setPicker("none"); }}
        sections={[{ options: [{ value: "mainnet", label: "mainnet" }, { value: "testnet", label: "testnet" }] }]}
        theme={theme}
        testIDPrefix="network"
      />
      <SheetSelect<ThemeName>
        visible={picker === "theme"}
        onClose={() => setPicker("none")}
        title={t("settings.themeTitle")}
        value={themeName}
        onSelect={(v) => { setTheme(v); setPicker("none"); }}
        sections={[{ options: THEME_ORDER.map((th) => ({ value: th, label: THEME_LABEL[th] })) }]}
        theme={theme}
        testIDPrefix="theme"
      />
      <SheetSelect<Locale>
        visible={picker === "locale"}
        onClose={() => setPicker("none")}
        title={t("settings.langTitle")}
        value={locale}
        onSelect={(v) => { setLocale(v); setPicker("none"); }}
        sections={[{ options: [{ value: "en", label: "English" }, { value: "zh", label: "中文" }] }]}
        theme={theme}
        testIDPrefix="locale"
      />
      <SheetSelect<string>
        visible={picker === "autolock"}
        onClose={() => setPicker("none")}
        title={t("settings.autoLockTitle")}
        value={String(autoLockMinutes)}
        onSelect={(v) => { void setAutoLockMinutes(Number(v)); setPicker("none"); }}
        sections={[{ options: AUTO_LOCK_OPTIONS.map((m) => ({ value: String(m), label: autoLockLabel(m) })) }]}
        theme={theme}
        testIDPrefix="autolock"
      />
    </ScreenScaffold>
  );
}

function PinField({ theme, label, value, onChange, testID }: { theme: ThemeTokens; label: string; value: string; onChange: (v: string) => void; testID: string }) {
  return (
    <>
      <Text style={[styles.fieldLabel, { color: theme.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="••••••"
        placeholderTextColor={theme.faint}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={12}
        testID={testID}
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
    </>
  );
}

function SettingRow({ theme, icon, name, value, onPress, danger }: { theme: ThemeTokens; icon: IconName; name: string; value: string; onPress: () => void; danger?: boolean }) {
  const accent = danger ? theme.down : theme.brand;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={[styles.settingRow, { borderBottomColor: theme.line }]}>
      <View style={[styles.settingIcon, { backgroundColor: withAlpha(accent, 0.12) }]}>
        <Icon name={icon} color={accent} size={16} />
      </View>
      <Text style={[styles.settingName, { color: danger ? theme.down : theme.text }]}>{name}</Text>
      <Text style={[styles.settingValue, { color: theme.muted }]}>{value}</Text>
      <Icon name="chevronRight" color={theme.faint} size={14} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, marginBottom: 12 },
  sheetTitle: { fontFamily: fonts.display.bold, fontSize: 14, marginBottom: 8 },
  fieldLabel: { fontFamily: fonts.body.regular, fontSize: 11, marginBottom: 4, marginTop: 10 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontFamily: fonts.body.regular, fontSize: 13 },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  btnOutline: { borderWidth: 1, backgroundColor: "transparent" },
  btnText: { fontFamily: fonts.display.bold, fontSize: 13, letterSpacing: 0.3 },
  warnRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 8 },
  warn: { flex: 1, fontFamily: fonts.body.semibold, fontSize: 12, lineHeight: 17 },
  secret: { fontFamily: fonts.mono.regular, fontSize: 15, lineHeight: 24 },
  settingRow: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 13, borderBottomWidth: 1 },
  settingIcon: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  settingName: { flex: 1, fontFamily: fonts.body.semibold, fontSize: 13 },
  settingValue: { fontFamily: fonts.mono.medium, fontSize: 12 },
  signOut: { paddingVertical: 13, borderRadius: 12, alignItems: "center", borderWidth: 1, marginTop: 8 },
  signOutText: { fontFamily: fonts.body.semibold, fontSize: 14 },
});
