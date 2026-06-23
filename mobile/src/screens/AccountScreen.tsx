import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Alert } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useThemeStore } from "../state/themeStore";
import { WalletManager } from "../wallet/walletManager";
import { SecureStoreKeyStore } from "../wallet/secureKeyStore";
import { isValidAddress } from "../hooks/useViewOnlyPortfolio";
import { useUnconfirmedIntents } from "../hooks/useUnconfirmedIntents";
import { PositionsService } from "../services/positionsData";
import { FundingsService } from "../services/fundingsData";
import { createPositionsInfoClient, createFundingsInfoClient } from "../lib/hyperliquid/client";
import { marginRatioPct } from "../lib/hyperliquid/markPnl";
import { totalFunding } from "../lib/hyperliquid/funding";
import { Icon, type IconName } from "../components/Icon";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { SurfaceCard } from "../components/SurfaceCard";
import { UnconfirmedBanner } from "../components/UnconfirmedBanner";
import { PriceText, formatPrice } from "../components/PriceText";
import { SectionLabel } from "../components/SectionLabel";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";
import type { ThemeName, ThemeTokens } from "../theme/tokens";
import type { AccountSummary } from "../lib/hyperliquid/types";

export interface AccountScreenDeps {
  positions: PositionsService;
  fundings: FundingsService;
}

