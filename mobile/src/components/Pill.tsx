import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import { withAlpha } from "../theme/color";

export type PillVariant = "brand" | "up" | "down";

/** Capsule status tag (e.g. `◷ TESTNET`, `◉ ARMED`), tinted from a theme token. */
export function Pill({
  theme,
  label,
  variant = "brand",
}: {
  theme: ThemeTokens;
  label: string;
  variant?: PillVariant;
}) {
  const color = variant === "up" ? theme.up : variant === "down" ? theme.down : theme.brand;
  return (
    <View style={[styles.pill, { backgroundColor: withAlpha(color, 0.12) }]}>
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: "flex-start" },
  label: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
});
