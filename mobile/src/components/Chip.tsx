import React from "react";
import { Pressable, Text, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";

/** Small pill used for timeframe/filter selection (1H/4H/1D/1W). */
export function Chip({
  theme,
  label,
  active = false,
  onPress,
}: {
  theme: ThemeTokens;
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[
        styles.chip,
        { borderColor: active ? theme.brand : theme.line, backgroundColor: active ? theme.brand : "transparent" },
      ]}
    >
      <Text style={[styles.label, { color: active ? theme.bg : theme.muted, fontWeight: active ? "700" : "400" }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  label: { fontSize: 11 },
});
