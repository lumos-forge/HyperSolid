import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import type { PeriodReturn } from "../lib/hyperliquid/performance";
import { fonts } from "../theme/fonts";

/** Compact multi-period return row (24H/7D/30D/…), ▲▼ + signed percent, — when history is short. */
export function MultiPeriodReturns({ theme, data }: { theme: ThemeTokens; data: PeriodReturn[] }) {
  return (
    <View style={styles.row}>
      {data.map(({ label, pct }) => {
        const up = (pct ?? 0) >= 0;
        const color = pct === null ? theme.faint : up ? theme.up : theme.down;
        const text = pct === null ? "—" : `${up ? "▲ " : "▼ "}${Math.abs(pct).toFixed(2)}%`;
        return (
          <View key={label} style={styles.cell}>
            <Text style={[styles.label, { color: theme.faint }]}>{label}</Text>
            <Text style={[styles.value, { color }]}>{text}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 14 },
  cell: { alignItems: "center", flex: 1 },
  label: { fontFamily: fonts.body.regular, fontSize: 10, marginBottom: 3 },
  value: { fontFamily: fonts.mono.bold, fontSize: 11, fontVariant: ["tabular-nums"] },
});
