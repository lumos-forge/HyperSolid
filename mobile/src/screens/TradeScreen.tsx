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
import { Dropdown } from "../components/Dropdown";
import { PairHeader } from "../components/PairHeader";
import { CoinPicker } from "../components/CoinPicker";
import { MarginLeverageBar } from "../components/MarginLeverageBar";
import { Slider } from "../components/Slider";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { TradeActivityPanel } from "../components/TradeActivityPanel";
import { PositionsService } from "../services/positionsData";
import { useAvailableBalance } from "../hooks/useAvailableBalance";
import { useCoinPosition } from "../hooks/useCoinPosition";
import { Toggle } from "../components/Toggle";
import { Checkbox } from "../components/Checkbox";
import { PriceText, formatPrice } from "../components/PriceText";
import { ChangeText } from "../components/ChangeText";
import { Icon } from "../components/Icon";
import { withAlpha } from "../theme/color";
import { fonts } from "../theme/fonts";
import type { ThemeTokens } from "../theme/tokens";
import type { TranslationKey } from "../i18n/messages";
import type { LocalWalletService } from "../wallet/localWallet";
import type { OrderSide, TimeInForce } from "../lib/hyperliquid/buildOrder";
import { validateOrder, clampLeverage, validateTriggerSide, roundSize, formatPrice as toHlPrice } from "../lib/hyperliquid/order";
import {
  orderTypeShape,
  toBaseSize,
  requiredMargin,
  TAKER_FEE_RATE,
  MAKER_FEE_RATE,
  type TicketOrderType,
  type SizeUnit,
} from "../lib/hyperliquid/orderForm";

