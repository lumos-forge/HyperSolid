import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";

export function StatGrid({
  stats,
  theme,
}: {
  stats: { label: string; value: string }[];
  theme: ThemeTokens;
}) {
  return (
    <View style={styles.grid}>
      {stats.map((s) => (
        <View key={s.label} style={styles.cell}>
          <Text style={[styles.label, { color: theme.muted }]}>{s.label}</Text>
          <Text style={[styles.value, { color: theme.text }]}>{s.value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: "33.33%", paddingVertical: 6 },
  label: { fontSize: 10, marginBottom: 2 },
  value: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
