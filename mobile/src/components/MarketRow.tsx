import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { MarketTicker } from "../lib/hyperliquid/types";
import type { ThemeTokens } from "../theme/tokens";
import { PriceText, formatPct } from "./PriceText";

export function MarketRow({ ticker, theme }: { ticker: MarketTicker; theme: ThemeTokens }) {
  const dirColor = ticker.changePct >= 0 ? theme.up : theme.down;
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]}>
      <View>
        <Text style={[styles.coin, { color: theme.text }]}>{ticker.coin}</Text>
        <Text style={[styles.sub, { color: theme.muted }]}>
          {`funding ${(ticker.funding * 100).toFixed(3)}%`}
        </Text>
      </View>
      <View style={styles.right}>
        <PriceText value={ticker.midPx} color={theme.text} />
        <Text style={[styles.chg, { color: dirColor }]}>{formatPct(ticker.changePct)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 13,
    borderBottomWidth: 1,
  },
  coin: { fontSize: 16, fontWeight: "700" },
  sub: { fontSize: 11, marginTop: 3 },
  right: { alignItems: "flex-end" },
  chg: { fontSize: 12, marginTop: 3, fontVariant: ["tabular-nums"] },
});
