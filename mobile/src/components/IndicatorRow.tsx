import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";

/**
 * v8 indicator selector row (`.inds`/`.ind`/`.indsep`): plain monospace text labels — NOT bordered
 * pills — dim when inactive, brand+bold when active, with a thin vertical divider between the chart
 * overlays (MA/EMA/BOLL/SAR) and the oscillators (VOL/MACD/KDJ/RSI), and a bottom rule under the row.
 */
export function IndicatorRow<T extends string>({
  theme,
  items,
  active,
  onSelect,
  separatorAfter,
}: {
  theme: ThemeTokens;
  items: readonly T[];
  active: T;
  onSelect: (v: T) => void;
  /** Insert the vertical divider after this many items (e.g. 4 → between SAR and VOL). */
  separatorAfter?: number;
}) {
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]}>
      {items.map((item, i) => (
        <React.Fragment key={item}>
          {separatorAfter !== undefined && i === separatorAfter ? (
            <View style={[styles.sep, { backgroundColor: theme.lineStrong }]} />
          ) : null}
          <Pressable onPress={() => onSelect(item)} accessibilityRole="button" accessibilityState={{ selected: active === item }}>
            <Text
              style={[
                styles.label,
                { color: active === item ? theme.brand : theme.muted, fontFamily: active === item ? fonts.mono.bold : fonts.mono.medium },
              ]}
            >
              {item}
            </Text>
          </Pressable>
        </React.Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 10, paddingBottom: 9, borderBottomWidth: 1, overflow: "hidden" },
  sep: { width: 1, height: 12 },
  label: { fontSize: 11.5, letterSpacing: 0.2 },
});
