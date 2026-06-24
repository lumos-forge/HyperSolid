import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Alert, ActivityIndicator } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useTheme } from "../theme/useTheme";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useThemeStore } from "../state/themeStore";
import { useLocaleStore } from "../state/localeStore";
import { useT } from "../i18n/useT";
import type { Locale } from "../i18n/messages";
import { WalletManager } from "../wallet/walletManager";
import { SecureStoreKeyStore } from "../wallet/secureKeyStore";
import { isValidAddress } from "../hooks/useViewOnlyPortfolio";
import { useUnconfirmedIntents } from "../hooks/useUnconfirmedIntents";
import { PositionsService } from "../services/positionsData";
import { FundingsService } from "../services/fundingsData";
import { createPositionsInfoClient, createFundingsInfoClient, createExchangeClient } from "../lib/hyperliquid/client";
import { ExchangeService } from "../services/exchange";
import { DepositService } from "../services/deposit";
import { createArbitrumDepositClient, fetchArbitrumBalances } from "../lib/arbitrum/client";
import { arbitrumRpcFor, withdrawFeeFor } from "../state/runtimeConfigStore";
import { MIN_DEPOSIT_USDC } from "../lib/arbitrum/deposit";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { marginRatioPct } from "../lib/hyperliquid/markPnl";
import { totalFunding } from "../lib/hyperliquid/funding";
import { Icon, type IconName } from "../components/Icon";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { SurfaceCard } from "../components/SurfaceCard";
import { UnconfirmedBanner } from "../components/UnconfirmedBanner";
import { PriceText, formatPrice } from "../components/PriceText";
import { SectionLabel } from "../components/SectionLabel";
import { MnemonicVerify } from "../components/MnemonicVerify";
import { fonts } from "../theme/fonts";
import { withAlpha } from "../theme/color";
import type { ThemeName, ThemeTokens } from "../theme/tokens";
import type { AccountSummary } from "../lib/hyperliquid/types";
import type { LocalWalletService } from "../wallet/localWallet";

export interface AccountScreenDeps {
  positions: PositionsService;
  fundings: FundingsService;
  manager?: WalletManager;
}

const THEME_ORDER: ThemeName[] = ["electrum", "daylight", "oscilloscope"];

/** Below this ETH balance, an Arbitrum ERC-20 transfer likely can't pay gas — warn the user. */
const GAS_MIN_ETH = 0.0002;
const THEME_LABEL: Record<ThemeName, string> = {
  electrum: "Electrum",
  daylight: "Daylight",
  oscilloscope: "Oscilloscope",
};

