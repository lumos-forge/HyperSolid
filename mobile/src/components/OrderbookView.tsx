import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { Orderbook } from "../lib/hyperliquid/types";
import type { ThemeTokens } from "../theme/tokens";
import { useT } from "../i18n/useT";

export function OrderbookView({ book, theme, coin }: { book: Orderbook; theme: ThemeTokens; coin?: string }) {
  const t = useT();
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
        <Text style={[styles.cell, styles.price, { color }]}>{l.px}</Text>
        <Text style={[styles.cell, styles.num, { color: theme.text }]}>{l.sz}</Text>
        <Text style={[styles.cell, styles.num, { color: theme.muted }]}>{l.total}</Text>
      </View>
    ));
  };
  return (
    <View>
      <View style={styles.head}>
        <Text style={[styles.h, styles.price, { color: theme.muted }]}>{t("orderbook.price")}</Text>
        <Text style={[styles.h, styles.num, { color: theme.muted }]}>
          {coin ? `${t("orderbook.size")} (${coin})` : t("orderbook.size")}
        </Text>
        <Text style={[styles.h, styles.num, { color: theme.muted }]}>{t("orderbook.sum")}</Text>
      </View>
      {rows("ask")}
      <Text style={[styles.spread, { color: theme.text }]}>
        {t("orderbook.spread", { spread: book.spread.toFixed(2), pct: book.spreadPct.toFixed(3) })}
      </Text>
      {rows("bid")}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", paddingVertical: 4 },
  h: { fontSize: 10 },
  row: { flexDirection: "row", paddingVertical: 2, position: "relative" },
  depth: { position: "absolute", right: 0, top: 0, bottom: 0, borderRadius: 2 },
  cell: { flex: 1, fontSize: 12, fontVariant: ["tabular-nums"] },
  price: { flex: 1, textAlign: "left" },
  num: { flex: 1, textAlign: "right" },
  spread: { fontSize: 11, textAlign: "center", paddingVertical: 5 },
});
