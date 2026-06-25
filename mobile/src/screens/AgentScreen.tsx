import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Alert, ActivityIndicator } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useRuntimeConfigStore } from "../state/runtimeConfigStore";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { SurfaceCard } from "../components/SurfaceCard";
import { Toggle } from "../components/Toggle";
import { fonts } from "../theme/fonts";
import type { ThemeTokens } from "../theme/tokens";
import { StrategyApi, type Strategy } from "../services/strategyApi";
import { openStrategySession } from "../wallet/walletSession";
import { ExchangeService } from "../services/exchange";
import { createExchangeClient } from "../lib/hyperliquid/client";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { useStrategyController } from "../hooks/useStrategyController";
import type { LocalWalletService } from "../wallet/localWallet";
import type { Account } from "viem";

const AGENT_VALIDITY_MS = 90 * 24 * 3600 * 1000;

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function AgentScreen({ navigation }: { navigation?: { navigate: (name: string) => void } }) {
  const theme = useTheme();
  const t = useT();
  const mode = useWalletStore((s) => s.mode);
  const wallet = useWalletStore((s) => s.wallet);
  const address = useWalletStore((s) => s.address);
  const network = useEnvStore((s) => s.network);
  const baseUrl = useRuntimeConfigStore((s) => s.strategyApiBaseUrl);

  const [token, setToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const local = wallet as Partial<LocalWalletService> | null;
  const ready =
    mode === "local" && !!local && typeof local.getViemAccount === "function" && !!baseUrl && !!address;

  async function connect() {
    if (!ready || !baseUrl || !address || !local || typeof local.getViemAccount !== "function") return;
    setConnecting(true);
    try {
      const tok = await openStrategySession(
        new StrategyApi(baseUrl, null),
        local.getViemAccount() as { signMessage(a: { message: string }): Promise<string> },
        address,
      );
      setToken(tok);
    } catch (e) {
      Alert.alert(t("agent.connectFailed"), e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <ScreenScaffold theme={theme} pill={<NetworkWarning variant="chip" />}>
      {!ready ? (
        <SurfaceCard theme={theme} testID="strategy-gated" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.automationTitle")}</Text>
          <Text style={[styles.hint, { color: theme.muted }]}>
            {!baseUrl ? t("agent.gatedNoConfig") : t("agent.gatedNoWallet")}
          </Text>
          {baseUrl ? (
            <Pressable
              accessibilityRole="button"
              testID="gated-setup-wallet"
              onPress={() => navigation?.navigate("Account")}
              style={[styles.cta, { backgroundColor: theme.brand }]}
            >
              <Text style={[styles.ctaText, { color: theme.bg }]}>{t("common.setUpWallet")}</Text>
            </Pressable>
          ) : null}
        </SurfaceCard>
      ) : !token ? (
        <SurfaceCard theme={theme} testID="strategy-connect" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.automationTitle")}</Text>
          <Text style={[styles.hint, { color: theme.muted }]}>{t("agent.valueProp")}</Text>

          <Text style={[styles.eyebrow, { color: theme.faint }]}>{t("agent.availableStrategies")}</Text>
          <View style={[styles.preview, { borderColor: theme.line }]} testID="strategy-preview-dca">
            <View style={styles.previewHead}>
              <Text style={[styles.previewTitle, { color: theme.text }]}>{t("agent.previewDcaTitle")}</Text>
              <Text style={[styles.previewTag, { color: theme.faint, borderColor: theme.lineStrong }]}>
                {t("agent.previewTag")}
              </Text>
            </View>
            <Text style={[styles.previewDesc, { color: theme.muted }]}>{t("agent.previewDcaDesc")}</Text>
          </View>

          <Pressable
            onPress={connect}
            accessibilityRole="button"
            testID="strategy-connect-btn"
            style={[styles.cta, { backgroundColor: theme.brand }]}
          >
            {connecting ? (
              <ActivityIndicator color={theme.bg} />
            ) : (
              <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.connectEnable")}</Text>
            )}
          </Pressable>
          <Text style={[styles.footnote, { color: theme.faint }]}>{t("agent.connectHint")}</Text>
        </SurfaceCard>
      ) : (
        <StrategyPanel
          theme={theme}
          baseUrl={baseUrl as string}
          token={token}
          account={local!.getViemAccount!() as unknown as Account}
          network={network}
        />
      )}
    </ScreenScaffold>
  );
}

function StrategyPanel({
  theme,
  baseUrl,
  token,
  account,
  network,
}: {
  theme: ThemeTokens;
  baseUrl: string;
  token: string;
  account: Account;
  network: "mainnet" | "testnet";
}) {
  const api = useMemo(() => new StrategyApi(baseUrl, token), [baseUrl, token]);
  const t = useT();
  const approve = useMemo(() => {
    const svc = new ExchangeService(createExchangeClient(network, account), buildAssetIndex({ universe: [] }));
    return (req: { agentAddress: string; agentName?: string }) => svc.approveAgent(req);
  }, [network, account]);
  const agentName = useMemo(() => `valid_until ${Date.now() + AGENT_VALIDITY_MS}`, []);
  const ctrl = useStrategyController(api, approve, agentName);

  const [coin, setCoin] = useState("BTC");
  const [amount, setAmount] = useState("");
  const [intervalHours, setIntervalHours] = useState("24");

  async function onApprove() {
    const res = await ctrl.approveAgentFlow();
    if (!res.ok) Alert.alert(res.uncertain ? t("common.uncertainReceipt") : t("agent.approveFailed"), res.error);
  }
  async function onCreate() {
    const q = Number(amount);
    const iv = Number(intervalHours);
    if (!(q > 0) || !(iv > 0)) {
      Alert.alert(t("agent.invalidParams"), t("agent.invalidParamsBody"));
      return;
    }
    await ctrl.createDca({ coin: coin.toUpperCase(), side: "buy", quoteAmountUsdc: q, intervalHours: iv });
    setAmount("");
  }

  return (
    <>
      <SurfaceCard theme={theme} testID="agent-card" style={styles.card}>
        <Text style={[styles.title, { color: theme.text }]}>{t("agent.tradingAgentTitle")}</Text>
        {ctrl.approved ? (
          <>
            <Text style={[styles.mono, { color: theme.muted }]}>
              {shortAddr(ctrl.status.agentAddress ?? "")} · {t("agent.tradeOnly")}
            </Text>
            <Pressable
              onPress={() => void ctrl.revoke()}
              accessibilityRole="button"
              testID="agent-revoke"
              style={[styles.ctaOutline, { borderColor: theme.down }]}
            >
              <Text style={[styles.ctaText, { color: theme.down }]}>{t("agent.revokeAgent")}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={[styles.hint, { color: theme.muted }]}>
              {t("agent.approveHint")}
            </Text>
            <Pressable
              disabled={ctrl.busy}
              onPress={onApprove}
              accessibilityRole="button"
              testID="agent-approve"
              style={[styles.cta, { backgroundColor: theme.brand }]}
            >
              {ctrl.busy ? (
                <ActivityIndicator color={theme.bg} />
              ) : (
                <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.authorize")}</Text>
              )}
            </Pressable>
          </>
        )}
      </SurfaceCard>

      <Text style={[styles.eyebrow, { color: theme.faint }]}>{t("agent.myStrategies")}</Text>
      {ctrl.strategies.length === 0 ? (
        <Text style={[styles.hint, { color: theme.muted }]}>{t("agent.noStrategies")}</Text>
      ) : (
        ctrl.strategies.map((s) => <StrategyRow key={s.id} theme={theme} strategy={s} onToggle={() => void ctrl.toggle(s)} />)
      )}

      <SurfaceCard theme={theme} rule={false} testID="new-dca" style={styles.card}>
        <Text style={[styles.title, { color: theme.text }]}>{t("agent.newDca")}</Text>
        <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="dca-coin" />
        <Field theme={theme} label={t("agent.amountPerBuy")} value={amount} onChangeText={setAmount} keyboard testID="dca-amount" />
        <Field theme={theme} label={t("agent.intervalHours")} value={intervalHours} onChangeText={setIntervalHours} keyboard testID="dca-interval" />
        <Pressable onPress={onCreate} accessibilityRole="button" testID="dca-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
          <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createDca")}</Text>
        </Pressable>
      </SurfaceCard>

      <Pressable onPress={() => void ctrl.killAll()} accessibilityRole="button" testID="kill-switch" style={[styles.ctaOutline, { borderColor: theme.down }]}>
        <Text style={[styles.ctaText, { color: theme.down }]}>{t("agent.pauseAll")}</Text>
      </Pressable>
    </>
  );
}

function StrategyRow({ theme, strategy, onToggle }: { theme: ThemeTokens; strategy: Strategy; onToggle: () => void }) {
  const t = useT();
  return (
    <SurfaceCard theme={theme} rule={false} testID={`strategy-${strategy.id}`} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>{t("agent.strategyDca", { coin: strategy.params.coin })}</Text>
        <Text style={[styles.hint, { color: theme.muted }]}>
          {`$${strategy.params.quoteAmountUsdc} / ${strategy.params.intervalHours}h`}
        </Text>
      </View>
      <Toggle
        theme={theme}
        value={strategy.status === "running"}
        onValueChange={onToggle}
        accessibilityLabel={`toggle-${strategy.id}`}
      />
    </SurfaceCard>
  );
}

function Field({
  theme,
  label,
  value,
  onChangeText,
  keyboard,
  autoCap,
  testID,
}: {
  theme: ThemeTokens;
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboard?: boolean;
  autoCap?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        testID={testID}
        keyboardType={keyboard ? "decimal-pad" : "default"}
        autoCapitalize={autoCap ? "characters" : "none"}
        autoCorrect={false}
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, marginBottom: 12 },
  title: { fontFamily: fonts.display.bold, fontSize: 14, marginBottom: 8 },
  hint: { fontFamily: fonts.body.regular, fontSize: 12, lineHeight: 17, marginBottom: 12 },
  mono: { fontFamily: fonts.mono.regular, fontSize: 12, marginBottom: 12 },
  eyebrow: { fontFamily: fonts.display.bold, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", marginTop: 6, marginBottom: 8 },
  preview: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 16 },
  previewHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  previewTitle: { fontFamily: fonts.display.bold, fontSize: 13.5 },
  previewTag: { fontFamily: fonts.mono.bold, fontSize: 9, letterSpacing: 0.5, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden", textTransform: "uppercase" },
  previewDesc: { fontFamily: fonts.body.regular, fontSize: 12, lineHeight: 17 },
  footnote: { fontFamily: fonts.body.regular, fontSize: 11, lineHeight: 16, marginTop: 10 },
  cta: { paddingVertical: 13, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  ctaOutline: { paddingVertical: 13, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, marginTop: 6, marginBottom: 12 },
  ctaText: { fontFamily: fonts.display.bold, fontSize: 14, letterSpacing: 0.3 },
  row: { flexDirection: "row", alignItems: "center", padding: 14, marginBottom: 8 },
  rowMain: { flex: 1 },
  rowTitle: { fontFamily: fonts.display.bold, fontSize: 13.5 },
  field: { marginBottom: 12 },
  fieldLabel: { fontFamily: fonts.body.regular, fontSize: 11, marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontFamily: fonts.mono.medium, fontSize: 14 },
});
