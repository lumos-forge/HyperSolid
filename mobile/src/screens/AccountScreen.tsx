import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Alert } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { WalletManager } from "../wallet/walletManager";
import { SecureStoreKeyStore } from "../wallet/secureKeyStore";
import { isValidAddress } from "../hooks/useViewOnlyPortfolio";
import { Icon } from "../components/Icon";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { Pill } from "../components/Pill";
import { SectionLabel } from "../components/SectionLabel";

export function AccountScreen() {
  const theme = useTheme();
  const mode = useWalletStore((s) => s.mode);
  const address = useWalletStore((s) => s.address);
  const setLocalWallet = useWalletStore((s) => s.setLocalWallet);
  const setViewOnly = useWalletStore((s) => s.setViewOnly);
  const reset = useWalletStore((s) => s.reset);
  const network = useEnvStore((s) => s.network);
  const toggleNetwork = useEnvStore((s) => s.toggleNetwork);
  const manager = useMemo(() => new WalletManager(new SecureStoreKeyStore()), []);

  const [busy, setBusy] = useState(false);
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [addrInput, setAddrInput] = useState("");
  const [newMnemonic, setNewMnemonic] = useState<string | null>(null);

  async function onCreate() {
    setBusy(true);
    try {
      const { mnemonic, wallet } = await manager.createWallet();
      setNewMnemonic(mnemonic);
      setLocalWallet(wallet);
    } catch (e) {
      Alert.alert("创建失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRestore() {
    setBusy(true);
    try {
      const wallet = await manager.restoreWallet(mnemonicInput);
      setLocalWallet(wallet);
      setMnemonicInput("");
    } catch {
      Alert.alert("恢复失败", "助记词无效");
    } finally {
      setBusy(false);
    }
  }

  function onViewOnly() {
    if (!isValidAddress(addrInput)) {
      Alert.alert("地址无效", "需 0x + 40 位十六进制");
      return;
    }
    setViewOnly(addrInput.trim());
  }

  async function onSignOut() {
    await manager.signOut();
    reset();
    setNewMnemonic(null);
  }

  const networkPill = <Pill theme={theme} label={`◷ ${network.toUpperCase()}`} />;

  if (mode !== "none") {
    return (
      <ScreenScaffold theme={theme} statusTitle="HYPERSOLID" pill={networkPill} heading="钱包 Account">
        <View style={[styles.card, { borderColor: theme.line }]}>
          <View style={styles.labelRow}>
            <Icon name={mode === "local" ? "lock" : "eye"} color={theme.muted} size={14} />
            <Text style={[styles.label, { color: theme.muted }]}>
              {mode === "local" ? "本地钱包（非托管）" : "仅查看"}
            </Text>
          </View>
          <Text style={[styles.addr, { color: theme.text }]} numberOfLines={1} ellipsizeMode="middle">
            {address}
          </Text>
        </View>

        {newMnemonic ? (
          <View style={[styles.card, { borderColor: theme.brand }]}>
            <View style={styles.warnRow}>
              <Icon name="alert" color={theme.brand} size={16} />
              <Text style={[styles.warn, { color: theme.brand }]}>
                请立即备份助记词（仅显示一次，禁止截图）
              </Text>
            </View>
            <Text style={[styles.mnemonic, { color: theme.text }]}>{newMnemonic}</Text>
            <Pressable onPress={() => setNewMnemonic(null)} accessibilityRole="button">
              <Text style={[styles.link, { color: theme.muted }]}>我已安全备份</Text>
            </Pressable>
          </View>
        ) : null}

        <Pressable onPress={toggleNetwork} accessibilityRole="button" style={[styles.settingRow, { borderColor: theme.line }]}>
          <Text style={[styles.label, { color: theme.muted }]}>网络</Text>
          <View style={styles.valueRow}>
            <Text style={[styles.value, { color: theme.text }]}>{network}</Text>
            <Icon name="swap" color={theme.muted} size={16} />
          </View>
        </Pressable>

        <Pressable onPress={onSignOut} accessibilityRole="button" style={[styles.btnOutline, { borderColor: theme.down }]}>
          <Text style={[styles.btnOutlineText, { color: theme.down }]}>退出 / 切换钱包</Text>
        </Pressable>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold theme={theme} statusTitle="HYPERSOLID" pill={networkPill} heading="欢迎使用 HyperSolid">
      <Text style={[styles.subtitle, { color: theme.muted }]}>选择一种方式开始（非托管，私钥永不离开设备）</Text>

      <Pressable disabled={busy} onPress={onCreate} accessibilityRole="button" style={[styles.btn, { backgroundColor: theme.brand }]}>
        <View style={styles.btnInner}>
          <Icon name="star" active color={theme.bg} size={18} />
          <Text style={[styles.btnText, { color: theme.bg }]}>创建本地钱包（推荐）</Text>
        </View>
      </Pressable>

      <SectionLabel theme={theme}>用助记词恢复</SectionLabel>
      <TextInput
        value={mnemonicInput}
        onChangeText={setMnemonicInput}
        placeholder="输入 12 词助记词"
        placeholderTextColor={theme.muted}
        autoCapitalize="none"
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
      <Pressable disabled={busy} onPress={onRestore} accessibilityRole="button" style={[styles.btnOutline, { borderColor: theme.brand }]}>
        <View style={styles.btnInner}>
          <Icon name="key" color={theme.brand} size={18} />
          <Text style={[styles.btnOutlineText, { color: theme.brand }]}>恢复钱包</Text>
        </View>
      </Pressable>

      <SectionLabel theme={theme}>仅查看（零私钥）</SectionLabel>
      <TextInput
        value={addrInput}
        onChangeText={setAddrInput}
        placeholder="0x… 地址"
        placeholderTextColor={theme.muted}
        autoCapitalize="none"
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
      <Pressable onPress={onViewOnly} accessibilityRole="button" style={[styles.btnOutline, { borderColor: theme.line }]}>
        <View style={styles.btnInner}>
          <Icon name="eye" color={theme.text} size={18} />
          <Text style={[styles.btnOutlineText, { color: theme.text }]}>以只读模式进入</Text>
        </View>
      </Pressable>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontSize: 13, marginBottom: 18 },
  card: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 12 },
  label: { fontSize: 11, marginBottom: 4 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  warnRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 8 },
  valueRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  btnInner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  value: { fontSize: 14, fontWeight: "600" },
  addr: { fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  warn: { flex: 1, fontSize: 12, fontWeight: "700" },
  mnemonic: { fontSize: 15, lineHeight: 24, marginBottom: 10 },
  link: { fontSize: 13, textDecorationLine: "underline" },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13 },
  btn: { paddingVertical: 14, borderRadius: 10, alignItems: "center", marginTop: 8 },
  btnText: { fontSize: 15, fontWeight: "700" },
  btnOutline: { paddingVertical: 12, borderRadius: 10, alignItems: "center", borderWidth: 1, marginTop: 8 },
  btnOutlineText: { fontSize: 14, fontWeight: "600" },
  settingRow: { flexDirection: "row", justifyContent: "space-between", borderWidth: 1, borderRadius: 8, padding: 12, marginTop: 8 },
});