const ORDER_TYPES: Array<[TicketOrderType, TranslationKey]> = [
  ["market", "trade.typeMarket"],
  ["limit", "trade.typeLimit"],
  ["stopLimit", "trade.typeStopLimit"],
  ["stopMarket", "trade.typeStopMarket"],
  ["tpLimit", "trade.typeTpLimit"],
  ["tpMarket", "trade.typeTpMarket"],
  ["twap", "trade.typeTwap"],
  ["scale", "trade.typeScale"],
];

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
  // The last side a submit was attempted with — drives the uncertain-receipt retry (no side toggle;
  // the two buy/sell buttons each submit their own side).
  const [pendingSide, setPendingSide] = useState<OrderSide>("buy");
  const [orderType, setOrderType] = useState<TicketOrderType>("limit");
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>("base");
  const [leverage, setLeverage] = useState(20);
  const [isCross, setIsCross] = useState(true);
  const [showCoinPicker, setShowCoinPicker] = useState(false);
  const [size, setSize] = useState("");
  const [price, setPrice] = useState("");
  const [priceEdited, setPriceEdited] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tif, setTif] = useState<TimeInForce>("Gtc");
  const [tpSlOn, setTpSlOn] = useState(false);
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [twapMinutes, setTwapMinutes] = useState("30");
  const [twapRandomize, setTwapRandomize] = useState(false);
  const [scaleStart, setScaleStart] = useState("");
  const [scaleEnd, setScaleEnd] = useState("");
  const [scaleCount, setScaleCount] = useState("5");
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
  const shape = orderTypeShape(orderType);
  const isMarketType = orderType === "market";
  const isTwap = orderType === "twap";
  const isScale = orderType === "scale";
  // Whether a limit price field is shown/used (Market & *-Market trigger types fill at market).
  const usesLimitPrice = shape.usesLimitPrice;
  // HL lot/tick precision for the active market (perps universe). szDecimals drives both size lot
  // rounding and the price tick (≤5 sig figs AND ≤ 6−szDecimals decimals).
  const szDec = ticker?.szDecimals ?? 2;
  const maxLev = ticker?.maxLeverage ?? 50;
  // Reference price for sizing / liq / notional: the typed limit price when used, else live mid.
  const refPrice = usesLimitPrice ? Number(price) || 0 : mid;

  // Keep leverage within the active asset's HL cap (e.g. a 5× market can't carry the 20× default) so
  // the est. liq price is real and the pre-submit setLeverage call won't be rejected.
  useEffect(() => {
    setLeverage((lev) => clampLeverage(lev, maxLev));
  }, [maxLev]);

  // Prefill the limit price with the live mid until the user edits it (reset on coin change),
  // snapped to a valid HL tick so what is shown is exactly what will be sent.
  useEffect(() => {
    if (!usesLimitPrice || priceEdited) return;
    if (mid > 0) setPrice(toHlPrice(mid, szDec, "perp"));
  }, [coin, mid, usesLimitPrice, priceEdited, szDec]);

  // Size is entered in base (coin) or quote (USDC); the order always uses base size.
  const baseSize = toBaseSize(sizeUnit, Number(size) || 0, refPrice);
  const notional = baseSize * refPrice;
  const margin = requiredMargin(notional, leverage);
  const positionsSvc = useMemo(
    () => new PositionsService(createPositionsInfoClient(network)),
    [network],
  );
  const available = useAvailableBalance(positionsSvc, walletAddress);
  const coinPosition = useCoinPosition(positionsSvc, walletAddress, coin);
  const hasTp = tpSlOn && Number(tpPrice) > 0;
  const hasSl = tpSlOn && Number(slPrice) > 0;
  const canSubmit =
    mode === "local" && !!wallet && baseSize > 0 && refPrice > 0 && notional >= 10;

  // Max openable size (base) = available × leverage / price; the slider maps a 0–100% of this (in the
  // active size unit) onto the size field, and the "Max" row shows the base ceiling.
  const maxBase = available && refPrice > 0 ? (available * leverage) / refPrice : 0;
  const maxInUnit = sizeUnit === "quote" ? (available ?? 0) * leverage : maxBase;
  const sizePct = maxInUnit > 0 ? Math.min(100, ((Number(size) || 0) / maxInUnit) * 100) : 0;
  function onSlide(pct: number) {
    if (maxInUnit <= 0) return;
    clearRetry();
    setSize(((pct / 100) * maxInUnit).toString());
  }

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

  // Place-order handler driven by the two HL-style buy/sell buttons (no separate side toggle). The
  // side is passed explicitly so a button submits its own side immediately (no stale state).
  async function onSubmit(orderSide: OrderSide) {
    if (!wallet || mode !== "local" || !index) return;
    const svc = useExchangeStore.getState().service;
    if (!svc) return;
    setPendingSide(orderSide);

    // TWAP: native HL twapOrder (no cloid). Set leverage first (unless reduce-only), then start.
    if (isTwap) {
      const minutes = Number(twapMinutes);
      if (!(baseSize > 0)) {
        Alert.alert(t("trade.invalidOrder"), t("reject.sizeRejected"));
        return;
      }
      if (!(minutes >= 5 && minutes <= 1440)) {
        Alert.alert(t("trade.invalidOrder"), t("trade.invalidTwap"));
        return;
      }
      setBusy(true);
      try {
        if (!reduceOnly) {
          const lev = await svc.setLeverage(coin.toUpperCase(), leverage, isCross);
          if (!lev.ok) {
            Alert.alert(t("trade.leverageFailed"), lev.error);
            setBusy(false);
            return;
          }
        }
        const res = await svc.placeTwap({
          coin: coin.toUpperCase(),
          side: orderSide,
          size: baseSize,
          minutes,
          randomize: twapRandomize,
          reduceOnly: reduceOnly || undefined,
        });
        if (res.ok) {
          useToastStore.getState().show(t("trade.twapPlaced"), "success");
          setSize("");
        } else if (res.uncertain) {
          Alert.alert(t("common.uncertainReceipt"), res.error);
        } else {
          Alert.alert(t("trade.orderFailed"), res.error);
        }
      } catch (e) {
        Alert.alert(t("trade.orderError"), e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    // Scale: N laddered limit orders (one signed order action, cloid-deduped like a normal order).
    if (isScale) {
      const startPx = Number(scaleStart);
      const endPx = Number(scaleEnd);
      const count = Number(scaleCount);
      if (!(baseSize > 0)) {
        Alert.alert(t("trade.invalidOrder"), t("reject.sizeRejected"));
        return;
      }
      if (!(startPx > 0 && endPx > 0 && count >= 2)) {
        Alert.alert(t("trade.invalidOrder"), t("trade.invalidScale"));
        return;
      }
      setBusy(true);
      try {
        if (!reduceOnly) {
          const lev = await svc.setLeverage(coin.toUpperCase(), leverage, isCross);
          if (!lev.ok) {
            Alert.alert(t("trade.leverageFailed"), lev.error);
            setBusy(false);
            return;
          }
        }
        const res = await svc.placeScale({
          coin: coin.toUpperCase(),
          side: orderSide,
          totalSize: baseSize,
          startPx,
          endPx,
          count,
          reduceOnly: reduceOnly || undefined,
          tif,
          cloid: retryCloid ?? undefined,
        });
        if (res.ok) {
          setRetryCloid(null);
          setUncertain(false);
          useToastStore.getState().show(t("trade.orderPlaced"), "success");
          setSize("");
        } else if (res.uncertain && res.cloid) {
          setRetryCloid(res.cloid);
          setUncertain(true);
          Alert.alert(t("common.uncertainReceipt"), t("trade.uncertainBody", { error: res.error }));
        } else {
          setRetryCloid(null);
          setUncertain(false);
          Alert.alert(t("trade.orderFailed"), res.error);
        }
      } catch (e) {
        Alert.alert(t("trade.orderError"), e instanceof Error ? e.message : String(e));
      } finally {
        useLedgerStore.getState().bump();
        setBusy(false);
      }
      return;
    }

    const szDec = index.szDecimals(coin.toUpperCase()) ?? 2;
    // Resolve the price actually sent: limit-style types use the typed limit price; market and the
    // *-Market trigger types fill at a slippage-bounded IOC price (off mid, or off the trigger).
    const submitPrice = usesLimitPrice
      ? Number(price)
      : shape.isTrigger
        ? marketPrice(Number(stopPrice), orderSide)
        : marketPrice(mid, orderSide);
    const rej = validateOrder({ price: submitPrice, size: baseSize, szDecimals: szDec });
    if (rej) {
      Alert.alert(t("trade.invalidOrder"), t(`reject.${rej}` as never));
      return;
    }
    if (shape.isTrigger && !(Number(stopPrice) > 0)) {
      Alert.alert(t("trade.invalidOrder"), t("trade.stopNeedsTrigger"));
      return;
    }
    // Trigger-side rules (HL badTriggerPxRejected): the order's own trigger is checked against the
    // mark (mid); bracket TP/SL legs (limit/market entries only) straddle the entry price.
    const useBracket = !shape.isTrigger && (hasTp || hasSl);
    const triggerChecks: Array<["sl" | "tp", number, number] | null> = [
      shape.isTrigger ? [shape.tpsl, Number(stopPrice), mid] : null,
      useBracket && hasTp ? ["tp", Number(tpPrice), refPrice] : null,
      useBracket && hasSl ? ["sl", Number(slPrice), refPrice] : null,
    ];
    for (const check of triggerChecks) {
      if (!check) continue;
      const [tpsl, triggerPx, entryPx] = check;
      const trej = validateTriggerSide({ side: orderSide, entryPx, triggerPx, tpsl });
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
        const lev = await svc.setLeverage(coin.toUpperCase(), leverage, isCross);
        if (!lev.ok) {
          Alert.alert(t("trade.leverageFailed"), lev.error);
          setBusy(false);
          return;
        }
      }
      // §6.2: placeOrder/placeBracket persist the (pending) cloid BEFORE signing and dedupe by cloid.
      const entry = {
        coin: coin.toUpperCase(),
        side: orderSide,
        size: baseSize,
        price: submitPrice,
        reduceOnly: reduceOnly || undefined,
        market: isMarketType || undefined,
        tif,
        trigger: shape.isTrigger
          ? { triggerPx: Number(stopPrice), isMarket: shape.triggerIsMarket, tpsl: shape.tpsl }
          : undefined,
        cloid: retryCloid ?? undefined,
      };
      const res = useBracket
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

  // Estimated liquidation for both directions (shown per side near each buy/sell button).
  const liqBuy = estLiqPrice(refPrice, leverage, "buy");
  const liqSell = estLiqPrice(refPrice, leverage, "sell");

  // What will actually be sent, snapped to HL tick/lot — surfaced so the user sees exactly what they
  // submit (the encoder applies the same rounding). Market/trigger-market fill at market.
  const previewPrice = usesLimitPrice && Number(price) > 0 ? toHlPrice(Number(price), szDec, "perp") : null;
  const previewSize = baseSize > 0 ? String(roundSize(baseSize, szDec)) : "—";
  const previewPriceLabel = previewPrice ?? t("trade.marketCap");

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

      <PairHeader
        theme={theme}
        coin={coin}
        maxLeverage={maxLev}
        changePct={ticker?.changePct ?? 0}
        onPress={() => setShowCoinPicker(true)}
      />

      <View style={styles.columns}>
        <View style={styles.leftCol}>
          <MarginLeverageBar
        theme={theme}
        isCross={isCross}
        onToggleCross={() => {
          clearRetry();
          setIsCross((c) => !c);
        }}
        leverage={leverage}
        maxLeverage={maxLev}
        onSetLeverage={(l) => {
          clearRetry();
          setLeverage(l);
        }}
      />

      <View style={styles.availRow}>
        <Text style={[styles.availLabel, { color: theme.muted }]}>{t("trade.available")}</Text>
        <View style={styles.availRight}>
          <Text style={[styles.availValue, { color: theme.text }]}>
            {available != null ? `${available.toFixed(2)} USDC` : "—"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("trade.deposit")}
            testID="deposit-shortcut"
            hitSlop={8}
            onPress={() => navigation?.navigate("Account")}
            style={[styles.depositBtn, { borderColor: theme.line }]}
          >
            <Icon name="plus" color={theme.brand} size={15} />
          </Pressable>
        </View>
      </View>

      <Dropdown
        testID="order-type"
        center
        value={orderType}
        options={ORDER_TYPES.map(([type, labelKey]) => ({ value: type, label: t(labelKey) }))}
        onChange={(v) => {
          clearRetry();
          setOrderType(v);
        }}
      />
      {usesLimitPrice ? (
        <View style={styles.priceRow}>
          <InlineField
            label={t("trade.priceUsdc")}
            value={price}
            onChange={onChangePrice}
            theme={theme}
            testID="field-price"
            style={styles.priceField}
          />
          {mid > 0 ? (
            <Pressable
              accessibilityRole="button"
              testID="price-mid"
              onPress={() => onChangePrice(toHlPrice(mid, szDec, "perp"))}
              style={[styles.bboBox, { borderColor: theme.line, backgroundColor: theme.surface }]}
            >
              <Text style={[styles.bboText, { color: theme.muted }]}>{t("trade.bbo")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {shape.isTrigger ? (
        <InlineField label={t("trade.triggerPriceUsdc")} value={stopPrice} onChange={edit(setStopPrice)} theme={theme} testID="field-stop" />
      ) : null}
      {isScale ? (
        <>
          <InlineField label={t("trade.scaleStart")} value={scaleStart} onChange={edit(setScaleStart)} theme={theme} testID="field-scale-start" />
          <InlineField label={t("trade.scaleEnd")} value={scaleEnd} onChange={edit(setScaleEnd)} theme={theme} testID="field-scale-end" />
          <InlineField label={t("trade.scaleCount")} value={scaleCount} onChange={edit(setScaleCount)} theme={theme} testID="field-scale-count" />
        </>
      ) : null}
      {isTwap ? (
        <>
          <InlineField label={t("trade.twapMinutes")} value={twapMinutes} onChange={edit(setTwapMinutes)} theme={theme} testID="field-twap-minutes" />
          <View style={styles.optRow}>
            <Text style={[styles.optLabel, { color: theme.text }]}>{t("trade.twapRandomize")}</Text>
            <Toggle theme={theme} value={twapRandomize} onValueChange={edit(setTwapRandomize)} accessibilityLabel="twap-randomize" />
          </View>
        </>
      ) : null}
      <InlineField
        label={t("trade.sizeLabel")}
        value={size}
        onChange={edit(setSize)}
        theme={theme}
        testID="field-size"
        placeholderAsLabel
        rightInside={
          <Dropdown
            compact
            bare
            testID="size-unit"
            value={sizeUnit}
            options={[
              { value: "base" as const, label: coin.toUpperCase() },
              { value: "quote" as const, label: "USDC" },
            ]}
            onChange={(u) => {
              clearRetry();
              setSize("");
              setSizeUnit(u);
            }}
          />
        }
      />

      {coinPosition ? (
        <Text style={[styles.posContext, { color: theme.muted }]} testID="coin-position">
          {t("trade.currentPosition", {
            size: `${coinPosition.side === "short" ? "-" : ""}${coinPosition.size.toFixed(szDec)}`,
            coin: coin.toUpperCase(),
          })}
        </Text>
      ) : null}

      <Slider value={sizePct} onChange={onSlide} testID="size-slider" />

      <View style={styles.optsCol}>
        {!shape.isTrigger && !isTwap && !isScale ? (
          <Checkbox
            theme={theme}
            value={tpSlOn}
            onValueChange={edit(setTpSlOn)}
            label={t("trade.tpSl")}
            accessibilityLabel="tpsl-toggle"
          />
        ) : null}
        <View style={styles.reduceRow}>
          <Checkbox
            theme={theme}
            value={reduceOnly}
            onValueChange={edit(setReduceOnly)}
            label={t("positions.reduceOnly")}
            accessibilityLabel="reduce-only"
          />
          {usesLimitPrice ? (
            <Dropdown
              compact
              prefix="TIF"
              testID="tif"
              value={tif}
              options={[
                { value: "Gtc" as const, label: t("trade.tifGtc") },
                { value: "Ioc" as const, label: t("trade.tifIoc") },
                { value: "Alo" as const, label: t("trade.tifAlo") },
              ]}
              onChange={(v) => {
                clearRetry();
                setTif(v);
              }}
            />
          ) : null}
        </View>
      </View>

      {!shape.isTrigger && !isTwap && !isScale && tpSlOn ? (
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
      ) : null}

      {baseSize > 0 && notional < 10 ? (
        <Text style={[styles.belowMin, { color: theme.warn }]}>{t("trade.belowMin")}</Text>
      ) : null}

      {uncertain ? (
        <View style={[styles.uncertain, { borderColor: theme.down, backgroundColor: theme.surface }]}>
          <Text style={[styles.uncertainTitle, { color: theme.down }]}>{t("trade.lastUncertainTitle")}</Text>
          <Text style={[styles.uncertainBody, { color: theme.muted }]}>
            {t("trade.uncertainNotice")}
          </Text>
          <Pressable
            disabled={busy}
            onPress={() => onSubmit(pendingSide)}
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

      {(["buy", "sell"] as const).map((s) => {
        const sideColor = s === "buy" ? theme.up : theme.down;
        const liq = s === "buy" ? liqBuy : liqSell;
        return (
        <View key={s} style={styles.sideBlock}>
          <SummaryRow theme={theme} label={t("trade.requiredMargin")} value={`≈ ${margin.toFixed(2)} USDC`} />
          <SummaryRow
            theme={theme}
            label={t(s === "buy" ? "trade.maxLong" : "trade.maxShort")}
            value={maxBase > 0 ? `${maxBase.toFixed(szDec)} ${coin.toUpperCase()}` : "—"}
          />
          {liq > 0 ? (
            <Text style={[styles.liqLine, { color: theme.faint }]}>
              {t("trade.liqShort", { price: formatPrice(liq) })}
            </Text>
          ) : null}
          <Pressable
            disabled={!canSubmit || busy}
            onPress={() => onSubmit(s)}
            accessibilityRole="button"
            testID={s === "buy" ? "submit-buy" : "submit-sell"}
            style={[
              styles.submitBtn,
              canSubmit
                ? { backgroundColor: sideColor, borderColor: sideColor }
                : { backgroundColor: withAlpha(sideColor, 0.14), borderColor: withAlpha(sideColor, 0.45) },
            ]}
          >
            {busy && pendingSide === s ? (
              <ActivityIndicator color={theme.bg} />
            ) : (
              <Text
                style={[styles.submitText, { color: canSubmit ? theme.bg : withAlpha(sideColor, 0.85) }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {t(s === "buy" ? "trade.sideBuy" : "trade.sideSell")}
              </Text>
            )}
          </Pressable>
        </View>
        );
      })}
        </View>

        <View style={styles.rightCol}>
          <OrderBookPanel
            theme={theme}
            coin={coin.toUpperCase()}
            network={network}
            ticker={ticker}
            onPickPrice={(px) => usesLimitPrice && onChangePrice(toHlPrice(px, szDec, "perp"))}
          />
        </View>
      </View>

      <TradeActivityPanel theme={theme} address={walletAddress} network={network} />

      <CoinPicker
        visible={showCoinPicker}
        tickers={tickers}
        onSelect={onChangeCoin}
        onClose={() => setShowCoinPicker(false)}
      />
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

function InlineField({
  label,
  value,
  onChange,
  theme,
  testID,
  keyboard = true,
  autoCap,
  placeholderAsLabel = false,
  rightInside,
  style,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  theme: ThemeTokens;
  testID?: string;
  keyboard?: boolean;
  autoCap?: boolean;
  placeholderAsLabel?: boolean;
  rightInside?: React.ReactNode;
  style?: object;
}) {
  return (
    <View style={[styles.inlineBox, { borderColor: theme.line, backgroundColor: theme.surface }, style]}>
      <View style={styles.inlineMain}>
        {placeholderAsLabel ? null : <Text style={[styles.inlineLabel, { color: theme.muted }]}>{label}</Text>}
        <TextInput
          value={value}
          onChangeText={onChange}
          testID={testID}
          keyboardType={keyboard ? "decimal-pad" : "default"}
          autoCapitalize={autoCap ? "characters" : "none"}
          placeholder={placeholderAsLabel ? label : "0"}
          placeholderTextColor={theme.faint}
          style={[placeholderAsLabel ? styles.inlinePlaceholderInput : styles.inlineInput, { color: theme.text }]}
        />
      </View>
      {rightInside ? <View style={[styles.inlineDivider, { backgroundColor: theme.line }]} /> : null}
      {rightInside}
    </View>
  );
}

const styles = StyleSheet.create({
  msg: { fontFamily: fonts.body.regular, fontSize: 14, marginTop: 10 },
  columns: { flexDirection: "row", gap: 12 },
  leftCol: { flex: 1.25 },
  rightCol: { flex: 1, paddingTop: 2 },
  submit: { paddingVertical: 15, borderRadius: 12, alignItems: "center" },
  priceHeader: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 12 },
  priceHeaderLabel: { fontFamily: fonts.display.bold, fontSize: 13, letterSpacing: 0.3 },
  lastPx: { fontFamily: fonts.mono.bold, fontSize: 15 },
  marketNote: { fontFamily: fonts.body.regular, fontSize: 12, marginBottom: 12 },
  availRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  availLabel: { fontFamily: fonts.body.regular, fontSize: 12 },
  availValue: { fontFamily: fonts.mono.medium, fontSize: 13 },
  availRight: { flexDirection: "row", alignItems: "center" },
  depositBtn: { marginLeft: 8, width: 24, height: 24, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  posContext: { fontFamily: fonts.mono.regular, fontSize: 11.5, marginTop: 6, marginBottom: 2 },
  maxLabel: { fontFamily: fonts.body.regular, fontSize: 11 },
  maxValue: { fontFamily: fonts.mono.medium, fontSize: 12 },
  levRow: { marginBottom: 14 },
  levHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  levLabel: { fontFamily: fonts.body.regular, fontSize: 11 },
  levMax: { fontFamily: fonts.mono.regular, fontSize: 10.5 },
  levChips: { flexDirection: "row", gap: 7, flexWrap: "wrap" },
  field: { marginBottom: 12 },
  priceField: { flex: 1, marginBottom: 0 },
  priceRow: { flexDirection: "row", alignItems: "stretch", gap: 10, marginBottom: 12 },
  inlineBox: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 60,
    marginBottom: 12,
  },
  inlineMain: { flex: 1, justifyContent: "center", paddingVertical: 9 },
  inlineLabel: { fontFamily: fonts.body.regular, fontSize: 11, textAlign: "center", marginBottom: 3 },
  inlineInput: { fontFamily: fonts.mono.bold, fontSize: 19, textAlign: "center", padding: 0 },
  inlinePlaceholderInput: { fontFamily: fonts.mono.medium, fontSize: 18, textAlign: "center", padding: 0 },
  inlineDivider: { width: 1, height: 28, marginHorizontal: 10 },
  bboBox: { justifyContent: "center", alignItems: "center", borderWidth: 1, borderRadius: 12, paddingHorizontal: 16 },
  bboText: { fontFamily: fonts.mono.bold, fontSize: 13, letterSpacing: 0.5 },
  preview: { fontFamily: fonts.mono.regular, fontSize: 11.5, marginTop: 4, marginBottom: 14 },
  sliderMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 2, marginBottom: 8 },
  optsCol: { marginBottom: 14, gap: 12, zIndex: 20 },
  reduceRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", zIndex: 20 },
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
  belowMin: { fontFamily: fonts.body.regular, fontSize: 12, marginBottom: 8 },
  sideBlock: { marginTop: 10 },
  liqLine: { fontFamily: fonts.mono.regular, fontSize: 10.5, textAlign: "right", marginTop: 2, marginBottom: 4 },
  submitBtn: { paddingVertical: 14, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, marginTop: 6 },
  submitText: { fontFamily: fonts.display.bold, fontSize: 15, letterSpacing: 0.3 },
});