const THEME_ORDER: ThemeName[] = ["electrum", "daylight", "oscilloscope"];
const THEME_LABEL: Record<ThemeName, string> = {
  electrum: "Electrum",
  daylight: "Daylight",
  oscilloscope: "Oscilloscope",
};

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function AccountScreen({ deps }: { deps?: AccountScreenDeps } = {}) {
  const theme = useTheme();
  const mode = useWalletStore((s) => s.mode);
  const address = useWalletStore((s) => s.address);
  const setLocalWallet = useWalletStore((s) => s.setLocalWallet);
  const setViewOnly = useWalletStore((s) => s.setViewOnly);
  const reset = useWalletStore((s) => s.reset);
  const network = useEnvStore((s) => s.network);
  const toggleNetwork = useEnvStore((s) => s.toggleNetwork);
  const themeName = useThemeStore((s) => s.name);
  const setTheme = useThemeStore((s) => s.setTheme);
  const { count: unconfirmedCount } = useUnconfirmedIntents();
  const manager = useMemo(() => new WalletManager(new SecureStoreKeyStore()), []);

  const services = useMemo<AccountScreenDeps>(
    () =>
      deps ?? {
        positions: new PositionsService(createPositionsInfoClient(network)),
        fundings: new FundingsService(createFundingsInfoClient(network)),
      },
    [deps, network],
  );

  const [busy, setBusy] = useState(false);
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [addrInput, setAddrInput] = useState("");
  const [newMnemonic, setNewMnemonic] = useState<string | null>(null);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [fundingTotal, setFundingTotal] = useState<number | null>(null);

  useEffect(() => {
    if (mode === "none" || !address || !isValidAddress(address)) {
      setSummary(null);
      setFundingTotal(null);
      return;
    }
    let active = true;
    services.positions
      .loadPortfolio(address)
      .then((p) => active && setSummary(p.summary))
      .catch(() => active && setSummary(null));
    services.fundings
      .load(address, 0)
      .then((f) => active && setFundingTotal(totalFunding(f)))
      .catch(() => active && setFundingTotal(null));
    return () => {
      active = false;
    };
  }, [mode, address, services]);

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

  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themeName) + 1) % THEME_ORDER.length];
    setTheme(next);
  }

  // Deposit/Withdraw are non-custodial money in/out entry points. The actual transfer flow
  // (bridge deposit / HL withdraw) is not implemented yet — surface an honest notice rather than
  // a silent dead button.
  function onDeposit() {
    Alert.alert("Deposit", "充值流程即将上线：向 Hyperliquid 桥地址转入 USDC（Arbitrum）。");
  }
  function onWithdraw() {
    Alert.alert("Withdraw", "提现流程即将上线：从 Hyperliquid 提取 USDC 到你的地址。");
  }

  if (mode !== "none") {
    return (
      <ScreenScaffold theme={theme} statusTitle="Wallet" pill={<NetworkWarning variant="chip" />}>
        <UnconfirmedBanner theme={theme} count={unconfirmedCount} />

        <SurfaceCard theme={theme} style={styles.wcard}>
          <View style={styles.wtop}>
            <View style={styles.labelRow}>
              <Icon name={mode === "local" ? "lock" : "eye"} color={theme.brand} size={15} />
              <Text style={[styles.wlabel, { color: theme.text }]}>
                {mode === "local" ? "Local wallet" : "View-only"}
              </Text>
            </View>
            <Text style={[styles.badge, { color: theme.brand, borderColor: theme.lineStrong }]}>
              {mode === "local" ? "Non-custodial" : "Read-only"}
            </Text>
          </View>
          <Text style={[styles.addr, { color: theme.muted }]}>{address ? shortAddr(address) : "—"}</Text>
          <View style={styles.balRow}>
            <Text style={[styles.balLabel, { color: theme.muted }]}>Balance</Text>
            {summary ? (
              <PriceText value={summary.accountValue} color={theme.text} size={18} glow glowColor={theme.glow} />
            ) : (
              <Text style={[styles.balPlaceholder, { color: theme.faint }]}>—</Text>
            )}
          </View>
        </SurfaceCard>

        {mode === "local" ? (
          <View style={styles.actions}>
            <Pressable onPress={onDeposit} accessibilityRole="button" style={[styles.action, { backgroundColor: theme.brand }]}>
              <Text style={[styles.actionText, { color: theme.bg }]}>Deposit</Text>
            </Pressable>
            <Pressable
              onPress={onWithdraw}
              accessibilityRole="button"
              style={[styles.action, styles.actionOutline, { borderColor: theme.lineStrong }]}
            >
              <Text style={[styles.actionText, { color: theme.text }]}>Withdraw</Text>
            </Pressable>
          </View>
        ) : null}

        {summary ? (
          <SurfaceCard theme={theme} rule={false} style={styles.card}>
            <Text style={[styles.cardTitle, { color: theme.muted }]}>Account summary</Text>
            <View style={styles.metricRow}>
              <Metric theme={theme} label="Equity" value={`$${formatPrice(summary.accountValue)}`} />
              <Metric theme={theme} label="Available" value={`$${formatPrice(summary.withdrawable)}`} />
              <Metric
                theme={theme}
                label="Margin ratio"
                value={(() => {
                  const r = marginRatioPct(summary.accountValue, summary.totalMarginUsed);
                  return r === null ? "—" : `${r.toFixed(1)}%`;
                })()}
              />
            </View>
          </SurfaceCard>
        ) : null}

        {fundingTotal !== null ? (
          <SurfaceCard theme={theme} rule={false} style={styles.card}>
            <View style={styles.fundingRow}>
              <Text style={[styles.cardTitle, { color: theme.muted }]}>Funding</Text>
              <Text style={[styles.value, { color: fundingTotal <= 0 ? theme.down : theme.up }]}>
                {`${fundingTotal >= 0 ? "+" : ""}${fundingTotal.toFixed(2)} USDC`}
              </Text>
            </View>
            <Text style={[styles.fundingHint, { color: theme.faint }]}>
              Negative = funding paid (oracle-priced settlement)
            </Text>
          </SurfaceCard>
        ) : null}

        {newMnemonic ? (
          <SurfaceCard theme={theme} style={[styles.card, { borderColor: theme.warn }]}>
            <View style={styles.warnRow}>
              <Icon name="alert" color={theme.warn} size={16} />
              <Text style={[styles.warn, { color: theme.warn }]}>
                Back up your recovery phrase now (shown once, never screenshot it).
              </Text>
            </View>
            <Text style={[styles.mnemonic, { color: theme.text }]}>{newMnemonic}</Text>
            <Pressable onPress={() => setNewMnemonic(null)} accessibilityRole="button">
              <Text style={[styles.link, { color: theme.muted }]}>I've backed it up safely</Text>
            </Pressable>
          </SurfaceCard>
        ) : null}

        <SettingRow theme={theme} icon="swap" name="Network" value={network} onPress={toggleNetwork} />
        <SettingRow theme={theme} icon="agent" name="Theme" value={THEME_LABEL[themeName]} onPress={cycleTheme} />

        <Pressable onPress={onSignOut} accessibilityRole="button" style={[styles.signOut, { borderColor: theme.down }]}>
          <Text style={[styles.signOutText, { color: theme.down }]}>Sign out / switch wallet</Text>
        </Pressable>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      theme={theme}
      statusTitle="Wallet"
      pill={<NetworkWarning variant="chip" />}
      heading="Welcome to HyperSolid"
    >
      <Text style={[styles.subtitle, { color: theme.muted }]}>
        Choose how to begin — non-custodial, your keys never leave the device.
      </Text>

      <Pressable disabled={busy} onPress={onCreate} accessibilityRole="button" style={[styles.btn, { backgroundColor: theme.brand }]}>
        <View style={styles.btnInner}>
          <Icon name="star" active color={theme.bg} size={18} />
          <Text style={[styles.btnText, { color: theme.bg }]}>Create local wallet</Text>
        </View>
      </Pressable>

      <SectionLabel theme={theme}>Restore from phrase</SectionLabel>
      <TextInput
        value={mnemonicInput}
        onChangeText={setMnemonicInput}
        placeholder="12-word recovery phrase"
        placeholderTextColor={theme.faint}
        autoCapitalize="none"
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
      <Pressable disabled={busy} onPress={onRestore} accessibilityRole="button" style={[styles.btnOutline, { borderColor: theme.brand }]}>
        <View style={styles.btnInner}>
          <Icon name="key" color={theme.brand} size={18} />
          <Text style={[styles.btnOutlineText, { color: theme.brand }]}>Restore wallet</Text>
        </View>
      </Pressable>

      <SectionLabel theme={theme}>View-only (zero keys)</SectionLabel>
      <TextInput
        value={addrInput}
        onChangeText={setAddrInput}
        placeholder="0x… address"
        placeholderTextColor={theme.faint}
        autoCapitalize="none"
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
      <Pressable onPress={onViewOnly} accessibilityRole="button" style={[styles.btnOutline, { borderColor: theme.line }]}>
        <View style={styles.btnInner}>
          <Icon name="eye" color={theme.text} size={18} />
          <Text style={[styles.btnOutlineText, { color: theme.text }]}>Enter view-only</Text>
        </View>
      </Pressable>
    </ScreenScaffold>
  );
}

