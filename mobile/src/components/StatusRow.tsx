import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";

/**
 * Top status bar row: left clock/back, centered title, right status pill.
 * Mirrors the `.sb` block in the design source (build-allscreens.js).
 */
export function StatusRow({
  theme,
  left = "9:41",
  title,
  pill,
}: {
  theme: ThemeTokens;
  left?: React.ReactNode;
  title?: string;
  pill?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      {typeof left === "string" ? (
        <Text style={[styles.side, { color: theme.muted }]}>{left}</Text>
      ) : (
        <View style={styles.sideNode}>{left}</View>
      )}
      {title ? <Text style={[styles.title, { color: theme.text }]}>{title}</Text> : <View />}
      {pill ?? <View />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 6,
  },
  side: { fontSize: 11, letterSpacing: 0.4 },
  sideNode: { flexDirection: "row", alignItems: "center" },
  title: { fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
});
