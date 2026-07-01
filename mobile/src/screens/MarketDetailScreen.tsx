import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { MarketsStackParamList } from "../navigation/types";
import { useMarketStore } from "../state/marketStore";
import { useTradeStore } from "../state/tradeStore";
import { useEnvStore } from "../state/envStore";
import { useTheme } from "../theme/useTheme";
import { useT } from "../i18n/useT";
import { useLiveDetail } from "../hooks/useLiveDetail";
import { DetailDataService } from "../services/detailData";
import { createDetailInfoClient, createDetailSubsClient } from "../lib/hyperliquid/client";
import { CandleChart } from "../components/CandleChart";
import { LoadError } from "../components/LoadError";
import { MultiPeriodReturns } from "../components/MultiPeriodReturns";
import { RsiPanel } from "../components/RsiPanel";
import { OscillatorPanel } from "../components/OscillatorPanel";
import { VolumePanel } from "../components/VolumePanel";
import { BookImbalanceBar } from "../components/BookImbalanceBar";
import { OrderbookView } from "../components/OrderbookView";
import { TradesList } from "../components/TradesList";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { NetworkWarning } from "../components/NetworkWarning";
import { PriceText, formatPrice } from "../components/PriceText";
import { Chip } from "../components/Chip";
import { IndicatorRow } from "../components/IndicatorRow";
import { Icon } from "../components/Icon";
import { fonts } from "../theme/fonts";
import { formatCompact, formatFundingPct } from "../lib/hyperliquid/format";
import { fundingCountdown } from "../lib/hyperliquid/fundingClock";
import { periodReturns } from "../lib/hyperliquid/performance";
import { sma, ema, bollinger, rsi, macd, kdj, sar } from "../lib/hyperliquid/indicators";
import { bookImbalance } from "../lib/hyperliquid/bookImbalance";

type Props = NativeStackScreenProps<MarketsStackParamList, "MarketDetail">;

const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h"] as const;
const BOOK_TABS = ["book", "trades"] as const;
const OVERLAY_INDICATORS = ["MA", "EMA", "BOLL", "SAR"] as const;
const PANEL_INDICATORS = ["VOL", "MACD", "KDJ", "RSI"] as const;
const INDICATORS = [...OVERLAY_INDICATORS, ...PANEL_INDICATORS] as const;
type Indicator = (typeof INDICATORS)[number];

/** Last non-null value of a series, for panel labels. */
function lastVal(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i];
  return null;
}

