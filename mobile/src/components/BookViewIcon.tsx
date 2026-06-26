import React from "react";
import { View, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";

export type BookView = "balanced" | "asks" | "bids";

/**
 * The HL order-book display-mode glyph: a red (asks) block stacked on a green (bids) block beside a
 * grey bar. The two blocks grow/shrink and dim to reflect the current emphasis (balanced / asks /
 * bids).
 */
export function BookViewIcon({ theme, mode, size = 18 }: { theme: ThemeTokens; mode: BookView; size?: number }) {
  // Single-side modes hide the other block (flex 0); balanced shows both equally.
  const askFlex = mode === "bids" ? 0 : 1;
  const bidFlex = mode === "asks" ? 0 : 1;
  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <View style={styles.left}>
        <View style={[styles.block, { flex: askFlex, backgroundColor: theme.down }]} />
        <View style={[styles.block, { flex: bidFlex, backgroundColor: theme.up }]} />
      </View>
      <View style={[styles.bar, { backgroundColor: theme.muted }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", gap: 2.5, alignItems: "stretch" },
  left: { flex: 1, gap: 2 },
  block: { borderRadius: 2 },
  bar: { width: 4, borderRadius: 2 },
});
