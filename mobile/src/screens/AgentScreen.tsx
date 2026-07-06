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
import { StrategyApi, type Strategy, type DcaParams, type TwapParams, type TpslParams, type GridParams, type GridLimitParams, type Activity } from "../services/strategyApi";
import { formatTimeHMS } from "../lib/hyperliquid/format";
import { openStrategySession } from "../wallet/walletSession";
import { ExchangeService } from "../services/exchange";
import { createExchangeClient } from "../lib/hyperliquid/client";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { useStrategyController } from "../hooks/useStrategyController";
import type { LocalWalletService } from "../wallet/localWallet";
import type { Account } from "viem";

const AGENT_VALIDITY_MS = 90 * 24 * 3600 * 1000;
type Template = "dca" | "twap" | "tpsl" | "grid" | "gridLimit";

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
  const [template, setTemplate] = useState<Template>("dca");
  const [twapSide, setTwapSide] = useState<"buy" | "sell">("buy");
  const [twapTotal, setTwapTotal] = useState("");
  const [twapSlices, setTwapSlices] = useState("6");
  const [twapDuration, setTwapDuration] = useState("3");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [gridLower, setGridLower] = useState("");
  const [gridUpper, setGridUpper] = useState("");
  const [gridLevels, setGridLevels] = useState("6");
  const [gridPerLevel, setGridPerLevel] = useState("");
  const [gridMode, setGridMode] = useState<"longOnly" | "symmetric">("longOnly");

  const [glLower, setGlLower] = useState("");
  const [glUpper, setGlUpper] = useState("");
  const [glLevels, setGlLevels] = useState("6");
  const [glPerLevel, setGlPerLevel] = useState("");

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
  async function onCreateTwap() {
    const total = Number(twapTotal), slices = Number(twapSlices), dur = Number(twapDuration);
    if (!(total > 0) || !Number.isInteger(slices) || slices < 1 || !(dur > 0)) {
      Alert.alert(t("agent.invalidParams"), t("agent.invalidParamsBody"));
      return;
    }
    await ctrl.createTwap({ coin: coin.toUpperCase(), side: twapSide, totalUsdc: total, slices, durationHours: dur });
    setTwapTotal("");
  }
  async function onCreateTpsl() {
    const tpN = tp ? Number(tp) : undefined;
    const slN = sl ? Number(sl) : undefined;
    const bad =
      (tpN === undefined && slN === undefined) ||
      (tpN !== undefined && !(tpN > 0)) ||
      (slN !== undefined && !(slN > 0));
    if (bad) { Alert.alert(t("agent.invalidParams"), t("agent.tpslNeedsOne")); return; }
    await ctrl.createTpsl({
      coin: coin.toUpperCase(),
      ...(tpN !== undefined ? { takeProfitPrice: tpN } : {}),
      ...(slN !== undefined ? { stopLossPrice: slN } : {}),
    });
    setTp(""); setSl("");
  }
  async function onCreateGrid() {
    const lower = Number(gridLower), upper = Number(gridUpper), levels = Number(gridLevels), perLevel = Number(gridPerLevel);
    if (!(lower > 0) || !(upper > lower) || !Number.isInteger(levels) || levels < 2 || !(perLevel > 0)) {
      Alert.alert(t("agent.invalidParams"), t("agent.invalidGrid"));
      return;
    }
    await ctrl.createGrid({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel, mode: gridMode });
    setGridLower(""); setGridUpper(""); setGridPerLevel("");
  }

  async function onCreateGridLimit() {
    const lower = Number(glLower), upper = Number(glUpper), levels = Number(glLevels), perLevel = Number(glPerLevel);
    if (!(lower > 0) || !(upper > lower) || !Number.isInteger(levels) || levels < 2 || !(perLevel > 0)) {
      Alert.alert(t("agent.invalidParams"), t("agent.invalidGrid"));
      return;
    }
    await ctrl.createGridLimit({ coin: coin.toUpperCase(), lowerPrice: lower, upperPrice: upper, levels, perLevelUsdc: perLevel });
    setGlLower(""); setGlUpper(""); setGlPerLevel("");
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

      <Text style={[styles.eyebrow, { color: theme.faint }]}>{t("agent.recentActivity")}</Text>
      {ctrl.activity.length === 0 ? (
        <Text style={[styles.hint, { color: theme.muted }]}>{t("agent.noActivity")}</Text>
      ) : (
        ctrl.activity.map((a) => <ActivityRow key={a.id} theme={theme} activity={a} />)
      )}

      <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("agent.template")}</Text>
      <View style={styles.segment} testID="template-picker">
        {(["dca", "twap", "tpsl", "grid", "gridLimit"] as Template[]).map((k) => (
          <Pressable
            key={k}
            testID={`template-${k}`}
            accessibilityRole="button"
            onPress={() => setTemplate(k)}
            style={[styles.segmentBtn, { borderColor: theme.line }, template === k && { backgroundColor: theme.surface }]}
          >
            <Text style={[styles.segmentText, { color: template === k ? theme.text : theme.muted }]}>
              {t(
                k === "dca" ? "agent.templateDca"
                : k === "twap" ? "agent.templateTwap"
                : k === "tpsl" ? "agent.templateTpsl"
                : k === "grid" ? "agent.templateGrid"
                : "agent.templateGridLimit",
              )}
            </Text>
          </Pressable>
        ))}
      </View>

      {template === "dca" ? (
        <SurfaceCard theme={theme} rule={false} testID="new-dca" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.newDca")}</Text>
          <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="dca-coin" />
          <Field theme={theme} label={t("agent.amountPerBuy")} value={amount} onChangeText={setAmount} keyboard testID="dca-amount" />
          <Field theme={theme} label={t("agent.intervalHours")} value={intervalHours} onChangeText={setIntervalHours} keyboard testID="dca-interval" />
          <Pressable onPress={onCreate} accessibilityRole="button" testID="dca-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
            <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createDca")}</Text>
          </Pressable>
        </SurfaceCard>
      ) : null}

      {template === "twap" ? (
        <SurfaceCard theme={theme} rule={false} testID="new-twap" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.newTwap")}</Text>
          <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="twap-coin" />
          <View style={styles.sideRow}>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("agent.side")}</Text>
            <View style={styles.sideBtns}>
              {(["buy", "sell"] as const).map((sd) => (
                <Pressable
                  key={sd}
                  testID={`twap-side-${sd}`}
                  accessibilityRole="button"
                  onPress={() => setTwapSide(sd)}
                  style={[styles.sideBtn, { borderColor: theme.line }, twapSide === sd && { backgroundColor: theme.surface }]}
                >
                  <Text style={[styles.segmentText, { color: twapSide === sd ? theme.text : theme.muted }]}>{t(sd === "buy" ? "agent.buy" : "agent.sell")}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Field theme={theme} label={t("agent.totalUsdc")} value={twapTotal} onChangeText={setTwapTotal} keyboard testID="twap-total" />
          <Field theme={theme} label={t("agent.slices")} value={twapSlices} onChangeText={setTwapSlices} keyboard testID="twap-slices" />
          <Field theme={theme} label={t("agent.durationHours")} value={twapDuration} onChangeText={setTwapDuration} keyboard testID="twap-duration" />
          <Pressable onPress={onCreateTwap} accessibilityRole="button" testID="twap-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
            <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createTwap")}</Text>
          </Pressable>
        </SurfaceCard>
      ) : null}

      {template === "tpsl" && (
        <SurfaceCard theme={theme} rule={false} testID="new-tpsl" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.newTpsl")}</Text>
          <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="tpsl-coin" />
          <Field theme={theme} label={t("agent.takeProfit")} value={tp} onChangeText={setTp} keyboard testID="tpsl-tp" />
          <Field theme={theme} label={t("agent.stopLoss")} value={sl} onChangeText={setSl} keyboard testID="tpsl-sl" />
          <Pressable onPress={onCreateTpsl} accessibilityRole="button" testID="tpsl-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
            <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createTpsl")}</Text>
          </Pressable>
        </SurfaceCard>
      )}

      {template === "grid" ? (
        <SurfaceCard theme={theme} rule={false} testID="new-grid" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.newGrid")}</Text>
          <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="grid-coin" />
          <Field theme={theme} label={t("agent.gridLower")} value={gridLower} onChangeText={setGridLower} keyboard testID="grid-lower" />
          <Field theme={theme} label={t("agent.gridUpper")} value={gridUpper} onChangeText={setGridUpper} keyboard testID="grid-upper" />
          <Field theme={theme} label={t("agent.gridLevels")} value={gridLevels} onChangeText={setGridLevels} keyboard testID="grid-levels" />
          <Field theme={theme} label={t("agent.gridPerLevel")} value={gridPerLevel} onChangeText={setGridPerLevel} keyboard testID="grid-per-level" />
          <View style={styles.sideRow}>
            <Text style={[styles.fieldLabel, { color: theme.muted }]}>{t("agent.gridMode")}</Text>
            <View style={styles.sideBtns}>
              {(["longOnly", "symmetric"] as const).map((m) => (
                <Pressable
                  key={m}
                  testID={`grid-mode-${m}`}
                  accessibilityRole="button"
                  onPress={() => setGridMode(m)}
                  style={[styles.sideBtn, { borderColor: theme.line }, gridMode === m && { backgroundColor: theme.surface }]}
                >
                  <Text style={[styles.segmentText, { color: gridMode === m ? theme.text : theme.muted }]}>
                    {t(m === "longOnly" ? "agent.gridModeLongOnly" : "agent.gridModeSymmetric")}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Pressable onPress={onCreateGrid} accessibilityRole="button" testID="grid-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
            <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createGrid")}</Text>
          </Pressable>
        </SurfaceCard>
      ) : null}

      {template === "gridLimit" ? (
        <SurfaceCard theme={theme} rule={false} testID="new-grid-limit" style={styles.card}>
          <Text style={[styles.title, { color: theme.text }]}>{t("agent.newGridLimit")}</Text>
          <Field theme={theme} label={t("agent.coin")} value={coin} onChangeText={setCoin} autoCap testID="grid-limit-coin" />
          <Field theme={theme} label={t("agent.gridLower")} value={glLower} onChangeText={setGlLower} keyboard testID="grid-limit-lower" />
          <Field theme={theme} label={t("agent.gridUpper")} value={glUpper} onChangeText={setGlUpper} keyboard testID="grid-limit-upper" />
          <Field theme={theme} label={t("agent.gridLevels")} value={glLevels} onChangeText={setGlLevels} keyboard testID="grid-limit-levels" />
          <Field theme={theme} label={t("agent.gridPerLevel")} value={glPerLevel} onChangeText={setGlPerLevel} keyboard testID="grid-limit-per-level" />
          <Pressable onPress={onCreateGridLimit} accessibilityRole="button" testID="grid-limit-create" style={[styles.cta, { backgroundColor: theme.brand }]}>
            <Text style={[styles.ctaText, { color: theme.bg }]}>{t("agent.createGridLimit")}</Text>
          </Pressable>
        </SurfaceCard>
      ) : null}

      <Pressable onPress={() => void ctrl.killAll()} accessibilityRole="button" testID="kill-switch" style={[styles.ctaOutline, { borderColor: theme.down }]}>
        <Text style={[styles.ctaText, { color: theme.down }]}>{t("agent.pauseAll")}</Text>
      </Pressable>
    </>
  );
}

function ActivityRow({ theme, activity }: { theme: ThemeTokens; activity: Activity }) {
  const t = useT();
  const buy = activity.side === "buy";
  return (
    <SurfaceCard theme={theme} rule={false} testID={`activity-${activity.id}`} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>
          {activity.coin} · <Text style={{ color: buy ? theme.up : theme.down }}>{buy ? t("agent.buy") : t("agent.sell")}</Text>
        </Text>
        <Text style={[styles.hint, { color: theme.muted }]}>
          {`${activity.sz} @ ${activity.px} · ${formatTimeHMS(activity.time)}`}
        </Text>
      </View>
    </SurfaceCard>
  );
}

function StrategyRow({ theme, strategy, onToggle }: { theme: ThemeTokens; strategy: Strategy; onToggle: () => void }) {
  const t = useT();
  const title =
    strategy.type === "twap" ? t("agent.strategyTwap", { coin: strategy.params.coin })
    : strategy.type === "tpsl" ? t("agent.strategyTpsl", { coin: strategy.params.coin })
    : strategy.type === "grid" ? t("agent.strategyGrid", { coin: (strategy.params as GridParams).coin })
    : strategy.type === "gridLimit" ? t("agent.strategyGridLimit", { coin: (strategy.params as GridLimitParams).coin })
    : t("agent.strategyDca", { coin: (strategy.params as DcaParams).coin });
  const sub =
    strategy.type === "twap"
      ? t("agent.twapProgress", { done: String(strategy.slicesDone ?? 0), total: String((strategy.params as TwapParams).slices), filled: String(Math.round(strategy.filledTotalUsdc ?? 0)) })
      : strategy.type === "tpsl"
      ? [
          (strategy.params as TpslParams).takeProfitPrice ? `${t("agent.takeProfit")} ${(strategy.params as TpslParams).takeProfitPrice}` : "",
          (strategy.params as TpslParams).stopLossPrice ? `${t("agent.stopLoss")} ${(strategy.params as TpslParams).stopLossPrice}` : "",
        ].filter(Boolean).join(" · ")
      : strategy.type === "grid"
      ? t("agent.gridProgress", {
          level: String((strategy.lastLevel ?? 0) + 1),
          levels: String((strategy.params as GridParams).levels),
          filled: String(Math.round(strategy.filledTotalUsdc ?? 0)),
        })
      : strategy.type === "gridLimit"
      ? t("agent.gridLimitProgress", { armed: String(strategy.armedCount ?? 0), holding: String(strategy.holdingCount ?? 0), filled: String(Math.round(strategy.filledTotalUsdc ?? 0)) })
      : `$${(strategy.params as DcaParams).quoteAmountUsdc} / ${(strategy.params as DcaParams).intervalHours}h`;
  const completed = strategy.status === "completed";
  const canceling = strategy.status === "canceling";
  return (
    <SurfaceCard theme={theme} rule={false} testID={`strategy-${strategy.id}`} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>{title}</Text>
        <Text style={[styles.hint, { color: theme.muted }]}>{sub}</Text>
      </View>
      {completed || canceling ? (
        <Text style={[styles.hint, { color: theme.faint }]}>{t(canceling ? "agent.statusCanceling" : "agent.statusCompleted")}</Text>
      ) : (
        <Toggle
          theme={theme}
          value={strategy.status === "running"}
          onValueChange={onToggle}
          accessibilityLabel={`toggle-${strategy.id}`}
        />
      )}
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
  segment: { flexDirection: "row", gap: 8, marginBottom: 12 },
  segmentBtn: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  segmentText: { fontFamily: fonts.display.bold, fontSize: 12 },
  sideRow: { marginBottom: 12 },
  sideBtns: { flexDirection: "row", gap: 8 },
  sideBtn: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  field: { marginBottom: 12 },
  fieldLabel: { fontFamily: fonts.body.regular, fontSize: 11, marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontFamily: fonts.mono.medium, fontSize: 14 },
});
