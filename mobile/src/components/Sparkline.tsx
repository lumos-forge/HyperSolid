import React from "react";
import { View, StyleSheet } from "react-native";
import type { Candle } from "../lib/hyperliquid/types";
import type { ThemeTokens } from "../theme/tokens";

/** Lightweight close-price sparkline using flex-height bars (no chart dependency). */
export function Sparkline({
  candles,
  theme,
  height = 120,
}: {
  candles: Candle[];
  theme: ThemeTokens;
  height?: number;
}) {
  if (candles.length === 0) return <View style={{ height }} />;
  const closes = candles.map((c) => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const up = closes[closes.length - 1] >= closes[0];
  return (
    <View style={[styles.row, { height }]} testID="sparkline">
      {candles.map((c, i) => {
        const h = ((c.close - min) / range) * (height - 8) + 4;
        return (
          <View key={i} style={styles.col}>
            <View style={{ width: "70%", height: h, backgroundColor: up ? theme.up : theme.down, opacity: 0.7, borderRadius: 1 }} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end" },
  col: { flex: 1, alignItems: "center", justifyContent: "flex-end" },
});
