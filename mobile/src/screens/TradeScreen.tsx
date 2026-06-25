import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Alert, ActivityIndicator } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useMarketStore } from "../state/marketStore";
import { useLedgerStore } from "../state/ledgerStore";
import { useExchangeStore } from "../state/exchangeStore";
import { useToastStore } from "../state/toastStore";
import { useUnconfirmedIntents } from "../hooks/useUnconfirmedIntents";
import { createExchangeClient, createPositionsInfoClient } from "../lib/hyperliquid/client";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { UnconfirmedBanner } from "../components/UnconfirmedBanner";
import { SurfaceCard } from "../components/SurfaceCard";
import { Chip } from "../components/Chip";
import { SizePercentRow } from "../components/SizePercentRow";
import { PositionsService } from "../services/positionsData";
import { useAvailableBalance } from "../hooks/useAvailableBalance";
import { Toggle } from "../components/Toggle";
import { PriceText, formatPrice } from "../components/PriceText";
import { ChangeText } from "../components/ChangeText";
import { fonts } from "../theme/fonts";
import type { ThemeTokens } from "../theme/tokens";
import type { TranslationKey } from "../i18n/messages";
import type { LocalWalletService } from "../wallet/localWallet";
import type { OrderSide } from "../lib/hyperliquid/buildOrder";
import { validateOrder, clampLeverage, validateTriggerSide, roundSize, formatPrice as toHlPrice } from "../lib/hyperliquid/order";

type OrderType = "limit" | "market" | "stop";

