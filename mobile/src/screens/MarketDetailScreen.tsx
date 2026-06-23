import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { MarketsStackParamList } from "../navigation/types";
import { useMarketStore } from "../state/marketStore";
import { useEnvStore } from "../state/envStore";
import { useTheme } from "../theme/useTheme";
import { useLiveDetail } from "../hooks/useLiveDetail";
import { DetailDataService } from "../services/detailData";
import { createDetailInfoClient, createDetailSubsClient } from "../lib/hyperliquid/client";
import { CandleChart } from "../components/CandleChart";
import { MultiPeriodReturns } from "../components/MultiPeriodReturns";
import { RsiPanel } from "../components/RsiPanel";
import { BookImbalanceBar } from "../components/BookImbalanceBar";
import { OrderbookView } from "../components/OrderbookView";
import { TradesList } from "../components/TradesList";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { PriceText, formatPrice } from "../components/PriceText";
import { ChangeText } from "../components/ChangeText";
import { Chip } from "../components/Chip";
import { Icon } from "../components/Icon";
import { fonts } from "../theme/fonts";
import { formatCompact, formatFundingPct } from "../lib/hyperliquid/format";
import { periodReturns } from "../lib/hyperliquid/performance";
import { sma, ema, bollinger, rsi } from "../lib/hyperliquid/indicators";
import { bookImbalance } from "../lib/hyperliquid/bookImbalance";

type Props = NativeStackScreenProps<MarketsStackParamList, "MarketDetail">;

const TIMEFRAMES = ["1H", "4H", "1D", "1W"] as const;
const BOOK_TABS = ["book", "trades"] as const;

/** Time left until the next hourly funding settlement (UTC), as HH:MM:SS. */
function fundingCountdown(nowMs: number): string {
  const ms = 3_600_000 - (nowMs % 3_600_000);
  const total = Math.floor(ms / 1000);
  const p = (x: number) => x.toString().padStart(2, "0");
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
}

