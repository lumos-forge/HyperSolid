import React, { useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
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
import { formatCompact, formatSignedPct, formatFundingPct } from "../lib/hyperliquid/format";

type Props = NativeStackScreenProps<MarketsStackParamList, "MarketDetail">;

export function MarketDetailScreen({ route }: Props) {
  const { coin } = route.params;
  const theme = useTheme();
  const network = useEnvStore((s) => s.network);
  const ticker = useMarketStore((s) => s.tickers.find((t) => t.coin === coin));
  const service = useMemo(
    () => new DetailDataService(createDetailInfoClient(network), createDetailSubsClient(network)),
    [network],
  );
  const { candles, orderbook, trades } = useLiveDetail(service, coin);

  const dir = (ticker?.changePct ?? 0) >= 0 ? theme.up : theme.down;
  const stats = [
    { label: "标记价", value: ticker ? String(ticker.midPx) : "—" },
    { label: "24h 涨跌", value: ticker ? formatSignedPct(ticker.changePct) : "—" },
    { label: "资金费", value: ticker ? formatFundingPct(ticker.funding) : "—" },
    { label: "24h 量", value: ticker ? formatCompact(ticker.dayNtlVlm) : "—" },
    { label: "最大杠杆", value: ticker ? `${ticker.maxLeverage}x` : "—" },
    { label: "前日价", value: ticker ? String(ticker.prevDayPx) : "—" },
  ];

  return (
    <ScrollView style={[styles.root, { backgroundColor: theme.bg }]} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={[styles.coin, { color: theme.text }]}>{coin}-PERP</Text>
        <Text style={[styles.price, { color: dir }]}>
          {ticker ? String(ticker.midPx) : "—"} {ticker ? formatSignedPct(ticker.changePct) : ""}
        </Text>
      </View>

      <Sparkline candles={candles} theme={theme} />

      <StatGrid stats={stats} theme={theme} />

      <Text style={[styles.section, { color: theme.text }]}>盘口 Orderbook</Text>
      {orderbook ? (
        <OrderbookView book={orderbook} theme={theme} />
      ) : (
        <Text style={[styles.muted, { color: theme.muted }]}>加载盘口…</Text>
      )}

      <Pressable
        style={[styles.cta, { backgroundColor: theme.brand }]}
        accessibilityRole="button"
      >
        <Text style={[styles.ctaText, { color: theme.bg }]}>去交易 →</Text>
      </Pressable>

      <Text style={[styles.section, { color: theme.text }]}>最近成交 Trades</Text>
      {trades.length > 0 ? (
        <TradesList trades={trades} theme={theme} />
      ) : (
        <Text style={[styles.muted, { color: theme.muted }]}>加载成交…</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  coin: { fontSize: 20, fontWeight: "700" },
  price: { fontSize: 16, fontWeight: "600", fontVariant: ["tabular-nums"] },
  section: { fontSize: 14, fontWeight: "700", marginTop: 18, marginBottom: 6 },
  muted: { fontSize: 13, paddingVertical: 8 },
  cta: { marginTop: 16, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  ctaText: { fontSize: 15, fontWeight: "700" },
});