const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  zh: "中文",
};

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function AccountScreen({ deps }: { deps?: AccountScreenDeps } = {}) {
  const theme = useTheme();
  const mode = useWalletStore((s) => s.mode);
  const address = useWalletStore((s) => s.address);
  const wallet = useWalletStore((s) => s.wallet);
  const setLocalWallet = useWalletStore((s) => s.setLocalWallet);
  const setViewOnly = useWalletStore((s) => s.setViewOnly);
  const reset = useWalletStore((s) => s.reset);
  const network = useEnvStore((s) => s.network);
  const toggleNetwork = useEnvStore((s) => s.toggleNetwork);
  const themeName = useThemeStore((s) => s.name);
  const setTheme = useThemeStore((s) => s.setTheme);
  const locale = useLocaleStore((s) => s.locale);
  const toggleLocale = useLocaleStore((s) => s.toggleLocale);
  const t = useT();
  const { count: unconfirmedCount } = useUnconfirmedIntents();
  const manager = useMemo(() => deps?.manager ?? new WalletManager(new SecureStoreKeyStore()), [deps]);

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
  // Created phrases must pass a backup-confirmation quiz before dismissal; exported ones don't.
  const [needsVerify, setNeedsVerify] = useState(false);
  const [verifyPhrase, setVerifyPhrase] = useState(false);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [fundingTotal, setFundingTotal] = useState<number | null>(null);
  const [sheet, setSheet] = useState<"none" | "deposit" | "withdraw">("none");
  const [amountInput, setAmountInput] = useState("");
  const [destInput, setDestInput] = useState("");
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawMainnetConfirm, setWithdrawMainnetConfirm] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [mainnetConfirm, setMainnetConfirm] = useState(false);
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositBalances, setDepositBalances] = useState<{ usdc: number; eth: number } | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);

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

  // Deposit precheck (§B2b): when the deposit sheet opens, read the wallet's Arbitrum USDC (depositable)
  // and ETH (gas) balances via the server-delivered RPC. Cleared when the sheet closes / RPC absent.
  useEffect(() => {
    const rpcUrl = arbitrumRpcFor(network);
    if (sheet !== "deposit" || mode !== "local" || !address || !isValidAddress(address) || !rpcUrl) {
      setDepositBalances(null);
      return;
    }
    let active = true;
    fetchArbitrumBalances(network, address as `0x${string}`, rpcUrl)
      .then((b) => active && setDepositBalances(b))
      .catch(() => active && setDepositBalances(null));
    return () => {
      active = false;
    };
  }, [sheet, mode, address, network]);

  async function onCreate() {
    setBusy(true);
    try {
      const { mnemonic, wallet } = await manager.createWallet();
      setNewMnemonic(mnemonic);
      setNeedsVerify(true);
      setVerifyPhrase(false);
      setLocalWallet(wallet);
    } catch (e) {
      Alert.alert(t("account.createFailed"), e instanceof Error ? e.message : String(e));
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
      Alert.alert(t("account.restoreFailed"), t("account.invalidMnemonic"));
    } finally {
      setBusy(false);
    }
  }

  function onViewOnly() {
    if (!isValidAddress(addrInput)) {
      Alert.alert(t("account.invalidAddress"), t("account.invalidAddressBody"));
      return;
    }
    setViewOnly(addrInput.trim());
  }

  async function onSignOut() {
    await manager.signOut();
    reset();
    setNewMnemonic(null);
    setNeedsVerify(false);
    setVerifyPhrase(false);
  }

  async function onExportBackup() {
    try {
      const mnemonic = await manager.exportMnemonic();
      if (!mnemonic) {
        Alert.alert(t("account.exportFailed"), t("account.exportFailedBody"));
        return;
      }
      setNeedsVerify(false);
      setVerifyPhrase(false);
      setNewMnemonic(mnemonic);
    } catch {
      Alert.alert(t("account.exportFailed"), t("account.exportFailedBody"));
    }
  }

  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themeName) + 1) % THEME_ORDER.length];
    setTheme(next);
  }

  async function onCopyAddress() {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setAddressCopied(true);
  }

  // Deposit/Withdraw are non-custodial money in/out (spec §B). Deposit signs an Arbitrum USDC
  // transfer to the HL bridge (§B2b); Withdraw signs a real HL withdraw3. Both via injectable
  // services — keys never leave the device.
  function onDeposit() {
    setMainnetConfirm(false);
    setAddressCopied(false);
    setSheet((s) => (s === "deposit" ? "none" : "deposit"));
  }
  function onWithdraw() {
    setWithdrawMainnetConfirm(false);
    setDestInput((d) => d || address || "");
    setSheet((s) => (s === "withdraw" ? "none" : "withdraw"));
  }
  async function onConfirmDeposit() {
    const local = wallet as Partial<LocalWalletService> | null;
    if (!local || typeof local.getViemAccount !== "function") return;
    // Mainnet sends real money — require a distinct second confirmation before signing.
    if (network === "mainnet" && !mainnetConfirm) {
      setMainnetConfirm(true);
      return;
    }
    // RPC is delivered by the server at runtime (never embedded). Block clearly until it arrives.
    const rpcUrl = arbitrumRpcFor(network);
    if (!rpcUrl) {
      Alert.alert(t("account.depositUnavailable"), t("account.depositNoRpc"));
      return;
    }
    setDepositBusy(true);
    try {
      const client = createArbitrumDepositClient(network, local.getViemAccount(), rpcUrl);
      const svc = new DepositService(client, network);
      const res = await svc.depositUsdc({
        amount: Number(depositAmount),
        available: depositBalances?.usdc,
        confirmed: network === "mainnet",
      });
      if (res.ok) {
        Alert.alert(t("account.depositSent"), t("account.depositSentBody", { tx: res.txHash.slice(0, 12) }));
        setSheet("none");
        setMainnetConfirm(false);
        setDepositAmount("");
      } else if (res.uncertain) {
        Alert.alert(t("common.uncertainReceipt"), t("account.depositUncertain", { error: res.error }));
      } else {
        Alert.alert(t("account.depositNotSubmitted"), res.error);
      }
    } finally {
      setDepositBusy(false);
    }
  }
  async function onConfirmWithdraw() {
    const local = wallet as Partial<LocalWalletService> | null;
    if (!local || typeof local.getViemAccount !== "function") return;
    // Mainnet moves real money — require a distinct second confirmation before signing.
    if (network === "mainnet" && !withdrawMainnetConfirm) {
      setWithdrawMainnetConfirm(true);
      return;
    }
    setWithdrawBusy(true);
    try {
      const client = createExchangeClient(network, local.getViemAccount());
      const svc = new ExchangeService(client, buildAssetIndex({ universe: [] }));
      const res = await svc.withdrawUsdc({
        destination: destInput.trim(),
        amount: Number(amountInput),
        withdrawable: summary?.withdrawable ?? 0,
      });
      if (res.ok) {
        Alert.alert(t("account.withdrawSubmitted"), t("account.withdrawSubmittedBody", { amount: amountInput, dest: shortAddr(destInput.trim()) }));
        setSheet("none");
        setWithdrawMainnetConfirm(false);
        setAmountInput("");
      } else if (res.uncertain) {
        Alert.alert(t("common.uncertainReceipt"), t("account.withdrawUncertain", { error: res.error }));
      } else {
        Alert.alert(t("account.withdrawFailed"), res.error);
      }
    } finally {
      setWithdrawBusy(false);
    }
  }

  if (mode !== "none") {
    const withdrawFee = withdrawFeeFor(network);
    const withdrawNet = Math.max(0, (Number(amountInput) || 0) - withdrawFee).toFixed(2);
    return (
      <ScreenScaffold theme={theme} statusTitle={t("tab.wallet")} pill={<NetworkWarning variant="chip" />}>
        <UnconfirmedBanner theme={theme} count={unconfirmedCount} />

        <SurfaceCard theme={theme} style={styles.wcard}>
          <View style={styles.wtop}>
            <View style={styles.labelRow}>
              <Icon name={mode === "local" ? "lock" : "eye"} color={theme.brand} size={15} />
              <Text style={[styles.wlabel, { color: theme.text }]}>
                {mode === "local" ? t("account.localWallet") : t("account.viewOnlyLabel")}
              </Text>
            </View>
            <Text style={[styles.badge, { color: theme.brand, borderColor: theme.lineStrong }]}>
              {mode === "local" ? t("account.nonCustodial") : t("account.readOnly")}
            </Text>
          </View>
          <Text style={[styles.addr, { color: theme.muted }]}>{address ? shortAddr(address) : "—"}</Text>
          <View style={styles.balRow}>
            <Text style={[styles.balLabel, { color: theme.muted }]}>{t("account.balance")}</Text>
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
              <Text style={[styles.actionText, { color: theme.bg }]}>{t("common.deposit")}</Text>
            </Pressable>
            <Pressable
              onPress={onWithdraw}
              accessibilityRole="button"
              style={[styles.action, styles.actionOutline, { borderColor: theme.lineStrong }]}
            >
              <Text style={[styles.actionText, { color: theme.text }]}>{t("common.withdraw")}</Text>
            </Pressable>
          </View>
        ) : null}

        {mode === "local" && summary && summary.accountValue <= 0 && sheet !== "deposit" ? (
          <Pressable
            onPress={onDeposit}
            accessibilityRole="button"
            testID="fund-nudge"
            style={[styles.fundNudge, { borderColor: theme.brand, backgroundColor: withAlpha(theme.brand, 0.08) }]}
          >
            <Icon name="alert" color={theme.brand} size={15} />
            <Text style={[styles.fundNudgeText, { color: theme.text }]}>{t("account.fundNudge")}</Text>
            <Icon name="chevronRight" color={theme.brand} size={15} strokeWidth={2} />
          </Pressable>
        ) : null}

        {mode === "local" && sheet === "deposit" ? (
          <SurfaceCard theme={theme} testID="deposit-panel" style={styles.card}>
            <Text style={[styles.sheetTitle, { color: theme.text }]}>{t("account.depositTitle")}</Text>
            <Text style={[styles.sheetHint, { color: theme.muted }]}>
              {t("account.depositHint", { min: MIN_DEPOSIT_USDC })}
            </Text>
            <Text style={[styles.fundTitle, { color: theme.text }]}>{t("account.fundWalletTitle")}</Text>
            <View style={[styles.fundRow, { borderColor: theme.line, backgroundColor: theme.surfaceAlt }]}>
              <Text style={[styles.fundAddr, { color: theme.muted }]} numberOfLines={1} ellipsizeMode="middle">
                {address ?? "—"}
              </Text>
              <Pressable onPress={onCopyAddress} accessibilityRole="button" testID="copy-address" style={[styles.copyBtn, { borderColor: theme.lineStrong }]}>
                <Text style={[styles.copyText, { color: theme.brand }]}>
                  {addressCopied ? t("account.copied") : t("account.copyAddress")}
                </Text>
              </Pressable>
            </View>
            <Text style={[styles.fundHint, { color: theme.faint }]}>{t("account.fundWalletHint")}</Text>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("account.amountUsdc")}</Text>
            <TextInput
              value={depositAmount}
              onChangeText={(v) => {
                setMainnetConfirm(false);
                setDepositAmount(v);
              }}
              testID="deposit-amount"
              keyboardType="decimal-pad"
              placeholder={`${MIN_DEPOSIT_USDC}.00`}
              placeholderTextColor={theme.faint}
              style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
            />
            {depositBalances ? (
              <Text style={[styles.feeLine, { color: theme.muted }]} testID="deposit-available">
                {t("account.depositAvailable", { usdc: depositBalances.usdc.toFixed(2), eth: depositBalances.eth.toFixed(4) })}
              </Text>
            ) : null}
            {depositBalances && depositBalances.eth < GAS_MIN_ETH ? (
              <Text style={[styles.dangerNote, { color: theme.warn }]} testID="deposit-gas-warning">
                {t("account.depositGasWarning")}
              </Text>
            ) : null}
            {network === "mainnet" && mainnetConfirm ? (
              <Text style={[styles.dangerNote, { color: theme.warn }]} testID="deposit-mainnet-confirm">
                {t("account.depositMainnetWarn")}
              </Text>
            ) : null}
            <View style={styles.sheetRow}>
              <Pressable disabled={depositBusy} onPress={onConfirmDeposit} accessibilityRole="button" testID="deposit-confirm" style={[styles.sheetBtn, { backgroundColor: network === "mainnet" && mainnetConfirm ? theme.warn : theme.brand }]}>
                {depositBusy ? (
                  <ActivityIndicator color={theme.bg} />
                ) : (
                  <Text style={[styles.sheetBtnText, { color: theme.bg }]}>
                    {network === "mainnet" ? (mainnetConfirm ? t("account.depositSendReal") : t("account.depositReview")) : t("account.depositConfirmBtn")}
                  </Text>
                )}
              </Pressable>
              <Pressable
                onPress={() => {
                  setSheet("none");
                  setMainnetConfirm(false);
                }}
                accessibilityRole="button"
                style={[styles.sheetBtn, styles.sheetBtnOutline, { borderColor: theme.lineStrong }]}
              >
                <Text style={[styles.sheetBtnText, { color: theme.text }]}>{t("account.close")}</Text>
              </Pressable>
            </View>
          </SurfaceCard>
        ) : null}

        {mode === "local" && sheet === "withdraw" ? (
          <SurfaceCard theme={theme} testID="withdraw-panel" style={styles.card}>
            <Text style={[styles.sheetTitle, { color: theme.text }]}>{t("account.withdrawTitle")}</Text>
            <Text style={[styles.sheetHint, { color: theme.muted }]}>
              {t("account.withdrawableHint", { amount: summary ? formatPrice(summary.withdrawable) : "—" })}
            </Text>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("account.amountUsdc")}</Text>
            <TextInput
              value={amountInput}
              onChangeText={(v) => {
                setWithdrawMainnetConfirm(false);
                setAmountInput(v);
              }}
              testID="withdraw-amount"
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={theme.faint}
              style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
            />
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("account.destination")}</Text>
            <TextInput
              value={destInput}
              onChangeText={(v) => {
                setWithdrawMainnetConfirm(false);
                setDestInput(v);
              }}
              testID="withdraw-dest"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="0x…"
              placeholderTextColor={theme.faint}
              style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
            />
            <Text style={[styles.feeLine, { color: theme.muted }]} testID="withdraw-fee">
              {t("account.withdrawFeeLine", { fee: withdrawFee, net: withdrawNet })}
            </Text>
            {network === "mainnet" && withdrawMainnetConfirm ? (
              <Text style={[styles.dangerNote, { color: theme.warn }]} testID="withdraw-mainnet-confirm">
                {t("account.withdrawMainnetWarn")}
              </Text>
            ) : null}
            <View style={styles.sheetRow}>
              <Pressable disabled={withdrawBusy} onPress={onConfirmWithdraw} accessibilityRole="button" testID="withdraw-confirm" style={[styles.sheetBtn, { backgroundColor: network === "mainnet" && withdrawMainnetConfirm ? theme.warn : theme.brand }]}>
                {withdrawBusy ? (
                  <ActivityIndicator color={theme.bg} />
                ) : (
                  <Text style={[styles.sheetBtnText, { color: theme.bg }]}>
                    {network === "mainnet" ? (withdrawMainnetConfirm ? t("account.withdrawReal") : t("account.withdrawReview")) : t("account.withdrawConfirmBtn")}
                  </Text>
                )}
              </Pressable>
              <Pressable
                onPress={() => {
                  setSheet("none");
                  setWithdrawMainnetConfirm(false);
                }}
                accessibilityRole="button"
                style={[styles.sheetBtn, styles.sheetBtnOutline, { borderColor: theme.lineStrong }]}
              >
                <Text style={[styles.sheetBtnText, { color: theme.text }]}>{t("account.close")}</Text>
              </Pressable>
            </View>
          </SurfaceCard>
        ) : null}

        {summary ? (
          <SurfaceCard theme={theme} rule={false} style={styles.card}>
            <Text style={[styles.cardTitle, { color: theme.muted }]}>{t("account.accountSummary")}</Text>
            <View style={styles.metricRow}>
              <Metric theme={theme} label={t("account.equity")} value={`$${formatPrice(summary.accountValue)}`} />
              <Metric theme={theme} label={t("positions.available")} value={`$${formatPrice(summary.withdrawable)}`} />
              <Metric
                theme={theme}
                label={t("positions.marginRatio")}
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
              <Text style={[styles.cardTitle, { color: theme.muted }]}>{t("account.funding")}</Text>
              <Text style={[styles.value, { color: fundingTotal <= 0 ? theme.down : theme.up }]}>
                {`${fundingTotal >= 0 ? "+" : ""}${fundingTotal.toFixed(2)} USDC`}
              </Text>
            </View>
            <Text style={[styles.fundingHint, { color: theme.faint }]}>
              {t("account.fundingHint")}
            </Text>
          </SurfaceCard>
        ) : null}

        {newMnemonic && verifyPhrase ? (
          <MnemonicVerify
            mnemonic={newMnemonic}
            onVerified={() => {
              setNewMnemonic(null);
              setNeedsVerify(false);
              setVerifyPhrase(false);
            }}
          />
        ) : newMnemonic ? (
          <SurfaceCard theme={theme} style={[styles.card, { borderColor: theme.warn }]}>
            <View style={styles.warnRow}>
              <Icon name="alert" color={theme.warn} size={16} />
              <Text style={[styles.warn, { color: theme.warn }]}>
                {t("account.backupWarn")}
              </Text>
            </View>
            <Text style={[styles.mnemonic, { color: theme.text }]}>{newMnemonic}</Text>
            {needsVerify ? (
              <Pressable onPress={() => setVerifyPhrase(true)} accessibilityRole="button">
                <Text style={[styles.link, { color: theme.brand }]}>{t("account.continue")}</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => setNewMnemonic(null)} accessibilityRole="button">
                <Text style={[styles.link, { color: theme.muted }]}>{t("account.backedUp")}</Text>
              </Pressable>
            )}
          </SurfaceCard>
        ) : null}

        <SettingRow theme={theme} icon="swap" name={t("account.network")} value={network} onPress={toggleNetwork} />
        <SettingRow theme={theme} icon="agent" name={t("account.theme")} value={THEME_LABEL[themeName]} onPress={cycleTheme} />
        <SettingRow theme={theme} icon="repeat" name={t("settings.language")} value={LOCALE_LABEL[locale]} onPress={toggleLocale} />
        {mode === "local" ? (
          <SettingRow theme={theme} icon="key" name={t("account.exportBackup")} value="" onPress={onExportBackup} />
        ) : null}

        <Pressable onPress={onSignOut} accessibilityRole="button" style={[styles.signOut, { borderColor: theme.down }]}>
          <Text style={[styles.signOutText, { color: theme.down }]}>{t("account.signOutSwitch")}</Text>
        </Pressable>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      theme={theme}
      statusTitle={t("tab.wallet")}
      pill={<NetworkWarning variant="chip" />}
      heading={t("account.welcome")}
    >
      <Text style={[styles.subtitle, { color: theme.muted }]}>
        {t("account.welcomeSubtitle")}
      </Text>

      <Pressable disabled={busy} onPress={onCreate} accessibilityRole="button" style={[styles.btn, { backgroundColor: theme.brand }]}>
        <View style={styles.btnInner}>
          <Icon name="star" active color={theme.bg} size={18} />
          <Text style={[styles.btnText, { color: theme.bg }]}>{t("account.createLocal")}</Text>
        </View>
      </Pressable>
      <Text style={[styles.optionHint, { color: theme.muted }]}>{t("account.createLocalHint")}</Text>

      <SectionLabel theme={theme}>{t("account.restoreFrom")}</SectionLabel>
      <Text style={[styles.optionHint, { color: theme.faint }]}>{t("account.restoreHint")}</Text>
      <TextInput
        value={mnemonicInput}
        onChangeText={setMnemonicInput}
        placeholder={t("account.mnemonicPlaceholder")}
        placeholderTextColor={theme.faint}
        autoCapitalize="none"
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
      <Pressable disabled={busy} onPress={onRestore} accessibilityRole="button" style={[styles.btnOutline, { borderColor: theme.brand }]}>
        <View style={styles.btnInner}>
          <Icon name="key" color={theme.brand} size={18} />
          <Text style={[styles.btnOutlineText, { color: theme.brand }]}>{t("account.restoreWalletBtn")}</Text>
        </View>
      </Pressable>

      <SectionLabel theme={theme}>{t("account.viewOnlyZeroKeys")}</SectionLabel>
      <Text style={[styles.optionHint, { color: theme.faint }]}>{t("account.viewOnlyHint")}</Text>
      <TextInput
        value={addrInput}
        onChangeText={setAddrInput}
        placeholder={t("account.addressPlaceholder")}
        placeholderTextColor={theme.faint}
        autoCapitalize="none"
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
      <Pressable onPress={onViewOnly} accessibilityRole="button" style={[styles.btnOutline, { borderColor: theme.line }]}>
        <View style={styles.btnInner}>
          <Icon name="eye" color={theme.text} size={18} />
          <Text style={[styles.btnOutlineText, { color: theme.text }]}>{t("account.enterViewOnly")}</Text>
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
  optionHint: { fontFamily: fonts.body.regular, fontSize: 11.5, lineHeight: 16, marginTop: 6, marginBottom: 4 },
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
  sheetTitle: { fontFamily: fonts.display.bold, fontSize: 14, marginBottom: 8 },
  sheetHint: { fontFamily: fonts.body.regular, fontSize: 11.5, lineHeight: 17, marginBottom: 12 },
  fundTitle: { fontFamily: fonts.body.semibold, fontSize: 12, marginBottom: 6 },
  fundRow: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 10, paddingLeft: 10, paddingRight: 6, paddingVertical: 6, marginBottom: 6 },
  fundAddr: { flex: 1, fontFamily: fonts.mono.regular, fontSize: 12 },
  copyBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  copyText: { fontFamily: fonts.display.bold, fontSize: 12 },
  fundHint: { fontFamily: fonts.body.regular, fontSize: 11, lineHeight: 16, marginBottom: 12 },
  fundNudge: { flexDirection: "row", alignItems: "center", gap: 9, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, marginBottom: 14 },
  fundNudgeText: { flex: 1, fontFamily: fonts.body.semibold, fontSize: 12.5, lineHeight: 17 },
  depAddr: { fontFamily: fonts.mono.regular, fontSize: 13, marginBottom: 14 },
  dangerNote: { fontFamily: fonts.body.semibold, fontSize: 11.5, lineHeight: 16, marginTop: 10 },
  feeLine: { fontFamily: fonts.mono.regular, fontSize: 11.5, marginTop: 10 },
  fieldLabel: { fontFamily: fonts.body.regular, fontSize: 11, marginBottom: 4 },
  sheetRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  sheetBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  sheetBtnOutline: { borderWidth: 1, backgroundColor: "transparent" },
  sheetBtnText: { fontFamily: fonts.display.bold, fontSize: 13, letterSpacing: 0.3 },
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
