import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { Trade } from "../lib/hyperliquid/types";
import type { ThemeTokens } from "../theme/tokens";
import { formatTimeHMS } from "../lib/hyperliquid/format";

export function TradesList({ trades, theme }: { trades: Trade[]; theme: ThemeTokens }) {
  return (
    <View>
      {trades.slice(0, 20).map((t) => (
        <View key={t.tid} style={styles.row}>
          <Text style={[styles.px, { color: t.side === "buy" ? theme.up : theme.down }]}>{t.px}</Text>
          <Text style={[styles.sz, { color: theme.text }]}>{t.sz}</Text>
          <Text style={[styles.time, { color: theme.muted }]}>{formatTimeHMS(t.time)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  px: { fontSize: 12, fontVariant: ["tabular-nums"], flex: 1 },
  sz: { fontSize: 12, fontVariant: ["tabular-nums"], flex: 1, textAlign: "center" },
  time: { fontSize: 11, fontVariant: ["tabular-nums"], flex: 1, textAlign: "right" },
});