function Metric({ theme, label, value }: { theme: ThemeTokens; label: string; value: string }) {
  return (
    <View style={styles.metricCell}>
      <Text style={[styles.metricLabel, { color: theme.faint }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function SettingRow({
  theme,
  icon,
  name,
  value,
  onPress,
}: {
  theme: ThemeTokens;
  icon: IconName;
  name: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={[styles.settingRow, { borderBottomColor: theme.line }]}>
      <View style={[styles.settingIcon, { backgroundColor: withAlpha(theme.brand, 0.12) }]}>
        <Icon name={icon} color={theme.brand} size={16} />
      </View>
      <Text style={[styles.settingName, { color: theme.text }]}>{name}</Text>
      <Text style={[styles.settingValue, { color: theme.muted }]}>{value}</Text>
      <Icon name="chevronRight" color={theme.faint} size={14} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontFamily: fonts.body.regular, fontSize: 13, marginBottom: 18 },
  wcard: { padding: 16, marginTop: 4 },
  wtop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  wlabel: { fontFamily: fonts.display.bold, fontSize: 13 },
  badge: { fontFamily: fonts.mono.bold, fontSize: 9, letterSpacing: 0.4, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  addr: { fontFamily: fonts.mono.regular, fontSize: 13, marginBottom: 12 },
  balRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  balLabel: { fontFamily: fonts.body.regular, fontSize: 12 },
  balPlaceholder: { fontFamily: fonts.mono.medium, fontSize: 18 },
  actions: { flexDirection: "row", gap: 10, marginBottom: 14 },
  action: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: "center" },
  actionOutline: { borderWidth: 1, backgroundColor: "transparent" },
  actionText: { fontFamily: fonts.display.bold, fontSize: 14, letterSpacing: 0.3 },
  card: { padding: 14, marginBottom: 12 },
  cardTitle: { fontFamily: fonts.body.medium, fontSize: 11 },
  metricRow: { flexDirection: "row", marginTop: 10 },
  metricCell: { flex: 1 },
  metricLabel: { fontFamily: fonts.body.regular, fontSize: 10, marginBottom: 3 },
  metricValue: { fontFamily: fonts.mono.medium, fontSize: 14 },
  fundingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  fundingHint: { fontFamily: fonts.body.regular, fontSize: 11, marginTop: 6 },
  value: { fontFamily: fonts.mono.bold, fontSize: 14 },
  warnRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 8 },
  warn: { flex: 1, fontFamily: fonts.body.semibold, fontSize: 12, lineHeight: 17 },
  mnemonic: { fontFamily: fonts.mono.regular, fontSize: 15, lineHeight: 24, marginBottom: 10 },
  link: { fontFamily: fonts.body.medium, fontSize: 13, textDecorationLine: "underline" },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.body.regular,
    fontSize: 13,
  },
  btn: { paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 8 },
  btnText: { fontFamily: fonts.display.bold, fontSize: 15 },
  btnInner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  btnOutline: { paddingVertical: 12, borderRadius: 12, alignItems: "center", borderWidth: 1, marginTop: 8 },
  btnOutlineText: { fontFamily: fonts.body.semibold, fontSize: 14 },
  settingRow: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 13, borderBottomWidth: 1 },
  settingIcon: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  settingName: { flex: 1, fontFamily: fonts.body.semibold, fontSize: 13 },
  settingValue: { fontFamily: fonts.mono.medium, fontSize: 12 },
  signOut: { paddingVertical: 13, borderRadius: 12, alignItems: "center", borderWidth: 1, marginTop: 18 },
  signOutText: { fontFamily: fonts.body.semibold, fontSize: 14 },
});
