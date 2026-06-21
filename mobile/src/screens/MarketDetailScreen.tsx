import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { MarketsStackParamList } from "../navigation/types";
import { useMarketStore } from "../state/marketStore";
import { useEnvStore } from "../state/envStore";
import { useTheme } from "../theme/useTheme";
import { useLiveDetail } from "../hooks/useLiveDetail";
import { DetailDataService } from "../services/detailData";
import { createDetailInfoClient, createDetailSubsClient } from "../lib/hyperliquid/client";
import { StatGrid } from "../components/StatGrid";
import { Sparkline } from "../components/Sparkline";
import { OrderbookView } from "../components/OrderbookView";
import { TradesList } from "../components/TradesList";
import { ScreenScaffold } from "../components/ScreenScaffold";
import { SectionLabel } from "../components/SectionLabel";
import { Pill } from "../components/Pill";
import { Chip } from "../components/Chip";
import { Icon } from "../components/Icon";
import { formatCompact, formatSignedPct, formatFundingPct } from "../lib/hyperliquid/format";

type Props = NativeStackScreenProps<MarketsStackParamList, "MarketDetail">;

const TIMEFRAMES = ["1H", "4H", "1D", "1W"] as const;

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

  const pct = ticker?.changePct ?? 0;
  const up = pct >= 0;
  const dir = up ? theme.up : theme.down;
  const pillLabel = `${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}%`;

  const stats = [
    { label: "标记价", value: ticker ? String(ticker.midPx) : "—" },
    { label: "24h 涨跌", value: ticker ? formatSignedPct(ticker.changePct) : "—" },
    { label: "资金费", value: ticker ? formatFundingPct(ticker.funding) : "—" },
    { label: "24h 量", value: ticker ? formatCompact(ticker.dayNtlVlm) : "—" },
    { label: "最大杠杆", value: ticker ? `${ticker.maxLeverage}x` : "—" },
    { label: "前日价", value: ticker ? String(ticker.prevDayPx) : "—" },
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
      pill={<Pill theme={theme} label={pillLabel} variant={up ? "up" : "down"} />}
    >
      <View style={styles.priceRow}>
        <Text style={[styles.priceLg, { color: theme.text }]}>
          {ticker ? String(ticker.midPx) : "—"}
        </Text>
        <Text style={[styles.pchg, { color: dir }]}>
          {ticker ? formatSignedPct(ticker.changePct) : ""}
        </Text>
      </View>

      <View style={styles.chips}>
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

      <View style={[styles.chart, { borderColor: theme.line, backgroundColor: theme.surface }]}>
        <Sparkline candles={candles} theme={theme} />
      </View>

      <StatGrid stats={stats} theme={theme} />

      <SectionLabel theme={theme}>盘口 ORDERBOOK</SectionLabel>
      {orderbook ? (
        <OrderbookView book={orderbook} theme={theme} />
      ) : (
        <Text style={[styles.muted, { color: theme.muted }]}>加载盘口…</Text>
      )}

      <Pressable style={[styles.cta, { backgroundColor: theme.brand }]} accessibilityRole="button">
        <Text style={[styles.ctaText, { color: theme.bg }]}>去交易</Text>
        <Icon name="arrowRight" color={theme.bg} size={18} />
      </Pressable>

      <SectionLabel theme={theme}>最近成交 TRADES</SectionLabel>
      {trades.length > 0 ? (
        <TradesList trades={trades} theme={theme} />
      ) : (
        <Text style={[styles.muted, { color: theme.muted }]}>加载成交…</Text>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", gap: 4 },
  backText: { fontSize: 13, fontWeight: "700", letterSpacing: 0.4 },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: 10, marginBottom: 10 },
  priceLg: { fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"] },
  pchg: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  chips: { flexDirection: "row", gap: 7, marginBottom: 10 },
  chart: { borderWidth: 1, borderRadius: 10, padding: 8, marginBottom: 10 },
  muted: { fontSize: 13, paddingVertical: 8 },
  cta: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  ctaText: { fontSize: 15, fontWeight: "700" },
});
