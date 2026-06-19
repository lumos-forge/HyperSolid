import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { Orderbook } from "../lib/hyperliquid/types";
import type { ThemeTokens } from "../theme/tokens";

export function OrderbookView({ book, theme }: { book: Orderbook; theme: ThemeTokens }) {
  const maxTotal = Math.max(
    book.bids[book.bids.length - 1]?.total ?? 1,
    book.asks[book.asks.length - 1]?.total ?? 1,
    1,
  );
  const rows = (side: "bid" | "ask") => {
    const levels = side === "bid" ? book.bids : book.asks;
    const color = side === "bid" ? theme.up : theme.down;
    return levels.slice(0, 8).map((l, i) => (
      <View key={`${side}-${i}`} style={styles.row}>
        <View style={[styles.depth, { backgroundColor: color, opacity: 0.12, width: `${(l.total / maxTotal) * 100}%` }]} />
        <Text style={[styles.px, { color }]}>{l.px}</Text>
        <Text style={[styles.sz, { color: theme.muted }]}>{l.sz}</Text>
      </View>
    ));
  };
  return (
    <View>
      <View style={styles.head}>
        <Text style={[styles.h, { color: theme.muted }]}>价格</Text>
        <Text style={[styles.h, { color: theme.muted }]}>数量</Text>
      </View>
      {rows("ask")}
      <Text style={[styles.spread, { color: theme.text }]}>
        价差 {book.spread.toFixed(2)} ({book.spreadPct.toFixed(3)}%)
      </Text>
      {rows("bid")}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  h: { fontSize: 10 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2, position: "relative" },
  depth: { position: "absolute", right: 0, top: 0, bottom: 0, borderRadius: 2 },
  px: { fontSize: 12, fontVariant: ["tabular-nums"] },
  sz: { fontSize: 12, fontVariant: ["tabular-nums"] },
  spread: { fontSize: 11, textAlign: "center", paddingVertical: 5 },
});