export function MarketDetailScreen({ route, navigation }: Props) {
  const { coin } = route.params;
  const theme = useTheme();
  const network = useEnvStore((s) => s.network);
  const ticker = useMarketStore((s) => s.tickers.find((t) => t.coin === coin));
  const service = useMemo(
    () => new DetailDataService(createDetailInfoClient(network), createDetailSubsClient(network)),
    [network],
  );
  const { candles, orderbook, trades } = useLiveDetail(service, coin);

  // TODO: timeframe should drive the candle interval and trigger a refetch
  // (DetailDataService.loadCandles currently uses a fixed interval — service-layer change).
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>("1H");
  const [bookTab, setBookTab] = useState<(typeof BOOK_TABS)[number]>("book");
  const [indicator, setIndicator] = useState<"none" | "MA" | "EMA" | "BOLL">("none");

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const [dailyCloses, setDailyCloses] = useState<number[]>([]);
  useEffect(() => {
    let active = true;
    service
      .loadDailyCloses(coin)
      .then((c) => active && setDailyCloses(c))
      .catch(() => active && setDailyCloses([]));
    return () => {
      active = false;
    };
  }, [service, coin]);
  const perf = periodReturns(dailyCloses, [
    { label: "24H", days: 1 },
    { label: "7D", days: 7 },
    { label: "30D", days: 30 },
    { label: "90D", days: 90 },
    { label: "180D", days: 180 },
    { label: "1Y", days: 365 },
  ]);

  const price = ticker?.midPx ?? 0;
  const pct = ticker?.changePct ?? 0;
  const closes = candles.map((c) => c.close);
  const overlays = (() => {
    if (indicator === "MA") return [{ values: sma(closes, 7), color: theme.brand }];
    if (indicator === "EMA") return [{ values: ema(closes, 7), color: theme.brand }];
    if (indicator === "BOLL") {
      const b = bollinger(closes, 20, 2);
      return [
        { values: b.upper, color: theme.muted },
        { values: b.mid, color: theme.brand },
        { values: b.lower, color: theme.muted },
      ];
    }
    return [];
  })();
  const imbalance = orderbook ? bookImbalance(orderbook, 10) : { bidPct: 50, askPct: 50 };
  const high24 = candles.length ? Math.max(...candles.map((c) => c.high)) : null;
  const low24 = candles.length ? Math.min(...candles.map((c) => c.low)) : null;

  const stats: Array<[string, string]> = [
    ["24h high", high24 != null ? formatPrice(high24) : "—"],
    ["24h low", low24 != null ? formatPrice(low24) : "—"],
    ["24h vol · USDC", ticker ? formatCompact(ticker.dayNtlVlm) : "—"],
    ["Open interest", ticker?.openInterest ? formatCompact(ticker.openInterest) : "—"],
    [`Funding · ${fundingCountdown(now)}`, ticker ? formatFundingPct(ticker.funding) : "—"],
    ["Max leverage", ticker ? `${ticker.maxLeverage}×` : "—"],
  ];

  return (
    <ScreenScaffold
      theme={theme}
      statusLeft={
        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="back"
          hitSlop={8}
          style={styles.back}
        >
          <Icon name="chevron" color={theme.muted} size={14} />
          <Text style={[styles.backText, { color: theme.text }]}>{coin}-PERP</Text>
        </Pressable>
      }
      pill={<Icon name="star" color={theme.brand} active size={20} />}
    >
      <NetworkWarning variant="strip" />

      <View style={styles.quote}>
        <View style={styles.qLeft}>
          <PriceText value={price} color={theme.text} size={32} glow glowColor={theme.glow} />
          <View style={styles.qSubRow}>
            <ChangeText theme={theme} value={pct} size={12.5} />
          </View>
          <Text style={[styles.mark, { color: theme.muted }]}>
            Mark <Text style={{ color: theme.text }}>{formatPrice(price)}</Text>
          </Text>
        </View>
        <View style={styles.qRight}>
          {stats.map(([label, value]) => (
            <View key={label} style={styles.statRow}>
              <Text style={[styles.statLabel, { color: theme.faint }]}>{label}</Text>
              <Text style={[styles.statValue, { color: theme.text }]}>{value}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.tfs}>
        {TIMEFRAMES.map((tf) => (
          <Chip
            key={tf}
            theme={theme}
            label={tf}
            active={tf === timeframe}
            onPress={() => setTimeframe(tf)}
          />
        ))}
      </View>

      <View style={styles.tfs}>
        {(["none", "MA", "EMA", "BOLL"] as const).map((ind) => (
          <Chip
            key={ind}
            theme={theme}
            label={ind === "none" ? "—" : ind}
            active={indicator === ind}
            onPress={() => setIndicator(ind)}
          />
        ))}
      </View>

      <CandleChart candles={candles} theme={theme} currentPrice={price} overlays={overlays} />

      <MultiPeriodReturns theme={theme} data={perf} />

      <RsiPanel values={rsi(closes, 14)} theme={theme} />

      <View style={[styles.bookTabs, { borderBottomColor: theme.line }]}>
        {BOOK_TABS.map((tab) => (
          <Pressable
            key={tab}
            onPress={() => setBookTab(tab)}
            accessibilityRole="button"
            accessibilityState={{ selected: bookTab === tab }}
          >
            <Text
              style={[
                styles.bookTab,
                {
                  color: bookTab === tab ? theme.brand : theme.muted,
                  borderBottomColor: bookTab === tab ? theme.brand : "transparent",
                },
              ]}
            >
              {tab === "book" ? "Order book" : "Trades"}
            </Text>
          </Pressable>
        ))}
      </View>

      {bookTab === "book" ? (
        orderbook ? (
          <>
            <OrderbookView book={orderbook} theme={theme} />
            <BookImbalanceBar theme={theme} bidPct={imbalance.bidPct} askPct={imbalance.askPct} />
          </>
        ) : (
          <Text style={[styles.muted, { color: theme.muted }]}>Loading order book…</Text>
        )
      ) : trades.length > 0 ? (
        <TradesList trades={trades} theme={theme} />
      ) : (
        <Text style={[styles.muted, { color: theme.muted }]}>Loading trades…</Text>
      )}

      <Pressable style={[styles.cta, { backgroundColor: theme.brand }]} accessibilityRole="button">
        <Text style={[styles.ctaText, { color: theme.bg }]}>Trade</Text>
        <Icon name="arrowRight" color={theme.bg} size={18} />
      </Pressable>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", gap: 4 },
  backText: { fontFamily: fonts.display.bold, fontSize: 13, letterSpacing: 0.4 },
  quote: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  qLeft: { flex: 1 },
  qSubRow: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  mark: { fontFamily: fonts.body.regular, fontSize: 11, marginTop: 6 },
  qRight: { flex: 1, alignItems: "flex-end", gap: 3 },
  statRow: { flexDirection: "row", justifyContent: "space-between", width: "100%", gap: 10 },
  statLabel: { fontFamily: fonts.body.regular, fontSize: 10.5, flexShrink: 1 },
  statValue: { fontFamily: fonts.mono.medium, fontSize: 10.5 },
  tfs: { flexDirection: "row", gap: 7, marginBottom: 10 },
  bookTabs: { flexDirection: "row", gap: 18, borderBottomWidth: 1, marginTop: 14, marginBottom: 6 },
  bookTab: {
    fontFamily: fonts.display.bold,
    fontSize: 12,
    letterSpacing: 0.3,
    paddingBottom: 8,
    borderBottomWidth: 2,
  },
  muted: { fontFamily: fonts.body.regular, fontSize: 13, paddingVertical: 8 },
  cta: {
    marginTop: 16,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  ctaText: { fontFamily: fonts.display.bold, fontSize: 15, letterSpacing: 0.3 },
});
