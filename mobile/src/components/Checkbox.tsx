import React from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
import type { ThemeTokens } from "../theme/tokens";
import { fonts } from "../theme/fonts";
import { Icon } from "./Icon";

/**
 * Hyperliquid-style checkbox: a small square on the left (checkmark when on) with the label to its
 * right — used for the order-ticket Reduce-only / TP/SL options. `accessibilityLabel` doubles as the
 * test handle.
 */
export function Checkbox({
  theme,
  value,
  onValueChange,
  label,
  accessibilityLabel,
  testID,
}: {
  theme: ThemeTokens;
  value: boolean;
  onValueChange?: (next: boolean) => void;
  label: string;
  accessibilityLabel?: string;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      hitSlop={6}
      onPress={() => onValueChange?.(!value)}
      style={styles.row}
    >
      <View
        style={[
          styles.box,
          {
            borderColor: value ? theme.brand : theme.lineStrong,
            backgroundColor: value ? theme.brand : "transparent",
          },
        ]}
      >
        {value ? <Icon name="check" color={theme.bg} size={13} strokeWidth={2.6} /> : null}
      </View>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  box: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, alignItems: "center", justifyContent: "center", marginRight: 8 },
  label: { fontFamily: fonts.body.medium, fontSize: 13 },
});