export function MarketDetailScreen({ route, navigation }: Props) {
  const { coin } = route.params;
  const theme = useTheme();
  const t = useT();
  const network = useEnvStore((s) => s.network);
  const ticker = useMarketStore((s) => s.tickers.find((t) => t.coin === coin));
  const service = useMemo(
    () => new DetailDataService(createDetailInfoClient(network), createDetailSubsClient(network)),
    [network],
  );
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>("15m");
  const { candles, orderbook, trades, error, retry } = useLiveDetail(service, coin, timeframe);

  const [bookTab, setBookTab] = useState<(typeof BOOK_TABS)[number]>("book");
  const [indicator, setIndicator] = useState<Indicator>("MA");

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
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
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
    if (indicator === "SAR") return [{ values: sar(highs, lows), color: theme.warn }];
    return [];
  })();

  const indicatorPanel = (() => {
    if (indicator === "VOL") return <VolumePanel candles={candles} theme={theme} />;
    if (indicator === "MACD") {
      const m = macd(closes);
      const last = lastVal(m.macd);
      return (
        <OscillatorPanel
          theme={theme}
          title={`MACD ${last != null ? last.toFixed(2) : "—"}`}
          series={[
            { values: m.macd, color: theme.brand },
            { values: m.signal, color: theme.warn },
          ]}
        />
      );
    }
    if (indicator === "KDJ") {
      const v = kdj(highs, lows, closes, 9);
      const last = lastVal(v.k);
      return (
        <OscillatorPanel
          theme={theme}
          title={`KDJ ${last != null ? last.toFixed(1) : "—"}`}
          series={[
            { values: v.k, color: theme.brand },
            { values: v.d, color: theme.warn },
            { values: v.j, color: theme.muted },
          ]}
        />
      );
    }
    if (indicator === "RSI") return <RsiPanel values={rsi(closes, 14)} theme={theme} />;
    return null;
  })();
  const imbalance = orderbook ? bookImbalance(orderbook, 10) : { bidPct: 50, askPct: 50 };
  const high24 = candles.length ? Math.max(...candles.map((c) => c.high)) : null;
  const low24 = candles.length ? Math.min(...candles.map((c) => c.low)) : null;

  // 5 evenly-spaced HH:MM time labels for the candle X-axis (local time, from candle timestamps).
  const timeAxis = (() => {
    if (candles.length < 2) return [] as string[];
    const fmt = (ms: number) => {
      const d = new Date(ms);
      return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    };
    return [0, 0.25, 0.5, 0.75, 1].map((f) => fmt(candles[Math.round(f * (candles.length - 1))].t));
  })();

  const stats: Array<[string, string]> = [
    [t("detail.stat24hHigh"), high24 != null ? formatPrice(high24) : "—"],
    [t("detail.stat24hLow"), low24 != null ? formatPrice(low24) : "—"],
    [t("detail.statVol"), ticker ? formatCompact(ticker.dayNtlVlm) : "—"],
    [t("detail.statOpenInterest"), ticker?.openInterest ? formatCompact(ticker.openInterest) : "—"],
    [t("detail.statFunding", { countdown: fundingCountdown(now) }), ticker ? formatFundingPct(ticker.funding) : "—"],
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
          <Text style={[styles.backText, { color: theme.text }]}>{coin}-USDC PERP</Text>
        </Pressable>
      }
      pill={<Icon name="star" color={theme.brand} active size={20} />}
    >
      <NetworkWarning variant="strip" />

      <View style={styles.quote}>
        <View style={styles.qLeft}>
          <PriceText value={price} color={theme.text} size={32} glow glowColor={theme.glow} />
          <View style={styles.qSubRow}>
            <Text style={[styles.changeLine, { color: pct >= 0 ? theme.up : theme.down }]}>
              {`${pct >= 0 ? "▲" : "▼"} $${formatPrice(Math.abs(price - (ticker?.prevDayPx ?? price)))} · ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
            </Text>
          </View>
          <Text style={[styles.mark, { color: theme.muted }]}>
            {t("detail.mark")} <Text style={{ color: theme.text }}>{formatPrice(price)}</Text>
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

      {error && candles.length === 0 ? (
        <LoadError theme={theme} code={error} onRetry={retry} testID="detail-error" />
      ) : (
        <CandleChart candles={candles} theme={theme} currentPrice={price} overlays={overlays} />
      )}

      {timeAxis.length > 0 ? (
        <View style={styles.xAxis}>
          {timeAxis.map((t, i) => (
            <Text key={i} style={[styles.xAxisLabel, { color: theme.faint }]}>
              {t}
            </Text>
          ))}
        </View>
      ) : null}

      <IndicatorRow
        theme={theme}
        items={INDICATORS}
        active={indicator}
        onSelect={setIndicator}
        separatorAfter={OVERLAY_INDICATORS.length}
      />

      {indicatorPanel}

      <MultiPeriodReturns theme={theme} data={perf} />

      <View style={[styles.bookTabs, { borderBottomColor: theme.line }]}>
        <View style={styles.bookTabGroup}>
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
                {tab === "book" ? t("detail.orderBook") : t("detail.trades")}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.imbalance}>
          <Text style={{ color: theme.up }}>L {imbalance.bidPct.toFixed(1)}%</Text>
          <Text style={{ color: theme.muted }}> · </Text>
          <Text style={{ color: theme.down }}>{imbalance.askPct.toFixed(1)}% S</Text>
        </Text>
      </View>

      {bookTab === "book" ? (
        orderbook ? (
          <>
            <OrderbookView book={orderbook} theme={theme} coin={coin} />
            <BookImbalanceBar theme={theme} bidPct={imbalance.bidPct} askPct={imbalance.askPct} />
          </>
        ) : (
          <Text style={[styles.muted, { color: theme.muted }]}>{t("detail.loadingBook")}</Text>
        )
      ) : trades.length > 0 ? (
        <TradesList trades={trades} theme={theme} />
      ) : (
        <Text style={[styles.muted, { color: theme.muted }]}>{t("detail.loadingTrades")}</Text>
      )}

      <Pressable
        style={[styles.cta, { backgroundColor: theme.brand }]}
        accessibilityRole="button"
        onPress={() => {
          useTradeStore.getState().setSelectedCoin(coin);
          navigation.getParent()?.navigate("Trade" as never);
        }}
      >
        <Text style={[styles.ctaText, { color: theme.bg }]}>{t("common.trade")}</Text>
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
  changeLine: { fontFamily: fonts.mono.bold, fontSize: 12.5, fontVariant: ["tabular-nums"] },
  mark: { fontFamily: fonts.body.regular, fontSize: 11, marginTop: 6 },
  qRight: { flex: 1, alignItems: "flex-end", gap: 3 },
  statRow: { flexDirection: "row", justifyContent: "space-between", width: "100%", gap: 10 },
  statLabel: { fontFamily: fonts.body.regular, fontSize: 10.5, flexShrink: 1 },
  statValue: { fontFamily: fonts.mono.medium, fontSize: 10.5 },
  tfs: { flexDirection: "row", flexWrap: "wrap", gap: 7, rowGap: 7, marginBottom: 10 },
  xAxis: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 2, marginTop: 4, marginBottom: 8 },
  xAxisLabel: { fontFamily: fonts.mono.regular, fontSize: 9 },
  bookTabs: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", borderBottomWidth: 1, marginTop: 14, marginBottom: 6 },
  bookTabGroup: { flexDirection: "row", gap: 18 },
  imbalance: { fontFamily: fonts.mono.medium, fontSize: 10.5, paddingBottom: 4 },
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
