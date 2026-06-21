import React from "react";
import { Text, StyleSheet, type StyleProp, type TextStyle } from "react-native";
import type { ThemeTokens } from "../theme/tokens";

/** Letter-spaced small section header (e.g. `盘口 ORDERBOOK`, `STRATEGIES`). */
export function SectionLabel({
  theme,
  children,
  style,
}: {
  theme: ThemeTokens;
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  return <Text style={[styles.label, { color: theme.muted }, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  label: { fontSize: 11, fontWeight: "600", letterSpacing: 1.5, marginVertical: 8 },
});
