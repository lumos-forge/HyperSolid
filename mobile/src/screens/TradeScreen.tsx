import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Alert, ActivityIndicator } from "react-native";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import { useWalletStore } from "../state/walletStore";
import { useEnvStore } from "../state/envStore";
import { useMarketStore } from "../state/marketStore";
import { useTradeStore } from "../state/tradeStore";
import { useLedgerStore } from "../state/ledgerStore";
import { useExchangeStore } from "../state/exchangeStore";
import { useToastStore } from "../state/toastStore";
import { builderConfig } from "../state/runtimeConfigStore";
import { useBuilderApprovalStore } from "../state/builderApprovalStore";
import { queryBuilderApproval } from "../services/builderApproval";
import { useUnconfirmedIntents } from "../hooks/useUnconfirmedIntents";
import { createExchangeClient, createPositionsInfoClient, createInfoClient } from "../lib/hyperliquid/client";
import { buildAssetIndex } from "../lib/hyperliquid/assetId";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { UnconfirmedBanner } from "../components/UnconfirmedBanner";
import { SurfaceCard } from "../components/SurfaceCard";
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
import { FloatingField } from "../components/FloatingField";
import { SheetSelect } from "../components/SheetSelect";
import { Icon } from "../components/Icon";
import { withAlpha } from "../theme/color";
import { fonts } from "../theme/fonts";
import type { ThemeTokens } from "../theme/tokens";
import type { TranslationKey } from "../i18n/messages";
import type { LocalWalletService } from "../wallet/localWallet";
import type { OrderSide, TimeInForce } from "../lib/hyperliquid/buildOrder";
import { validateOrder, clampLeverage, validateTriggerSide, roundSize, formatPrice as toHlPrice } from "../lib/hyperliquid/order";
import { bboPrice, type BboMode } from "../lib/hyperliquid/bboLevels";
import type { Orderbook } from "../lib/hyperliquid/types";
import {
  orderTypeShape,
  toBaseSize,
  requiredMargin,
  clampSizeInput,
  TAKER_FEE_RATE,
  MAKER_FEE_RATE,
  marketSlippagePrice,
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

const BBO_MODE_KEY: Record<BboMode, TranslationKey> = {
  opp1: "trade.bboOpp1",
  opp5: "trade.bboOpp5",
  queue1: "trade.bboQueue1",
  queue5: "trade.bboQueue5",
};
function bboModeKey(mode: BboMode): TranslationKey {
  return BBO_MODE_KEY[mode];
}

/**
 * Worst-case bound for a "market" order: it is sent as an IOC limit at mid ± this %, so it fills at
 * the best available price while capping slippage. The user never types a price for market orders.
 */
function marketPrice(mid: number, side: OrderSide): number {
  return marketSlippagePrice(mid, side);
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
  const [showOrderSheet, setShowOrderSheet] = useState(false);
  const [showUnitSheet, setShowUnitSheet] = useState(false);
  const [showBboSheet, setShowBboSheet] = useState(false);
  const [showTifSheet, setShowTifSheet] = useState(false);
  const [book, setBook] = useState<Orderbook | null>(null);
  const [bboMode, setBboMode] = useState<BboMode | null>(null);
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

  // Coin chosen from market detail's "Trade" CTA (cross-tab). Apply once, then clear so manual
  // changes here aren't overridden on the next visit.
  const selectedCoin = useTradeStore((s) => s.selectedCoin);
  useEffect(() => {
    if (!selectedCoin) return;
    setCoin(selectedCoin);
    setPriceEdited(false);
    const pre = useTradeStore.getState().prefill;
    if (pre) {
      setSizeUnit("base");
      setSize(pre.size);
      setReduceOnly(pre.reduceOnly);
      useTradeStore.getState().clearPrefill();
    }
    useTradeStore.getState().clearSelectedCoin();
  }, [selectedCoin]);

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
    const bc = builderConfig();
    useExchangeStore.getState().init(
      client,
      index,
      ledger ?? undefined,
      bc
        ? { address: bc.address, feeTenthBps: bc.perpFeeTenthBps, isApproved: () => useBuilderApprovalStore.getState().approved }
        : undefined,
    );
  }, [client, index, ledger]);

  // A new wallet/network must re-gate the builder-fee approval (approval is per-user, on-chain).
  useEffect(() => {
    useBuilderApprovalStore.getState().reset();
  }, [walletAddress, network]);

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
  // Reference price for sizing / liq / notional: the typed limit price when used (BBO mode has no
  // single typed price, so it falls back to the live mid for the preview), else live mid.
  const refPrice = usesLimitPrice ? (bboMode ? mid : Number(price) || 0) : mid;

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
  // Displayed size precision: base sizes use the asset's lot decimals; USDC notional uses 2.
  const sizeDecimals = sizeUnit === "quote" ? 2 : szDec;
  const sizePct = maxInUnit > 0 ? Math.min(100, ((Number(size) || 0) / maxInUnit) * 100) : 0;
  function onSlide(pct: number) {
    if (maxInUnit <= 0) return;
    clearRetry();
    setSize(((pct / 100) * maxInUnit).toFixed(sizeDecimals));
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

  /** One-time, pre-first-order builder-fee approval. Fail-open: any decline/error places without a
   *  builder (the service only attaches when the store says approved) and does not re-nag this session. */
  async function ensureBuilderApproval(): Promise<void> {
    const bc = builderConfig();
    if (!bc || !walletAddress) return;
    const store = useBuilderApprovalStore.getState();
    if (store.approved || store.suppressed) return;

    const user = walletAddress as `0x${string}`;
    const status = await queryBuilderApproval(createInfoClient(network), user, bc.address, bc.perpFeeTenthBps);
    if (status === "approved") {
      store.setApproved(true);
      return;
    }
    if (status === "unknown") return; // place without a builder this time; retry next order

    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(t("builderFee.approveTitle"), t("builderFee.approveBody"), [
        { text: t("builderFee.notNow"), style: "cancel", onPress: () => resolve(false) },
        { text: t("builderFee.approve"), onPress: () => resolve(true) },
      ]);
    });
    if (!confirmed) {
      store.suppress();
      return;
    }

    const svc = useExchangeStore.getState().service;
    const res = svc ? await svc.approveBuilderFee("0.1%", bc.address) : { ok: false as const };
    if (res.ok) {
      store.setApproved(true);
      useToastStore.getState().show(t("builderFee.approved"), "success");
    } else {
      store.suppress();
      useToastStore.getState().show(t("builderFee.approveFailed"), "info");
    }
  }

  // Place-order handler driven by the two HL-style buy/sell buttons (no separate side toggle). The
  // side is passed explicitly so a button submits its own side immediately (no stale state). A
  // re-entry guard wraps the whole flow (incl. the async builder-approval gate) so a second tap during
  // any in-flight round-trip (approval query / signing / placement) can't launch a concurrent submit
  // and place a duplicate order (each submit mints a fresh cloid, so ledger dedup wouldn't catch it).
  const submittingRef = useRef(false);
  async function onSubmit(orderSide: OrderSide) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onSubmitInner(orderSide);
    } finally {
      submittingRef.current = false;
    }
  }

  async function onSubmitInner(orderSide: OrderSide) {
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

    // Builder-fee: ensure a one-time approval before the first fee-bearing order (fail-open — a
    // decline/error just places without a builder). Covers scale + single + bracket (not TWAP above).
    // Guarded so the no-config path stays synchronous (no microtask before client-side validation).
    if (builderConfig()) await ensureBuilderApproval();

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
      ? bboMode
        ? bboPrice(book ?? { asks: [], bids: [], spread: 0, spreadPct: 0 }, bboMode, orderSide) || mid
        : Number(price)
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

  // TP/SL applies to plain entries (not trigger/twap/scale). The compact TIF dropdown rides on that
  // row when shown, otherwise on the reduce-only row.
  const showTpSl = !shape.isTrigger && !isTwap && !isScale;
  const tifLabel = tif === "Gtc" ? t("trade.tifGtc") : tif === "Ioc" ? t("trade.tifIoc") : t("trade.tifAloShort");
  const tifControl = (
    <Pressable
      testID="tif"
      accessibilityRole="button"
      onPress={() => setShowTifSheet(true)}
      style={[styles.tifTrigger, { borderColor: theme.line, backgroundColor: theme.surface }]}
    >
      <Text style={[styles.tifTriggerText, { color: theme.text }]}>{`TIF ${tifLabel}`}</Text>
      <Icon name="chevronDown" color={theme.muted} size={13} />
    </Pressable>
  );
  const tifSections = [
    {
      options: [
        { value: "Gtc", label: t("trade.tifGtc"), subtitle: t("trade.tifGtcSub") },
        { value: "Ioc", label: t("trade.tifIoc"), subtitle: t("trade.tifIocSub") },
        { value: "Alo", label: t("trade.tifAloShort"), subtitle: t("trade.tifAloSub") },
      ],
    },
  ];

  const orderTypeLabelKey = ORDER_TYPES.find(([type]) => type === orderType)?.[1] ?? "trade.typeLimit";
  const orderSections = [
    {
      header: t("trade.orderGroupBasic"),
      options: (["limit", "market"] as TicketOrderType[]).map((type) => ({
        value: type,
        label: t(ORDER_TYPES.find(([o]) => o === type)![1]),
      })),
    },
    {
      header: t("trade.orderGroupPro"),
      options: (["scale", "stopLimit", "stopMarket", "tpLimit", "tpMarket", "twap"] as TicketOrderType[]).map((type) => ({
        value: type,
        label: t(ORDER_TYPES.find(([o]) => o === type)![1]),
      })),
    },
  ];
  const unitSections = [
    {
      options: [
        { value: "base" as SizeUnit, label: coin.toUpperCase(), subtitle: t("trade.sizeUnitBaseSub", { coin: coin.toUpperCase() }) },
        { value: "quote" as SizeUnit, label: "USDC", subtitle: t("trade.sizeUnitQuoteSub") },
      ],
    },
  ];
  const bboSections = [
    {
      options: [{ value: "custom", label: t("trade.bboCustom"), subtitle: t("trade.bboCustomSub") }],
    },
    {
      header: t("trade.bbo"),
      options: [
        { value: "opp1", label: t("trade.bboOpp1"), subtitle: t("trade.bboOppSub") },
        { value: "opp5", label: t("trade.bboOpp5"), subtitle: t("trade.bboOppSub") },
        { value: "queue1", label: t("trade.bboQueue1"), subtitle: t("trade.bboQueueSub") },
        { value: "queue5", label: t("trade.bboQueue5"), subtitle: t("trade.bboQueueSub") },
      ],
    },
  ];

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

      <Pressable
        testID="order-type"
        accessibilityRole="button"
        onPress={() => setShowOrderSheet(true)}
        style={[styles.selectField, { borderColor: theme.line, backgroundColor: theme.surface }]}
      >
        <Text style={[styles.selectFieldText, { color: theme.text }]}>{t(orderTypeLabelKey)}</Text>
        <View style={styles.selectChevron}>
          <Icon name="chevronDown" color={theme.muted} size={16} />
        </View>
      </Pressable>
      {usesLimitPrice ? (
        <View style={styles.priceRow}>
          {bboMode ? (
            <Pressable
              accessibilityRole="button"
              testID="bbo-mode-field"
              onPress={() => setShowBboSheet(true)}
              style={[styles.bboModeField, { borderColor: theme.line, backgroundColor: theme.surface }]}
            >
              <Text style={[styles.bboModeLabel, { color: theme.muted }]}>{t("trade.priceUsdc")}</Text>
              <Text
                style={[styles.bboModeValue, { color: theme.text }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.65}
              >
                {t(bboModeKey(bboMode))}
              </Text>
            </Pressable>
          ) : (
            <FloatingField
              label={t("trade.priceUsdc")}
              value={price}
              onChange={onChangePrice}
              theme={theme}
              testID="field-price"
              style={styles.priceField}
            />
          )}
          <Pressable
            accessibilityRole="button"
            testID="bbo-button"
            onPress={() => setShowBboSheet(true)}
            style={[
              styles.bboBox,
              { borderColor: bboMode ? theme.brand : theme.line, backgroundColor: theme.surface },
            ]}
          >
            <Text style={[styles.bboText, { color: bboMode ? theme.brand : theme.muted }]}>{t("trade.bbo")}</Text>
          </Pressable>
        </View>
      ) : null}
      {shape.isTrigger ? (
        <FloatingField label={t("trade.triggerPriceUsdc")} value={stopPrice} onChange={edit(setStopPrice)} theme={theme} testID="field-stop" />
      ) : null}
      {isScale ? (
        <>
          <FloatingField label={t("trade.scaleStart")} value={scaleStart} onChange={edit(setScaleStart)} theme={theme} testID="field-scale-start" />
          <FloatingField label={t("trade.scaleEnd")} value={scaleEnd} onChange={edit(setScaleEnd)} theme={theme} testID="field-scale-end" />
          <FloatingField label={t("trade.scaleCount")} value={scaleCount} onChange={edit(setScaleCount)} theme={theme} testID="field-scale-count" />
        </>
      ) : null}
      {isTwap ? (
        <>
          <FloatingField label={t("trade.twapMinutes")} value={twapMinutes} onChange={edit(setTwapMinutes)} theme={theme} testID="field-twap-minutes" />
          <View style={styles.optRow}>
            <Text style={[styles.optLabel, { color: theme.text }]}>{t("trade.twapRandomize")}</Text>
            <Toggle theme={theme} value={twapRandomize} onValueChange={edit(setTwapRandomize)} accessibilityLabel="twap-randomize" />
          </View>
        </>
      ) : null}
      <FloatingField
        label={t("trade.sizeLabel")}
        value={size}
        onChange={edit((v: string) => setSize(clampSizeInput(v, sizeDecimals)))}
        theme={theme}
        testID="field-size"
        rightInside={
          <Pressable
            testID="size-unit"
            accessibilityRole="button"
            onPress={() => setShowUnitSheet(true)}
            hitSlop={6}
            style={styles.unitTrigger}
          >
            <Text style={[styles.unitTriggerText, { color: theme.text }]}>
              {sizeUnit === "base" ? coin.toUpperCase() : "USDC"}
            </Text>
            <Icon name="chevronDown" color={theme.muted} size={13} />
          </Pressable>
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

      <View style={styles.sizeSlider}>
        <Slider value={sizePct} onChange={onSlide} testID="size-slider" />
      </View>

      <View style={styles.optsCol}>
        {showTpSl ? (
          <View style={styles.optsRowTop}>
            <Checkbox
              theme={theme}
              value={tpSlOn}
              onValueChange={edit(setTpSlOn)}
              label={t("trade.tpSl")}
              accessibilityLabel="tpsl-toggle"
            />
            {usesLimitPrice ? tifControl : null}
          </View>
        ) : null}
        <View style={styles.optsRowBottom}>
          <Checkbox
            theme={theme}
            value={reduceOnly}
            onValueChange={edit(setReduceOnly)}
            label={t("positions.reduceOnly")}
            accessibilityLabel="reduce-only"
          />
          {usesLimitPrice && !showTpSl ? tifControl : null}
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
        return (
          <View key={s} style={styles.sideBlock}>
            <SummaryRow theme={theme} label={t("trade.requiredMargin")} value={`${margin.toFixed(2)} USDC`} />
            <SummaryRow
              theme={theme}
              label={t(s === "buy" ? "trade.maxLong" : "trade.maxShort")}
              value={maxBase > 0 ? `${maxBase.toFixed(szDec)} ${coin.toUpperCase()}` : "—"}
            />
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
            onBook={setBook}
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

      <SheetSelect
        visible={showOrderSheet}
        onClose={() => setShowOrderSheet(false)}
        title={t("trade.orderTypeTitle")}
        sections={orderSections}
        value={orderType}
        onSelect={(v) => {
          clearRetry();
          setOrderType(v);
        }}
        theme={theme}
        testIDPrefix="order-type"
      />

      <SheetSelect
        visible={showUnitSheet}
        onClose={() => setShowUnitSheet(false)}
        title={t("trade.sizeUnitTitle")}
        sections={unitSections}
        value={sizeUnit}
        onSelect={(u) => {
          clearRetry();
          setSize("");
          setSizeUnit(u);
        }}
        theme={theme}
        testIDPrefix="size-unit"
      />

      <SheetSelect
        visible={showBboSheet}
        onClose={() => setShowBboSheet(false)}
        title={t("trade.bbo")}
        sections={bboSections}
        value={bboMode ?? "custom"}
        onSelect={(v) => {
          clearRetry();
          setBboMode(v === "custom" ? null : (v as BboMode));
        }}
        theme={theme}
        testIDPrefix="bbo"
      />

      <SheetSelect
        visible={showTifSheet}
        onClose={() => setShowTifSheet(false)}
        title={t("trade.tif")}
        sections={tifSections}
        value={tif}
        onSelect={(v) => {
          clearRetry();
          setTif(v as TimeInForce);
        }}
        theme={theme}
        testIDPrefix="tif"
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
  selectField: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 12,
    minHeight: 46,
    marginBottom: 12,
  },
  selectFieldText: { fontFamily: fonts.display.bold, fontSize: 16 },
  selectChevron: { position: "absolute", right: 12 },
  unitTrigger: { flexDirection: "row", alignItems: "center", gap: 4 },
  unitTriggerText: { fontFamily: fonts.display.bold, fontSize: 12.5 },
  tifTrigger: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  tifTriggerText: { fontFamily: fonts.display.bold, fontSize: 12.5 },
  priceField: { flex: 1, marginBottom: 0 },
  priceRow: { flexDirection: "row", alignItems: "stretch", gap: 10, marginBottom: 12 },
  bboBox: { justifyContent: "center", alignItems: "center", borderWidth: 1, borderRadius: 12, paddingHorizontal: 16 },
  bboText: { fontFamily: fonts.display.bold, fontSize: 13, letterSpacing: 0.5 },
  bboModeField: { flex: 1, justifyContent: "center", borderWidth: 1, borderRadius: 12, height: 46, marginBottom: 0, paddingHorizontal: 12 },
  bboModeLabel: { fontFamily: fonts.body.regular, fontSize: 11, textAlign: "center", marginBottom: 2 },
  bboModeValue: { fontFamily: fonts.display.bold, fontSize: 16, textAlign: "center" },
  preview: { fontFamily: fonts.mono.regular, fontSize: 11.5, marginTop: 4, marginBottom: 14 },
  sizeSlider: { marginBottom: 12 },
  optsCol: { marginBottom: 12, gap: 12, zIndex: 20 },
  optsRowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", zIndex: 2 },
  optsRowBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", zIndex: 1 },
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
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5 },
  sumLabel: { fontFamily: fonts.body.regular, fontSize: 12 },
  sumValue: { fontFamily: fonts.mono.medium, fontSize: 12 },
  uncertain: { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 },
  uncertainTitle: { fontFamily: fonts.body.semibold, fontSize: 13, marginBottom: 4 },
  uncertainBody: { fontFamily: fonts.body.regular, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  retry: { borderWidth: 1, borderRadius: 8, paddingVertical: 11, alignItems: "center" },
  retryText: { fontFamily: fonts.body.semibold, fontSize: 14 },
  belowMin: { fontFamily: fonts.body.regular, fontSize: 12, marginBottom: 8 },
  sideBlock: { marginTop: 12 },
  submitBtn: { paddingVertical: 12, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, marginTop: 6 },
  submitText: { fontFamily: fonts.display.bold, fontSize: 15, letterSpacing: 0.3 },
});
