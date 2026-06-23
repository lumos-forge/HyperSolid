import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Alert, ActivityIndicator } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useMarketStore } from "../state/marketStore";
import { useLedgerStore } from "../state/ledgerStore";
import { useExchangeStore } from "../state/exchangeStore";
import { useUnconfirmedIntents } from "../hooks/useUnconfirmedIntents";
import { createExchangeClient } from "../lib/hyperliquid/client";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { UnconfirmedBanner } from "../components/UnconfirmedBanner";
import { SurfaceCard } from "../components/SurfaceCard";
import { Chip } from "../components/Chip";
import { Toggle } from "../components/Toggle";
import { PriceText, formatPrice } from "../components/PriceText";
import { ChangeText } from "../components/ChangeText";
import { fonts } from "../theme/fonts";
import type { ThemeTokens } from "../theme/tokens";
import type { LocalWalletService } from "../wallet/localWallet";
import type { OrderSide } from "../lib/hyperliquid/buildOrder";
import { validateOrder, rejectionMessage } from "../lib/hyperliquid/order";

type OrderType = "limit" | "market";

const ORDER_TYPES: Array<[OrderType, string]> = [
  ["limit", "Limit"],
  ["market", "Market"],
];

/** Leverage options offered for a market, capped at its max. */
function leverageOptions(maxLeverage: number): number[] {
  return [1, 2, 5, 10, 20, 50].filter((l) => l <= maxLeverage).concat(maxLeverage).filter(
    (l, i, a) => a.indexOf(l) === i && l <= maxLeverage,
  );
}

/** Rough isolated-liquidation estimate (excludes maintenance margin) — clearly labelled "Est.". */
function estLiqPrice(entry: number, leverage: number, side: OrderSide): number {
  if (entry <= 0 || leverage <= 0) return 0;
  return side === "buy" ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);
}

