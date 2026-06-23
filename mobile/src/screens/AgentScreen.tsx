import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Alert, ActivityIndicator } from "react-native";
import { useTheme } from "../theme/useTheme";
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

export function AgentScreen() {
  const theme = useTheme();
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
      Alert.alert("连接失败", e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <ScreenScaffold theme={theme} statusTitle="Strategy" pill={<NetworkWarning variant="chip" />}>
      {!ready ? (
        <SurfaceCard theme={theme} testID="strategy-gated" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>Strategy automation</Text>
          <Text style={[styles.hint, { color: theme.muted }]}>
            {!baseUrl
              ? "服务器策略配置尚未下发，请稍后重试。"
              : "需要本地钱包：请先在「钱包」创建或恢复钱包，再使用自动化。"}
          </Text>
        </SurfaceCard>
      ) : !token ? (
        <SurfaceCard theme={theme} testID="strategy-connect" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>Strategy automation</Text>
          <Text style={[styles.hint, { color: theme.muted }]}>
            连接后由服务器用 trade-only 代理 24/7 执行策略；代理不能提现、主私钥不出设备。
          </Text>
          <Pressable
            onPress={connect}
            accessibilityRole="button"
            testID="strategy-connect-btn"
            style={[styles.cta, { backgroundColor: theme.brand }]}
          >
            {connecting ? (
              <ActivityIndicator color={theme.bg} />
            ) : (
              <Text style={[styles.ctaText, { color: theme.bg }]}>Connect</Text>
            )}
          </Pressable>
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
    if (!res.ok) Alert.alert(res.uncertain ? "回执不确定" : "授权失败", res.error);
  }
  async function onCreate() {
    const q = Number(amount);
    const iv = Number(intervalHours);
    if (!(q > 0) || !(iv > 0)) {
      Alert.alert("参数无效", "请填写正数的金额与周期（小时）");
      return;
    }
    await ctrl.createDca({ coin: coin.toUpperCase(), side: "buy", quoteAmountUsdc: q, intervalHours: iv });
    setAmount("");
  }

  return (
    <>
      <SurfaceCard theme={theme} testID="agent-card" style={styles.card}>
        <Text style={[styles.title, { color: theme.text }]}>Trading agent</Text>
        {ctrl.approved ? (
          <>
            <Text style={[styles.mono, { color: theme.muted }]}>
              {shortAddr(ctrl.status.agentAddress ?? "")} · trade-only
            </Text>
            <Pressable
              onPress={() => void ctrl.revoke()}
              accessibilityRole="button"
              testID="agent-revoke"
              style={[styles.ctaOutline, { borderColor: theme.down }]}
            >
              <Text style={[styles.ctaText, { color: theme.down }]}>Revoke agent</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={[styles.hint, { color: theme.muted }]}>
              授权一个只能交易、不能提现的代理，由服务器替你执行策略。
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
                <Text style={[styles.ctaText, { color: theme.bg }]}>Authorize trading agent</Text>
              )}
            </Pressable>
          </>
        )}
      </SurfaceCard>

      <Text style={[styles.eyebrow, { color: theme.faint }]}>My strategies</Text>
      {ctrl.strategies.length === 0 ? (
        <Text style={[styles.hint, { color: theme.muted }]}>No strategies yet — create a DCA below.</Text>
      ) : (
        ctrl.strategies.map((s) => <StrategyRow key={s.id} theme={theme} strategy={s} onToggle={() => void ctrl.toggle(s)} />)
      )}

      <SurfaceCard theme={theme} rule={false} testID="new-dca" style={styles.card}>
        <Text style={[styles.title, { color: theme.text }]}>New DCA</Text>
        <Field theme={theme} label="Coin" value={coin} onChangeText={setCoin} autoCap testID="dca-coin" />
        <Field theme={theme} label="Amount per buy · USDC" value={amount} onChangeText={setAmount} keyboard testID="dca-amount" />
        <Field theme={theme} label="Interval · hours" value={intervalHours} onChangeText={setIntervalHours} keyboard testID="dca-interval" />
        <Pressable onPress={onCreate} accessibilityRole="button" testID="dca-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
          <Text style={[styles.ctaText, { color: theme.bg }]}>Create DCA</Text>
        </Pressable>
      </SurfaceCard>

      <Pressable onPress={() => void ctrl.killAll()} accessibilityRole="button" testID="kill-switch" style={[styles.ctaOutline, { borderColor: theme.down }]}>
        <Text style={[styles.ctaText, { color: theme.down }]}>Pause all strategies</Text>
      </Pressable>
    </>
  );
}

function StrategyRow({ theme, strategy, onToggle }: { theme: ThemeTokens; strategy: Strategy; onToggle: () => void }) {
  return (
    <SurfaceCard theme={theme} rule={false} testID={`strategy-${strategy.id}`} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>{`${strategy.params.coin} DCA`}</Text>
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