const ORDER_TYPES: Array<[OrderType, TranslationKey]> = [
  ["limit", "trade.typeLimit"],
  ["market", "trade.typeMarket"],
  ["stop", "trade.typeStop"],
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

/**
 * Worst-case bound for a "market" order: it is sent as an IOC limit at mid ± this %, so it fills at
 * the best available price while capping slippage. The user never types a price for market orders.
 */
const MARKET_SLIPPAGE_PCT = 0.05;
function marketPrice(mid: number, side: OrderSide): number {
  return side === "buy" ? mid * (1 + MARKET_SLIPPAGE_PCT) : mid * (1 - MARKET_SLIPPAGE_PCT);
}

export function TradeScreen({ navigation }: { navigation?: { navigate: (name: string) => void } }) {
  const theme = useTheme();
  const t = useT();
  const mode = useWalletStore((s) => s.mode);
  const wallet = useWalletStore((s) => s.wallet);
  const walletAddress = useWalletStore((s) => s.address);
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
  const [priceEdited, setPriceEdited] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
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

  const mid = ticker?.midPx ?? 0;
  const isMarket = orderType === "market";
  // HL lot/tick precision for the active market (perps universe). szDecimals drives both size lot
  // rounding and the price tick (≤5 sig figs AND ≤ 6−szDecimals decimals).
  const szDec = ticker?.szDecimals ?? 2;
  const maxLev = ticker?.maxLeverage ?? 50;
  // Reference price for sizing / liq / notional: live mid for market, the typed price otherwise.
  const refPrice = isMarket ? mid : Number(price) || 0;

  // Keep leverage within the active asset's HL cap (e.g. a 5× market can't carry the 20× default) so
  // the est. liq price is real and the pre-submit setLeverage call won't be rejected.
  useEffect(() => {
    setLeverage((lev) => clampLeverage(lev, maxLev));
  }, [maxLev]);

  // Prefill the limit/stop price with the live mid until the user edits it (reset on coin change),
  // snapped to a valid HL tick so what is shown is exactly what will be sent.
  useEffect(() => {
    if (isMarket || priceEdited) return;
    if (mid > 0) setPrice(toHlPrice(mid, szDec, "perp"));
  }, [coin, mid, isMarket, priceEdited, szDec]);

  const notional = (Number(size) || 0) * refPrice;
  const positionsSvc = useMemo(
    () => new PositionsService(createPositionsInfoClient(network)),
    [network],
  );
  const available = useAvailableBalance(positionsSvc, walletAddress);
  const hasTp = Number(tpPrice) > 0;
  const hasSl = Number(slPrice) > 0;
  const canSubmit =
    mode === "local" && !!wallet && Number(size) > 0 && refPrice > 0 && notional >= 10;

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
  function onChangeCoin(v: string) {
    clearRetry();
    setPriceEdited(false);
    setCoin(v);
  }
  function onChangePrice(v: string) {
    clearRetry();
    setPriceEdited(true);
    setPrice(v);
  }

  async function onSubmit() {
    if (!wallet || mode !== "local" || !index) return;
    const svc = useExchangeStore.getState().service;
    if (!svc) return;
    const szDec = index.szDecimals(coin.toUpperCase()) ?? 2;
    // Market orders never carry a typed price — send IOC at a slippage-bounded price off mid.
    const submitPrice = isMarket ? marketPrice(mid, side) : Number(price);
    const rej = validateOrder({ price: submitPrice, size: Number(size), szDecimals: szDec });
    if (rej) {
      Alert.alert(t("trade.invalidOrder"), t(`reject.${rej}` as never));
      return;
    }
    if (orderType === "stop" && !(Number(stopPrice) > 0)) {
      Alert.alert(t("trade.invalidOrder"), t("trade.stopNeedsTrigger"));
      return;
    }
    // Trigger-side rules (HL badTriggerPxRejected): a stop trigger must sit on the loss side, and
    // bracket TP/SL must straddle entry on the correct sides for the position direction.
    const entryPx = refPrice;
    const triggerChecks: Array<["sl" | "tp", number] | null> = [
      orderType === "stop" ? (["sl", Number(stopPrice)] as ["sl", number]) : null,
      hasTp ? (["tp", Number(tpPrice)] as ["tp", number]) : null,
      hasSl ? (["sl", Number(slPrice)] as ["sl", number]) : null,
    ];
    for (const check of triggerChecks) {
      if (!check) continue;
      const trej = validateTriggerSide({ side, entryPx, triggerPx: check[1], tpsl: check[0] });
      if (trej) {
        Alert.alert(t("trade.invalidOrder"), t(`reject.${trej}` as never));
        return;
      }
    }
    setBusy(true);
    try {
      // HL leverage is per-asset account state, NOT carried on the order — set it to the user's
      // choice before placing so the position uses the intended leverage (and the est. liq price
      // shown is real). Skip for reduce-only (closing doesn't change leverage). Abort on failure
      // rather than silently open at a stale leverage.
      if (!reduceOnly) {
        const lev = await svc.setLeverage(coin.toUpperCase(), leverage, true);
        if (!lev.ok) {
          Alert.alert(t("trade.leverageFailed"), lev.error);
          setBusy(false);
          return;
        }
      }
      // §6.2: placeOrder/placeBracket persist the (pending) cloid BEFORE signing and dedupe by cloid.
      const entry = {
        coin: coin.toUpperCase(),
        side,
        size: Number(size),
        price: submitPrice,
        reduceOnly: reduceOnly || undefined,
        market: orderType === "market" || undefined,
        tif: postOnly ? ("Alo" as const) : undefined,
        trigger:
          orderType === "stop"
            ? { triggerPx: Number(stopPrice), isMarket: false, tpsl: "sl" as const }
            : undefined,
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
        useToastStore.getState().show(t("trade.orderPlaced"), "success");
        setSize("");
      } else if (res.uncertain && res.cloid) {
        // Uncertain receipt: keep the cloid so an explicit retry reuses it (HL dedupes), and tell
        // the user honestly that the order MAY already be live — never silently assume failure.
        setRetryCloid(res.cloid);
        setUncertain(true);
        Alert.alert(t("common.uncertainReceipt"), t("trade.uncertainBody", { error: res.error }));
      } else {
        // Definite rejection — terminal. Start fresh next time.
        setRetryCloid(null);
        setUncertain(false);
        Alert.alert(t("trade.orderFailed"), res.error);
      }
    } catch (e) {
      Alert.alert(t("trade.orderError"), e instanceof Error ? e.message : String(e));
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
        pill={<NetworkWarning variant="chip" />}
      >
        <NetworkWarning variant="strip" />
        <Text style={[styles.msg, { color: theme.muted }]}>
          {mode === "viewOnly"
            ? t("trade.viewOnlyCantTrade")
            : t("trade.connectToTrade")}
        </Text>
        <Pressable
          accessibilityRole="button"
          testID="gated-setup-wallet"
          onPress={() => navigation?.navigate("Account")}
          style={[styles.submit, { backgroundColor: theme.brand, marginTop: 16 }]}
        >
          <Text style={[styles.submitText, { color: theme.bg }]}>{t("common.setUpWallet")}</Text>
        </Pressable>
      </ScreenScaffold>
    );
  }

  const levOptions = leverageOptions(ticker?.maxLeverage ?? 50);
  const liq = estLiqPrice(refPrice, leverage, side);
  const sideColor = side === "buy" ? theme.up : theme.down;
  const ctaLabel = `${t(side === "buy" ? "trade.sideBuy" : "trade.sideSell")} ${coin.toUpperCase()}`;

  // What will actually be sent, snapped to HL tick/lot — surfaced so the user sees exactly what they
  // submit (the encoder applies the same rounding). Market price is the slippage-bounded IOC price.
  const previewSubmitPrice = isMarket ? marketPrice(mid, side) : Number(price);
  const previewPrice = previewSubmitPrice > 0 ? toHlPrice(previewSubmitPrice, szDec, "perp") : "—";
  const previewPriceLabel = isMarket ? `${t("trade.marketCap")} ${previewPrice}` : previewPrice;
  const previewSize = Number(size) > 0 ? String(roundSize(Number(size), szDec)) : "—";

  return (
    <ScreenScaffold
      theme={theme}
      pill={<NetworkWarning variant="chip" />}
    >
      <NetworkWarning variant="strip" />
      <UnconfirmedBanner
        theme={theme}
        count={unconfirmedCount}
        onReview={reviewLatest}
        reviewLabel={t("trade.retryLatest")}
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
              {t(s === "buy" ? "trade.sideBuy" : "trade.sideSell")}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.typeRow}>
        <View style={styles.typeChips}>
          {ORDER_TYPES.map(([type, labelKey]) => (
            <Chip
              key={type}
              theme={theme}
              label={t(labelKey)}
              active={orderType === type}
              onPress={() => {
                clearRetry();
                setOrderType(type);
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
        <View style={styles.levHead}>
          <Text style={[styles.levLabel, { color: theme.muted }]}>{t("trade.leverage")}</Text>
          <Text style={[styles.levMax, { color: theme.faint }]}>{t("trade.leverageMax", { max: maxLev })}</Text>
        </View>
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

      <Field label={t("trade.symbol")} value={coin} onChange={onChangeCoin} theme={theme} autoCap testID="field-coin" />
      {isMarket ? (
        <Text style={[styles.marketNote, { color: theme.muted }]}>{t("trade.marketPriceNote")}</Text>
      ) : (
        <Field label={t("trade.priceUsdc")} value={price} onChange={onChangePrice} theme={theme} keyboard testID="field-price" />
      )}
      {orderType === "stop" ? (
        <Field label={t("trade.triggerPriceUsdc")} value={stopPrice} onChange={edit(setStopPrice)} theme={theme} keyboard testID="field-stop" />
      ) : null}
      <Field label={t("trade.size", { coin: coin.toUpperCase() })} value={size} onChange={edit(setSize)} theme={theme} keyboard testID="field-size" />

      <SizePercentRow
        theme={theme}
        available={available}
        leverage={leverage}
        price={Number(price)}
        onPick={edit(setSize)}
      />

      <Text style={[styles.hint, { color: notional >= 10 ? theme.muted : theme.down }]}>
        {t("trade.orderValueHint", { value: notional.toFixed(2) })} {notional < 10 ? t("trade.minTen") : ""}
      </Text>

      <Text style={[styles.preview, { color: theme.faint }]} testID="submit-preview">
        {t("trade.submitPreview", { price: previewPriceLabel, size: previewSize, coin: coin.toUpperCase() })}
      </Text>

      <View style={styles.opts}>
        <View style={styles.optRow}>
          <Text style={[styles.optLabel, { color: theme.text }]}>{t("positions.reduceOnly")}</Text>
          <Toggle theme={theme} value={reduceOnly} onValueChange={edit(setReduceOnly)} accessibilityLabel="reduce-only" />
        </View>
        <View style={styles.optRow}>
          <Text style={[styles.optLabel, { color: theme.text }]}>{t("trade.postOnly")}</Text>
          <Toggle theme={theme} value={postOnly} onValueChange={edit(setPostOnly)} accessibilityLabel="post-only" />
        </View>
      </View>

      <SurfaceCard theme={theme} rule={false} style={styles.tpsl}>
        <View style={styles.tpslHead}>
          <Text style={[styles.tpslTitle, { color: theme.text }]}>{t("trade.tpSlTitle")}</Text>
          <Text style={[styles.tpslOpt, { color: theme.faint }]}>{t("trade.optional")}</Text>
        </View>
        <View style={styles.tpslRow}>
          <View style={styles.tpslField}>
            <Text style={[styles.tpslLabel, { color: theme.muted }]}>{t("trade.tpPrice")}</Text>
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
            <Text style={[styles.tpslLabel, { color: theme.muted }]}>{t("trade.slPrice")}</Text>
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
        <SummaryRow theme={theme} label={t("trade.summaryOrderValue")} value={`≈ ${notional.toFixed(2)} USDC`} />
        <SummaryRow theme={theme} label={t("trade.leverage")} value={`${leverage}× ${t("positions.cross")}`} />
        <SummaryRow
          theme={theme}
          label={t("trade.estLiqPrice")}
          value={refPrice > 0 ? formatPrice(liq) : "—"}
        />
      </SurfaceCard>

      {uncertain ? (
        <View style={[styles.uncertain, { borderColor: theme.down, backgroundColor: theme.surface }]}>
          <Text style={[styles.uncertainTitle, { color: theme.down }]}>{t("trade.lastUncertainTitle")}</Text>
          <Text style={[styles.uncertainBody, { color: theme.muted }]}>
            {t("trade.uncertainNotice")}
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
              <Text style={[styles.retryText, { color: theme.brand }]}>{t("trade.retrySameCloid")}</Text>
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
  marketNote: { fontFamily: fonts.body.regular, fontSize: 12, marginBottom: 12 },
  levRow: { marginBottom: 14 },
  levHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  levLabel: { fontFamily: fonts.body.regular, fontSize: 11 },
  levMax: { fontFamily: fonts.mono.regular, fontSize: 10.5 },
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
  preview: { fontFamily: fonts.mono.regular, fontSize: 11.5, marginTop: -6, marginBottom: 14 },
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