export function TradeScreen() {
  const theme = useTheme();
  const mode = useWalletStore((s) => s.mode);
  const wallet = useWalletStore((s) => s.wallet);
  const network = useEnvStore((s) => s.network);
  const tickers = useMarketStore((s) => s.tickers);
  const ledger = useLedgerStore((s) => s.ledger);
  const { count: unconfirmedCount, intents: unconfirmedIntents } = useUnconfirmedIntents();

  const [coin, setCoin] = useState("BTC");
  const [side, setSide] = useState<OrderSide>("buy");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [leverage, setLeverage] = useState(20);
  const [size, setSize] = useState("");
  const [price, setPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [busy, setBusy] = useState(false);
  // Reused on a retry so the same cloid dedupes; cleared when the order is edited or succeeds.
  const [retryCloid, setRetryCloid] = useState<`0x${string}` | null>(null);
  // The last submit got an uncertain (network/timeout) receipt — exposure is ambiguous (§6.1).
  const [uncertain, setUncertain] = useState(false);

  const ticker = tickers.find((t) => t.coin === coin.toUpperCase());
  const index = useMemo(() => {
    if (tickers.length === 0) return null;
    return buildAssetIndex({
      universe: tickers.map((t) => ({ name: t.coin, szDecimals: t.szDecimals, maxLeverage: t.maxLeverage })),
    });
  }, [tickers]);

  const client = useMemo(() => {
    if (mode !== "local" || !wallet) return null;
    const local = wallet as Partial<LocalWalletService>;
    if (typeof local.getViemAccount !== "function") return null;
    return createExchangeClient(network, local.getViemAccount());
  }, [mode, wallet, network]);

  // Wire the long-lived singleton ExchangeService to the persistent ledger; re-init when the
  // client/index/ledger change (the SAME ledger instance keeps cloid dedup working across submits).
  useEffect(() => {
    if (!client || !index) {
      useExchangeStore.getState().reset();
      return;
    }
    useExchangeStore.getState().init(client, index, ledger ?? undefined);
  }, [client, index, ledger]);

  const notional = (Number(size) || 0) * (Number(price) || 0);
  const hasTp = Number(tpPrice) > 0;
  const hasSl = Number(slPrice) > 0;
  const canSubmit =
    mode === "local" && !!wallet && Number(size) > 0 && Number(price) > 0 && notional >= 10;

  // Editing the order means a new intent — drop any retry cloid / uncertain notice.
  function clearRetry() {
    setRetryCloid(null);
    setUncertain(false);
  }
  function edit<T>(setter: (v: T) => void) {
    return (v: T) => {
      clearRetry();
      setter(v);
    };
  }

  async function onSubmit() {
    if (!wallet || mode !== "local" || !index) return;
    const svc = useExchangeStore.getState().service;
    if (!svc) return;
    const szDec = index.szDecimals(coin.toUpperCase()) ?? 2;
    const rej = validateOrder({ price: Number(price), size: Number(size), szDecimals: szDec });
    if (rej) {
      Alert.alert("订单无效", rejectionMessage(rej));
      return;
    }
    setBusy(true);
    try {
      // §6.2: placeOrder/placeBracket persist the (pending) cloid BEFORE signing and dedupe by cloid.
      const entry = {
        coin: coin.toUpperCase(),
        side,
        size: Number(size),
        price: Number(price),
        reduceOnly: reduceOnly || undefined,
        market: orderType === "market" || undefined,
        tif: postOnly ? ("Alo" as const) : undefined,
        cloid: retryCloid ?? undefined,
      };
      const res =
        hasTp || hasSl
          ? await svc.placeBracket({
              entry,
              takeProfit: hasTp ? { triggerPx: Number(tpPrice) } : undefined,
              stopLoss: hasSl ? { triggerPx: Number(slPrice) } : undefined,
            })
          : await svc.placeOrder(entry);
      if (res.ok) {
        setRetryCloid(null);
        setUncertain(false);
        const note = res.status?.message ?? "已提交";
        Alert.alert("下单成功", `${note} · cloid ${res.cloid.slice(0, 10)}…`);
        setSize("");
      } else if (res.uncertain && res.cloid) {
        // Uncertain receipt: keep the cloid so an explicit retry reuses it (HL dedupes), and tell
        // the user honestly that the order MAY already be live — never silently assume failure.
        setRetryCloid(res.cloid);
        setUncertain(true);
        Alert.alert(
          "回执不确定",
          `${res.error}。订单可能已提交到交易所，请勿重复手动下单；点「重试」会用同一编号(cloid)安全重试。`,
        );
      } else {
        // Definite rejection — terminal. Start fresh next time.
        setRetryCloid(null);
        setUncertain(false);
        Alert.alert("下单失败", res.error);
      }
    } catch (e) {
      Alert.alert("下单异常", e instanceof Error ? e.message : String(e));
    } finally {
      // The ledger mutated (open/markSubmitted/reconcile) — refresh the unconfirmed banner.
      useLedgerStore.getState().bump();
      setBusy(false);
    }
  }

  // Banner "review" action: prime a retry of the most recent unconfirmed intent (same cloid).
  function reviewLatest() {
    if (unconfirmedIntents.length === 0) return;
    const latest = unconfirmedIntents.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
    setRetryCloid(latest.cloid);
    setUncertain(true);
  }

  if (mode !== "local") {
    return (
      <ScreenScaffold
        theme={theme}
        statusTitle="Trade"
        pill={<NetworkWarning variant="chip" />}
      >
        <NetworkWarning variant="strip" />
        <Text style={[styles.msg, { color: theme.muted }]}>
          {mode === "viewOnly"
            ? "Read-only mode can't place orders — create a local wallet in Wallet."
            : "Connect a wallet in Wallet to start trading."}
        </Text>
      </ScreenScaffold>
    );
  }

  const levOptions = leverageOptions(ticker?.maxLeverage ?? 50);
  const liq = estLiqPrice(Number(price), leverage, side);
  const sideColor = side === "buy" ? theme.up : theme.down;
  const ctaLabel = `${side === "buy" ? "Buy / Long" : "Sell / Short"} ${coin.toUpperCase()}`;

  return (
    <ScreenScaffold
      theme={theme}
      statusTitle="Trade"
      pill={<NetworkWarning variant="chip" />}
    >
      <NetworkWarning variant="strip" />
      <UnconfirmedBanner
        theme={theme}
        count={unconfirmedCount}
        onReview={reviewLatest}
        reviewLabel="重试最近一笔"
      />

      <View style={styles.sideRow}>
        {(["buy", "sell"] as const).map((s) => (
          <Pressable
            key={s}
            onPress={() => {
              setRetryCloid(null);
              setUncertain(false);
              setSide(s);
            }}
            accessibilityRole="button"
            style={[
              styles.sideBtn,
              {
                backgroundColor: side === s ? (s === "buy" ? theme.up : theme.down) : theme.surface,
                borderColor: theme.line,
              },
            ]}
          >
            <Text
              style={[
                styles.sideText,
                { color: side === s ? theme.bg : theme.text },
              ]}
            >
              {s === "buy" ? "Buy / Long" : "Sell / Short"}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.typeRow}>
        <View style={styles.typeChips}>
          {ORDER_TYPES.map(([t, label]) => (
            <Chip
              key={t}
              theme={theme}
              label={label}
              active={orderType === t}
              onPress={() => {
                clearRetry();
                setOrderType(t);
              }}
            />
          ))}
        </View>
        {ticker ? (
          <Text style={[styles.lastPx, { color: sideColor }]}>
            {formatPrice(ticker.midPx)}
          </Text>
        ) : null}
      </View>

      <View style={styles.levRow}>
        <Text style={[styles.levLabel, { color: theme.muted }]}>Leverage</Text>
        <View style={styles.levChips}>
          {levOptions.map((l) => (
            <Chip
              key={l}
              theme={theme}
              label={`${l}×`}
              active={leverage === l}
              onPress={() => {
                clearRetry();
                setLeverage(l);
              }}
            />
          ))}
        </View>
      </View>

      <Field label="Symbol" value={coin} onChange={edit(setCoin)} theme={theme} autoCap testID="field-coin" />
      <Field label="Price · USDC" value={price} onChange={edit(setPrice)} theme={theme} keyboard testID="field-price" />
      <Field label={`Size · ${coin.toUpperCase()}`} value={size} onChange={edit(setSize)} theme={theme} keyboard testID="field-size" />

      <Text style={[styles.hint, { color: notional >= 10 ? theme.muted : theme.down }]}>
        Order value ${notional.toFixed(2)} {notional < 10 ? "(min $10)" : ""}
      </Text>

      <View style={styles.opts}>
        <View style={styles.optRow}>
          <Text style={[styles.optLabel, { color: theme.text }]}>Reduce-only</Text>
          <Toggle theme={theme} value={reduceOnly} onValueChange={edit(setReduceOnly)} accessibilityLabel="reduce-only" />
        </View>
        <View style={styles.optRow}>
          <Text style={[styles.optLabel, { color: theme.text }]}>Post-only</Text>
          <Toggle theme={theme} value={postOnly} onValueChange={edit(setPostOnly)} accessibilityLabel="post-only" />
        </View>
      </View>

      <SurfaceCard theme={theme} rule={false} style={styles.tpsl}>
        <View style={styles.tpslHead}>
          <Text style={[styles.tpslTitle, { color: theme.text }]}>Take profit / Stop loss</Text>
          <Text style={[styles.tpslOpt, { color: theme.faint }]}>Optional</Text>
        </View>
        <View style={styles.tpslRow}>
          <View style={styles.tpslField}>
            <Text style={[styles.tpslLabel, { color: theme.muted }]}>TP price</Text>
            <TextInput
              value={tpPrice}
              onChangeText={edit(setTpPrice)}
              testID="field-tp"
              placeholder="—"
              placeholderTextColor={theme.faint}
              keyboardType="decimal-pad"
              style={[styles.tpslInput, { color: theme.up, borderColor: theme.line }]}
            />
          </View>
          <View style={styles.tpslField}>
            <Text style={[styles.tpslLabel, { color: theme.muted }]}>SL price</Text>
            <TextInput
              value={slPrice}
              onChangeText={edit(setSlPrice)}
              testID="field-sl"
              placeholder="—"
              placeholderTextColor={theme.faint}
              keyboardType="decimal-pad"
              style={[styles.tpslInput, { color: theme.down, borderColor: theme.line }]}
            />
          </View>
        </View>
      </SurfaceCard>

      <SurfaceCard theme={theme} rule={false} style={styles.summary}>
        <SummaryRow theme={theme} label="Order value" value={`≈ ${notional.toFixed(2)} USDC`} />
        <SummaryRow theme={theme} label="Leverage" value={`${leverage}× Cross`} />
        <SummaryRow
          theme={theme}
          label="Est. liq. price"
          value={Number(price) > 0 ? formatPrice(liq) : "—"}
        />
      </SurfaceCard>

      {uncertain ? (
        <View style={[styles.uncertain, { borderColor: theme.down, backgroundColor: theme.surface }]}>
          <Text style={[styles.uncertainTitle, { color: theme.down }]}>上一笔回执不确定</Text>
          <Text style={[styles.uncertainBody, { color: theme.muted }]}>
            网络/超时导致回执不确定，订单可能已提交到交易所。请勿重复手动下单；点「重试」会用同一编号(cloid)安全重试，由交易所按 cloid 去重。
          </Text>
          <Pressable
            disabled={busy}
            onPress={onSubmit}
            accessibilityRole="button"
            testID="retry-order"
            style={[styles.retry, { borderColor: theme.brand }]}
          >
            {busy ? (
              <ActivityIndicator color={theme.brand} />
            ) : (
              <Text style={[styles.retryText, { color: theme.brand }]}>重试（复用同一 cloid）</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      <Pressable
        disabled={!canSubmit || busy}
        onPress={onSubmit}
        accessibilityRole="button"
        testID="submit-order"
        style={[styles.submit, { backgroundColor: canSubmit ? sideColor : theme.line }]}
      >
        {busy ? (
          <ActivityIndicator color={theme.bg} />
        ) : (
          <Text style={[styles.submitText, { color: canSubmit ? theme.bg : theme.muted }]}>{ctaLabel}</Text>
        )}
      </Pressable>
    </ScreenScaffold>
  );
}

function SummaryRow({ theme, label, value }: { theme: ThemeTokens; label: string; value: string }) {
  return (
    <View style={styles.sumRow}>
      <Text style={[styles.sumLabel, { color: theme.muted }]}>{label}</Text>
      <Text style={[styles.sumValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  theme,
  keyboard,
  autoCap,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  theme: ThemeTokens;
  keyboard?: boolean;
  autoCap?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        testID={testID}
        keyboardType={keyboard ? "decimal-pad" : "default"}
        autoCapitalize={autoCap ? "characters" : "none"}
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.surface }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  msg: { fontFamily: fonts.body.regular, fontSize: 14, marginTop: 10 },
  sideRow: { flexDirection: "row", gap: 10, marginBottom: 14, marginTop: 4 },
  sideBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center", borderWidth: 1 },
  sideText: { fontFamily: fonts.display.bold, fontSize: 14, letterSpacing: 0.3 },
  typeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  typeChips: { flexDirection: "row", gap: 7 },
  lastPx: { fontFamily: fonts.mono.bold, fontSize: 13 },
  levRow: { marginBottom: 14 },
  levLabel: { fontFamily: fonts.body.regular, fontSize: 11, marginBottom: 6 },
  levChips: { flexDirection: "row", gap: 7, flexWrap: "wrap" },
  field: { marginBottom: 12 },
  label: { fontFamily: fonts.body.regular, fontSize: 11, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.mono.medium,
    fontSize: 14,
  },
  hint: { fontFamily: fonts.mono.regular, fontSize: 12, marginBottom: 12 },
  opts: { flexDirection: "row", gap: 24, marginBottom: 14 },
  optRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  optLabel: { fontFamily: fonts.body.medium, fontSize: 12 },
  tpsl: { padding: 12 },
  tpslHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  tpslTitle: { fontFamily: fonts.body.semibold, fontSize: 12.5 },
  tpslOpt: { fontFamily: fonts.body.regular, fontSize: 10.5 },
  tpslRow: { flexDirection: "row", gap: 10 },
  tpslField: { flex: 1 },
  tpslLabel: { fontFamily: fonts.body.regular, fontSize: 10.5, marginBottom: 4 },
  tpslInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: fonts.mono.medium,
    fontSize: 13,
  },
  summary: { padding: 12 },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  sumLabel: { fontFamily: fonts.body.regular, fontSize: 12 },
  sumValue: { fontFamily: fonts.mono.medium, fontSize: 12 },
  uncertain: { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 },
  uncertainTitle: { fontFamily: fonts.body.semibold, fontSize: 13, marginBottom: 4 },
  uncertainBody: { fontFamily: fonts.body.regular, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  retry: { borderWidth: 1, borderRadius: 8, paddingVertical: 11, alignItems: "center" },
  retryText: { fontFamily: fonts.body.semibold, fontSize: 14 },
  submit: { paddingVertical: 15, borderRadius: 12, alignItems: "center", marginTop: 6 },
  submitText: { fontFamily: fonts.display.bold, fontSize: 16, letterSpacing: 0.3 },
});
